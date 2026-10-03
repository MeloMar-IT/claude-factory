import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { Monitor, logRing } from "../src/monitor/monitor.js";
import { loadFindings } from "../src/monitor/findings.js";
import type { DetectorInput } from "../src/monitor/detectors.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { WatcherManager } from "../src/queue/watchers.js";
import { fakeGithub } from "./helpers/fake-github.js";

const MIN = 60_000;
const SEC = 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("monitor", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let runsDir: string;
  let file: string;
  let scheduler: Scheduler;
  let lines: string[];
  const config = ConfigSchema.parse({});
  const mcfg = (over: Record<string, unknown> = {}) => WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m", ...over });

  beforeEach(() => {
    gh = fakeGithub();
    runsDir = join(gh.tmp, "runs");
    file = join(gh.tmp, "monitor-findings.json");
    lines = [];
    scheduler = new Scheduler({ runsDir, config: () => config });
  });
  afterEach(() => gh.restore());

  let n = 0;
  const makeRun = (over: Partial<RunSummary> = {}): RunSummary => {
    const runId = `20261001-12${String(Math.floor(++n / 100)).padStart(2, "0")}${String(n % 100).padStart(2, "0")}-abcd`;
    const s = {
      runId, flow: "issue-gitflow", task: "t", status: "failed", startedAt: ago(10 * MIN), finishedAt: ago(5 * MIN), vars: { github_repo: "acme/app" },
      history: [{ id: "build", type: "shell", visit: 1, ok: false, output: "", error: "output did not match pass_if /ok/", startedAt: ago(MIN), durationMs: 1, logFile: "x" }],
      reason: 'step "build" failed: output did not match pass_if /ok/', totalCostUsd: 0, state: { next: null, steps: {}, visits: {} }, runDir: join(runsDir, runId), ...over,
    } as unknown as RunSummary;
    mkdirSync(s.runDir, { recursive: true });
    saveRun(s);
    return s;
  };
  const loop = (over: Partial<RunSummary> = {}) =>
    makeRun({ status: "stopped", reason: 'stopped at step "wait_for_area"', resumeLog: Array.from({ length: 24 }, (_, i) => ({ at: ago((23 - i) * 25 * SEC), from: "claim_areas" })), ...over });
  const monitor = (over: Partial<ConstructorParameters<typeof Monitor>[1]> = {}, cfg = mcfg()) =>
    new Monitor(cfg, { scheduler, watchers: () => [], thresholds: () => config.monitor, log: (m) => lines.push(m), file, ...over });

  it("finds the restart loop and keeps the finding over a restart (the second check counts 2)", async () => {
    loop();
    await monitor().tick();
    const first = loadFindings(file).findings;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ fingerprint: "restart-loop|issue-gitflow|claim_areas", severity: "critical", count: 1 });
    expect(lines.some((l) => l.startsWith("[mon] new finding (critical) restart-loop:"))).toBe(true);
    await monitor().tick(); // a new instance, as after a restart
    expect(loadFindings(file).findings[0]).toMatchObject({ count: 2, firstSeen: first[0]!.firstSeen });
  });

  it("finds a limit hit from a run's files even with an empty log", async () => {
    makeRun({ history: [{ id: "x", type: "shell", visit: 1, ok: false, output: "API rate limit exceeded", error: "exit code 1", startedAt: ago(MIN), durationMs: 1, logFile: "x" }] as never });
    await monitor({ serverLog: () => [] }).tick();
    expect(loadFindings(file).findings.map((f) => f.fingerprint)).toContain("github-limit|core");
  });

  it("shares one check between two calls at once", async () => {
    loop();
    const m = monitor();
    const a = m.tick();
    const b = m.tick();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(loadFindings(file).findings[0]!.count).toBe(1);
  });

  it("checks 1,000 failed runs in a few seconds without blocking the server", async () => {
    for (let i = 0; i < 1000; i++) makeRun();
    let spins = 0;
    let stopped = false;
    const spin = () => setImmediate(() => { spins++; if (!stopped) spin(); });
    spin();
    const t0 = Date.now();
    const m = monitor();
    await m.tick();
    stopped = true;
    expect(m.status.lastError).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(spins).toBeGreaterThanOrEqual(10);
    expect(loadFindings(file).findings.map((f) => f.detector)).toEqual(["unexplained-failure"]);
  }, 30_000);

  it("still loads an old run that was just resumed when there are more than 1,000 candidates", async () => {
    const old = new Date(Date.now() - 3600_000);
    for (let i = 0; i < 1010; i++) {
      const s = makeRun();
      utimesSync(join(s.runDir, "run.json"), old, old); // not touched lately
    }
    loop({ finishedAt: ago(48 * 3600_000), startedAt: ago(48 * 3600_000) });
    await monitor().tick();
    expect(loadFindings(file).findings.map((f) => f.detector)).toContain("restart-loop");
  }, 60_000);

  it("changes nothing of the runs and calls no gh", async () => {
    loop();
    makeRun();
    const snap = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
        }
      };
      walk(runsDir);
      return out;
    };
    const before = snap();
    const log0 = gh.ghLog();
    await monitor().tick();
    expect(snap()).toEqual(before);
    expect(gh.ghLog()).toBe(log0);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(gh.tmp).filter((f) => f.startsWith("monitor-findings"))).toEqual(["monitor-findings.json"]);
  });

  it("a crashing collect is the monitor's error; the next good check clears it", async () => {
    let fail = true;
    const m = monitor({ scheduler: { ...scheduler, briefs: () => { if (fail) throw new Error("disk is gone"); return []; }, get: () => undefined, queue: scheduler.queue.bind(scheduler) } as never });
    await m.tick();
    await m.tick();
    expect(m.status).toMatchObject({ lastError: "disk is gone", errorCount: 2 });
    expect(m.status.errorSince).toBeDefined();
    fail = false;
    await m.tick();
    expect(m.status).toMatchObject({ lastError: undefined, errorCount: undefined, errorSince: undefined });
    expect(m.status.lastOk).toBeDefined();
  });

  it("reports a broken findings file and goes on", async () => {
    writeFileSync(file, "{broken");
    const m = monitor();
    await m.tick();
    expect(m.status.lastError).toBeUndefined();
    expect(m.status.lastActions.some((a) => a.includes("monitor-findings.json.broken"))).toBe(true);
    expect(readFileSync(`${file}.broken`, "utf8")).toBe("{broken");
  });

  it("a detector that crashes does not stop the check", async () => {
    const m = monitor({ detectors: [{ name: "bad", run: () => { throw new Error("x"); } }] });
    await m.tick();
    expect(loadFindings(file).findings.map((f) => f.fingerprint)).toEqual(["detector-failed|bad"]);
  });

  it("passes asleep when a check starts long after the last one", async () => {
    let now = new Date("2026-10-01T12:00:00Z");
    const seen: boolean[] = [];
    const m = monitor({ now: () => now, detectors: [{ name: "spy", run: (i: DetectorInput) => (seen.push(i.asleep), []) }] });
    await m.tick();
    now = new Date(now.getTime() + 5 * MIN + 2 * MIN);
    await m.tick();
    now = new Date(now.getTime() + 5 * MIN);
    await m.tick();
    now = new Date(now.getTime() + 60 * MIN);
    await m.tick(true); // a manual check is never "after a sleep"
    expect(seen).toEqual([false, true, false, false]);
  });
});

