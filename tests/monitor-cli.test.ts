import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { FindingInput } from "../src/monitor/findings.js";
import { MAX_LOG_BYTES, storiesVerdict } from "../src/monitor/guard.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub } from "./helpers/fake-github.js";

const CLI = resolve("dist/cli.js");
let home: string;
let saved: string | undefined;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing — run \`npm run build\` first`);
});
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "monitor-cli-"));
  process.env.FACTORY_HOME = home; // the in-process monitor reads the same folder as the commands
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const env = () => {
  const e: NodeJS.ProcessEnv = { ...process.env, SCF_HOME: home };
  delete e.FACTORY_HOME;
  return e;
};
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: env(), encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const runAsync = (...args: string[]) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const c = spawn(process.execPath, [CLI, ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.resume();
    c.on("close", (code) => done({ code, out }));
  });
const state = () => JSON.parse(readFileSync(join(home, "monitor-guard.json"), "utf8")) as { version: number; off?: { since: string; by: string }; extra?: number };
const lines = (f = "monitor-log.jsonl") => (existsSync(join(home, f)) ? readFileSync(join(home, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; by?: string }) : []);

describe("scf monitor", () => {
  it("status on a fresh folder prints on", () => {
    expect(run("monitor", "status")).toMatchObject({ code: 0, out: "bug stories: on\n" });
  });

  it("status lists the mutes in force, the finding by its hash, and leaves out an expired one", () => {
    const base = { since: "2026-10-01T10:00:00.000Z", by: "cli", reason: "noise" };
    writeFileSync(join(home, "monitor-guard.json"), JSON.stringify({ version: 1, mutes: [
      { ...base, id: "0000000000000001", kind: "detector", detector: "slow-step" },
      { ...base, id: "0000000000000002", kind: "finding", detector: "restart-loop", fingerprint: "restart-loop|secret", until: "2999-01-01T00:00:00.000Z" },
      { ...base, id: "0000000000000003", kind: "detector", detector: "stuck-run", until: "2026-10-01T11:00:00.000Z" },
    ] }));
    const s = run("monitor", "status");
    expect(s.code).toBe(0);
    const out = s.out.split("\n");
    expect(out[0]).toBe("bug stories: on");
    expect(out[1]).toBe("mutes: 2");
    expect(out[2]).toBe("  detector slow-step: noise (since 2026-10-01T10:00:00.000Z, for good, by cli)");
    expect(out[3]).toMatch(/^ {2}finding [0-9a-f]{16} of restart-loop: noise/);
    expect(s.out).not.toContain("secret");
    expect(s.out).not.toContain("stuck-run");
  });

  it("off writes by cli, a second off says already off, status shows it, on switches back", () => {
    expect(run("monitor", "off")).toMatchObject({ code: 0, out: "bug stories are off\n" });
    expect(state().off?.by).toBe("cli");
    expect(run("monitor", "off").out).toContain("bug stories are already off since ");
    expect(run("monitor", "status").out).toMatch(/^bug stories: off since \S+ \(by cli\)$/m);
    expect(run("monitor", "on").out).toBe("bug stories are on\n");
    expect(run("monitor", "on").out).toBe("bug stories are already on\n");
    expect(run("monitor", "status").out).toBe("bug stories: on\n");
    expect(lines().map((l) => [l.event, l.by])).toEqual([["off", "cli"], ["on", "cli"]]);
  });

  it("status prints the circuit breaker, and on closes it", () => {
    writeFileSync(join(home, "monitor-guard.json"), JSON.stringify({ version: 1, breaker: { open: { since: "2026-10-01T10:00:00.000Z", reason: "failed_fixes", count: 3 } } }));
    const s = run("monitor", "status");
    expect(s.code).toBe(0);
    expect(s.out).toBe("bug stories: stopped by the circuit breaker since 2026-10-01T10:00:00.000Z (the newest 3 runs of bug stories all failed); scf monitor on switches them on again\n");
    expect(run("monitor", "on").out).toBe("bug stories are on\nthe circuit breaker is closed; the counts start anew\n");
    expect(JSON.parse(readFileSync(join(home, "monitor-guard.json"), "utf8")).breaker.from).toEqual(expect.any(String));
    expect(run("monitor", "status").out).toBe("bug stories: on\n");
    expect(lines().map((l) => l.event)).toEqual(["on", "breaker-closed"]);
  });

  it("no or an unknown sub-command exits 1 with the usage; --help lists it", () => {
    for (const args of [["monitor"], ["monitor", "now"], ["monitor", "off", "extra"]]) {
      const r = run(...args);
      expect(r.code).toBe(1);
      expect(r.err + r.out).toContain("scf monitor off");
    }
    expect(run("--help").out).toContain("scf monitor off|on|status");
  });

  it("works with an invalid config.yaml in the folder", () => {
    writeFileSync(join(home, "config.yaml"), "concurrency: [not, valid\n");
    expect(run("monitor", "off").code).toBe(0);
    expect(run("monitor", "status").code).toBe(0);
  });

  it("a broken file: status exits 1, on exits 0 and keeps the broken file", () => {
    writeFileSync(join(home, "monitor-guard.json"), "{nope");
    const s = run("monitor", "status");
    expect(s.code).toBe(1);
    expect(s.out).toContain("monitor-guard.json cannot be read");
    expect(run("monitor", "off").code).toBe(0);
    expect(readFileSync(join(home, "monitor-guard.json"), "utf8")).toBe("{nope");
    const on = run("monitor", "on");
    expect(on.code).toBe(0);
    expect(on.out).toContain("kept as monitor-guard.json.broken");
    expect(readFileSync(join(home, "monitor-guard.json.broken"), "utf8")).toBe("{nope");
    expect(run("monitor", "status").code).toBe(0);
  });

  describe("seen by a running monitor", () => {
    let gh: ReturnType<typeof fakeGithub>;
    afterEach(() => gh?.restore());

    it("two checks make no story after off; the next check after on makes it", async () => {
      gh = fakeGithub();
      process.env.FACTORY_HOME = home; // fakeGithub may point it elsewhere
      const found: FindingInput[] = [{ detector: "restart-loop", fingerprint: "restart-loop|a", severity: "critical", summary: "s", about: "foundry", evidence: { lines: ["exit code 1"], flows: ["issue-gitflow"], steps: ["claim_areas"] } }];
      const cfg = () => ConfigSchema.parse({ monitor: { report_to: "acme/app" } }).monitor;
      const made: string[] = [];
      const reporter = new Reporter({
        config: cfg, buildLabel: () => "go",
        names: () => ({ target: "acme/app", users: [], emails: [], repos: [], watchers: [], complete: true }),
        builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }),
        guard: () => storiesVerdict(), record: (e) => e.event === "story-made" && made.push(e.fingerprint ?? ""),
      });
      let clock = new Date(2026, 9, 1, 12, 0, 0);
      const monitor = new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
        scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }),
        watchers: () => [], thresholds: cfg, log: () => {}, file: join(gh.tmp, "findings.json"), now: () => clock, reporter, detectors: [{ name: "t", description: "test", run: () => found }],
      });
      const check = async () => {
        clock = new Date(clock.getTime() + 3_600_000);
        await monitor.tick();
      };
      expect(run("monitor", "off").code).toBe(0);
      await check();
      await check();
      expect(made).toEqual([]);
      expect(run("monitor", "on").code).toBe(0);
      await check();
      expect(made).toEqual(["restart-loop|a"]);
    });
  });

  it("many processes at once keep the file, the extra key and one log line per change", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "monitor-guard.json"), JSON.stringify({ version: 1, extra: 7 }));
    const filler = JSON.stringify({ at: new Date().toISOString(), event: "story-skipped", reason: "off", detector: "d", repo: "r", fingerprint: "x".repeat(150) }) + "\n";
    const n = Math.floor((MAX_LOG_BYTES - 6000) / filler.length);
    writeFileSync(join(home, "monitor-log.jsonl"), filler.repeat(n));
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runAsync("monitor", i % 2 ? "on" : "off")));
    const changed = results.filter((r) => /^bug stories are (on|off)\n/.test(r.out)).length;
    const s = state();
    expect(s.version).toBe(1);
    expect(s.extra).toBe(7);
    const switches = [...lines(), ...lines("monitor-log.1.jsonl")].filter((l) => l.event === "on" || l.event === "off");
    expect(switches).toHaveLength(changed);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp") || f === "monitor.lock")).toEqual([]);
    expect(results.every((r) => r.code === 0)).toBe(true);
  });
});