describe("logRing", () => {
  it("keeps a limit line when 2,500 other lines follow, and only the newest 2,000 others", () => {
    const ring = logRing();
    ring.push("API rate limit exceeded");
    for (let i = 0; i < 2500; i++) ring.push(`line ${i}`);
    const texts = ring.lines().map((l) => l.text);
    expect(texts[0]).toBe("API rate limit exceeded");
    expect(texts).toContain("line 2499");
    expect(texts).not.toContain("line 0");
    expect(texts.filter((t) => t.startsWith("line "))).toHaveLength(2000);
  });
});

describe("the monitor in the WatcherManager", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let manager: WatcherManager | undefined;
  let cfg = ConfigSchema.parse({});
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => {
    manager?.stopAll();
    manager = undefined;
    gh.restore();
  });

  const watcher = (id: string) => ({ id, github_repo: "acme/app", flow: "issue-gitflow", every: "1h" });
  const mon = { id: "mon", source: "monitor", every: "1h" };
  const setup = (watchers: unknown[], monitor: unknown = {}) => {
    cfg = ConfigSchema.parse({ watchers, monitor });
    const scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => cfg });
    manager = new WatcherManager({ scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, config: () => cfg, log: () => {} });
    manager.sync();
    return manager;
  };
  const rateCalls = () => gh.ghLog().split("\n").filter((l) => l === "gh api rate_limit").length;
  const settled = async (m: WatcherManager, ids: string[]) => {
    for (let i = 0; i < 200; i++) {
      const done = ids.every((id) => m.statuses().find((s) => s.id === id)?.status?.lastTick);
      if (done) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
  };

  it("starts no Watcher for it; its status is listed; Check now runs a check; stopAll stops it", async () => {
    const m = setup([mon]);
    await settled(m, ["mon"]);
    expect(gh.ghLog()).not.toContain("repo view");
    expect(m.tracked()).toEqual([]);
    expect(m.statuses()[0]!.status).toMatchObject({ id: "mon" });
    const before = m.statuses()[0]!.status!.lastTick;
    await new Promise((r) => setTimeout(r, 20));
    const status = await m.runNow("mon");
    expect(status.lastTick).not.toBe(before);
    m.stopAll();
    expect(m.statuses()[0]!.status).toBeUndefined();
    await expect(m.runNow("mon")).rejects.toThrow(/not running/);
  });

  it("stops when it is disabled", async () => {
    const m = setup([mon]);
    await settled(m, ["mon"]);
    cfg = ConfigSchema.parse({ watchers: [{ ...mon, enabled: false }] });
    m.sync();
    expect(m.statuses()[0]!.status).toBeUndefined();
  });

  it("reads the request limit once after a watcher's check, and not again within a minute", async () => {
    const m = setup([watcher("w"), mon]);
    await settled(m, ["w", "mon"]);
    expect(rateCalls()).toBe(1);
    await m.runNow("w");
    expect(rateCalls()).toBe(1);
  });

  it("a monitor alone still reads the request limit, and the detectors see the reading", async () => {
    process.env.FAKE_GH_RATE_LIMIT = JSON.stringify({ resources: { core: { limit: 5000, used: 4500, remaining: 500, reset: Math.floor(Date.now() / 1000) + 1800 } } });
    const m = setup([mon]);
    await settled(m, ["mon"]);
    expect(rateCalls()).toBe(1);
    const found = loadFindings(join(process.env.FACTORY_HOME!, "monitor-findings.json")).findings;
    expect(found.map((f) => f.fingerprint)).toContain("github-limit|core");
  });

  it("two watchers whose checks end together make one call", async () => {
    const m = setup([watcher("a"), watcher("b"), mon]);
    await settled(m, ["a", "b", "mon"]);
    expect(rateCalls()).toBe(1);
  });

  it("a failing call leaves the check unaffected and is not repeated within a minute", async () => {
    process.env.FAKE_GH_FAIL = "api rate_limit";
    const m = setup([watcher("w"), mon]);
    await settled(m, ["w", "mon"]);
    await m.runNow("w");
    expect(rateCalls()).toBe(1);
    expect(m.statuses().find((s) => s.id === "w")?.status?.lastError ?? "").not.toMatch(/rate_limit/);
  });

  it("makes no call without a monitor", async () => {
    const m = setup([watcher("w")]);
    await settled(m, ["w"]);
    await m.runNow("w");
    expect(rateCalls()).toBe(0);
  });

  describe("bug stories", () => {
    const findingsPath = () => join(process.env.FACTORY_HOME!, "monitor-findings.json");
    const storyCalls = () => gh.ghLog().split("\n").filter((l) => /^gh (api repos|label create|issue comment)/.test(l));
    beforeEach(() => rmSync(findingsPath(), { force: true }));
    afterEach(() => rmSync(findingsPath(), { force: true }));

    it("a monitor with report_to and an issue watcher make one story with the watcher's label from two checks", async () => {
      const runDir = join(gh.tmp, "runs", "20261001-120000-abcd");
      mkdirSync(runDir, { recursive: true });
      const now = Date.now();
      saveRun({
        runId: "20261001-120000-abcd", flow: "issue-gitflow", task: "t", status: "stopped", reason: 'stopped at step "wait_for_area"', startedAt: new Date(now - 60_000).toISOString(),
        vars: { github_repo: "acme/app" }, history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} }, runDir,
        resumeLog: Array.from({ length: 24 }, (_, i) => ({ at: new Date(now - (23 - i) * 5_000).toISOString(), from: "claim_areas" })),
      } as unknown as RunSummary);
      const m = setup([{ ...watcher("w"), label: "go" }, mon], { report_to: "acme/app" });
      await settled(m, ["w", "mon"]);
      await m.runNow("mon");
      await m.runNow("mon");
      const made = gh.createdBodies();
      expect(made).toHaveLength(1);
      expect(made[0]!.labels).toEqual(["bug", "go"]);
      expect(m.statuses().find((s) => s.id === "mon")!.status).toHaveProperty("lastActions");
    });

    it("one check with three owed stories makes at most 6 story calls and 2 reads of the request limit; the status shows its notes", async () => {
      const iso = new Date().toISOString();
      const owed = ["a", "b", "c"].map((id) => ({
        detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", evidence: { counts: { runs: 2 } }, about: "foundry",
        firstSeen: iso, lastSeen: iso, count: 2, gone: false, due: iso,
      }));
      mkdirSync(process.env.FACTORY_HOME!, { recursive: true });
      writeFileSync(findingsPath(), JSON.stringify({ version: 1, findings: owed }));
      const m = setup([mon], { report_to: "acme/app", report_limits: { per_day: 10, per_check: 3 } });
      await settled(m, ["mon"]);
      expect(gh.createdBodies()).toHaveLength(3);
      expect(storyCalls().length).toBeLessThanOrEqual(6);
      expect(rateCalls()).toBeLessThanOrEqual(2);
      expect(m.statuses()[0]!.status?.notes?.join(" ")).toContain("No watcher builds bug stories");
    });
  });
});
