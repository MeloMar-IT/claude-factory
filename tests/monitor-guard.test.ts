import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { FindingInput } from "../src/monitor/findings.js";
import { loadFindings } from "../src/monitor/findings.js";
import type { Names } from "../src/monitor/clean.js";
import {
  currentState, describeEntry, guardFile, loadGuard, logFile, logLine, lockDir, HARD_LOG_BYTES, MAX_LINE_BYTES, MAX_LOG_BYTES, olderLogFile, saveGuard, storiesState,
  storiesVerdict, switchStories, withMonitorLock, writeLog, type LogEntry, type Verdict,
} from "../src/monitor/guard.js";
import { Monitor } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { markerFor } from "../src/monitor/story.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub } from "./helpers/fake-github.js";

const UUID = "0b6b5e0e-6a2c-4a5e-9d6e-3a2f9c1d7e11";
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 1, 12, 0, 0);
const at = (h: number) => new Date(T0.getTime() + h * HOUR);
const NAMES: Names = { target: "acme/app", users: [], emails: [], repos: [], watchers: [], complete: true };
const TARGET = "acme/app";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "monitor-guard-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});
const logLines = (f = logFile()) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const mode = (p: string) => statSync(p).mode & 0o777;
const leftovers = () => readdirSync(home).filter((n) => n.endsWith(".tmp") || n === "monitor.lock");

describe("the state file", () => {
  it("reads a missing file as on", () => {
    expect(loadGuard()).toEqual({ ok: true, data: { version: 1 } });
    expect(currentState()).toEqual({ state: "on" });
  });

  it("saves and loads the same data, with no temporary file, mode 0600", () => {
    saveGuard({ version: 1, off: { since: at(0).toISOString(), by: "cli" } });
    expect(loadGuard()).toEqual({ ok: true, data: { version: 1, off: { since: at(0).toISOString(), by: "cli" } } });
    expect(leftovers()).toEqual([]);
    expect(mode(guardFile())).toBe(0o600);
  });

  it("keeps unknown keys over off and on, and keeps the first `since` of a second off", () => {
    saveGuard({ version: 1, breaker: { open: false } });
    expect(switchStories("off", "cli", { now: at(0) })).toMatchObject({ changed: true, state: "off" });
    expect(switchStories("off", UUID, { now: at(1) })).toEqual({ changed: false, state: "off", since: at(0).toISOString() });
    expect(switchStories("on", UUID)).toMatchObject({ changed: true, state: "on" });
    expect(loadGuard()).toEqual({ ok: true, data: { version: 1, breaker: { open: false } } });
    expect(switchStories("on", UUID)).toEqual({ changed: false, state: "on" });
  });

  it("refuses a `by` that is not cli or an account id", () => {
    expect(() => switchStories("off", "ann@example.com")).toThrow();
    expect(() => switchStories("off", "Ann")).toThrow();
    expect(existsSync(guardFile())).toBe(false);
  });
});

describe("a state file that cannot be read", () => {
  const breakIt: Record<string, () => void> = {
    "not JSON": () => writeFileSync(guardFile(), "{nope"),
    "version 2": () => writeFileSync(guardFile(), JSON.stringify({ version: 2 })),
    "off is a number": () => writeFileSync(guardFile(), JSON.stringify({ version: 1, off: 5 })),
    "a folder": () => mkdirSync(guardFile()),
    "a dangling link": () => symlinkSync(join(home, "nowhere"), guardFile()),
  };
  for (const [name, make] of Object.entries(breakIt)) {
    it(`${name}: unreadable, not renamed by reading, off changes nothing, on starts fresh`, () => {
      make();
      expect(loadGuard()).toEqual({ ok: false });
      expect(currentState()).toEqual({ state: "unreadable" });
      expect(existsSync(`${guardFile()}.broken`)).toBe(false);
      expect(switchStories("off", "cli")).toEqual({ changed: false, state: "unreadable" });
      expect(existsSync(`${guardFile()}.broken`)).toBe(false);
      const r = switchStories("on", "cli", { now: at(0) });
      expect(r).toMatchObject({ changed: true, state: "on", reset: at(0).toISOString() });
      expect(lstatSync(`${guardFile()}.broken`)).toBeDefined();
      expect(loadGuard()).toEqual({ ok: true, data: { version: 1, reset: at(0).toISOString() } });
      expect(logLines()).toMatchObject([{ event: "on", by: "cli", reset: true }]);
      expect(leftovers()).toEqual([]);
      expect(switchStories("off", "cli", { now: at(1) })).toMatchObject({ changed: true });
      expect(loadGuard()).toMatchObject({ ok: true, data: { off: { by: "cli" } } });
      expect((loadGuard() as { data: { reset?: string } }).data.reset).toBeUndefined();
    });
  }

  it("keeps the bytes of the broken file, and older backups as .broken.1, .broken.2", () => {
    for (const n of [1, 2, 3]) {
      writeFileSync(guardFile(), `broken ${n}`);
      switchStories("on", "cli");
    }
    expect(readFileSync(`${guardFile()}.broken`, "utf8")).toBe("broken 3");
    expect(readFileSync(`${guardFile()}.broken.1`, "utf8")).toBe("broken 2");
    expect(readFileSync(`${guardFile()}.broken.2`, "utf8")).toBe("broken 1");
  });

  it("puts the broken file back when the last step fails, and writes no log line", () => {
    writeFileSync(guardFile(), "broken");
    let n = 0;
    const rename = ((a: string, b: string) => {
      if (++n === 2) throw new Error("disk");
      return renameSync(a, b);
    }) as typeof renameSync;
    expect(() => switchStories("on", "cli", { rename })).toThrow("disk");
    expect(readFileSync(guardFile(), "utf8")).toBe("broken");
    expect(existsSync(`${guardFile()}.broken`)).toBe(false);
    expect(currentState()).toEqual({ state: "unreadable" });
    expect(leftovers()).toEqual([]);
    expect(logLines()).toEqual([]);
  });

  it("moves nothing when the first move fails", () => {
    writeFileSync(guardFile(), "broken");
    const rename = (() => {
      throw new Error("disk");
    }) as unknown as typeof renameSync;
    expect(() => switchStories("on", "cli", { rename })).toThrow("disk");
    expect(readFileSync(guardFile(), "utf8")).toBe("broken");
    expect(leftovers()).toEqual([]);
  });
});

describe("monitor.lock", () => {
  const hold = () => {
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(join(lockDir(), "pid"), String(process.ppid));
  };

  it("a live holder: on throws and changes nothing", () => {
    switchStories("off", "cli");
    hold();
    expect(() => switchStories("on", "cli", { waitMs: 50 })).toThrow(/monitor\.lock/);
    expect(currentState().state).toBe("off");
    expect(existsSync(lockDir())).toBe(true);
  });

  it("off takes the lock over from a stuck holder, switches off, and releases it", () => {
    hold();
    expect(switchStories("off", "cli", { waitMs: 50 })).toMatchObject({ changed: true });
    expect(currentState().state).toBe("off");
    expect(existsSync(lockDir())).toBe(false);
  });

  it("an off while an on is paused between its read and its write stays off", () => {
    saveGuard({ version: 1, off: { since: at(0).toISOString(), by: "cli" } });
    expect(() =>
      switchStories("on", UUID, {
        beforeWrite: () => {
          // the paused "on" has read the old state; the admin's "off" takes the lock over and writes
          saveGuard({ version: 1 });
          expect(switchStories("off", "cli", { waitMs: 20 })).toMatchObject({ changed: true, state: "off" });
        },
      }),
    ).toThrow(/taken over/);
    expect(currentState().state).toBe("off");
    expect(existsSync(lockDir())).toBe(false);
  });

  it("takes over the lock of a dead process, and is gone after a switch, also one that threw", () => {
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "pid"), "999999999");
    expect(switchStories("off", "cli", { waitMs: 50 })).toMatchObject({ changed: true });
    expect(existsSync(lockDir())).toBe(false);
    expect(() => withMonitorLock(() => { throw new Error("x"); })).toThrow("x");
    expect(existsSync(lockDir())).toBe(false);
  });
});

describe("storiesState", () => {
  const started = at(0);
  it("is quiet until startedAt + 10 minutes, on at exactly the end", () => {
    const ok = loadGuard();
    expect(storiesState(ok, { startedAt: started, cooldownMinutes: 10, now: new Date(started.getTime() + 10 * MIN - 1) })).toEqual({ state: "quiet", until: new Date(started.getTime() + 10 * MIN).toISOString() });
    expect(storiesState(ok, { startedAt: started, cooldownMinutes: 10, now: new Date(started.getTime() + 10 * MIN) })).toEqual({ state: "on" });
  });
  it("is on with no cool-down or no start", () => {
    expect(storiesState(loadGuard(), { startedAt: started, cooldownMinutes: 0, now: started })).toEqual({ state: "on" });
    expect(storiesState(loadGuard(), { cooldownMinutes: 10, now: started })).toEqual({ state: "on" });
  });
  it("off wins over quiet, unreadable wins over off", () => {
    const off = { ok: true as const, data: { version: 1, off: { since: at(0).toISOString(), by: "cli" } } };
    expect(storiesState(off, { startedAt: started, cooldownMinutes: 10, now: started }).state).toBe("off");
    expect(storiesState({ ok: false }, { startedAt: started, cooldownMinutes: 10, now: started }).state).toBe("unreadable");
  });
  it("the verdict reads the file at each call", () => {
    expect(storiesVerdict()).toEqual({ go: true });
    switchStories("off", "cli");
    expect(storiesVerdict()).toMatchObject({ go: false, reason: "off" });
  });
});

describe("the log", () => {
  it("each line parses and has `at`", () => {
    writeLog({ event: "story-made", detector: "d", fingerprint: "f", repo: "a/b", issue: 4 });
    expect(logLines()).toMatchObject([{ event: "story-made", issue: 4 }]);
    expect(typeof logLines()[0]!.at).toBe("string");
  });

  it("a huge fingerprint with quotes and control characters stays under the line limit", () => {
    const e: LogEntry = { event: "story-skipped", reason: "off", detector: "d\"".repeat(500), repo: "\u0001".repeat(1000), fingerprint: "\"\u0000\n".repeat(3400) };
    const line = logLine(e, new Date());
    expect(Buffer.byteLength(line)).toBeLessThan(MAX_LINE_BYTES);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it("rotates by rename: no file is over the limit and both hold every line", () => {
    const e: LogEntry = { event: "story-skipped", reason: "off", detector: "d", repo: "r", fingerprint: "\u0001".repeat(200) };
    let written = 0;
    while (written < Math.ceil((MAX_LOG_BYTES * 1.5) / 1300)) {
      writeLog(e);
      written++;
    }
    expect(statSync(logFile()).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(existsSync(olderLogFile())).toBe(true);
    expect(statSync(olderLogFile()).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(logLines().length + logLines(olderLogFile()).length).toBe(written);
  });

  it("a second rotation replaces the older file", () => {
    const e: LogEntry = { event: "story-skipped", reason: "off", detector: "d", repo: "r", fingerprint: "\u0001".repeat(200) };
    const n = Math.ceil((MAX_LOG_BYTES * 2.5) / 1300);
    for (let i = 0; i < n; i++) writeLog(e);
    expect(logLines().length + logLines(olderLogFile()).length).toBeLessThan(n);
    expect(statSync(olderLogFile()).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
  });

  it("a suspended switch (monitor.lock held) does not stop the rotation", () => {
    const e: LogEntry = { event: "story-skipped", reason: "off", detector: "d", repo: "r", fingerprint: "\u0001".repeat(200) };
    writeFileSync(logFile(), "x".repeat(MAX_LOG_BYTES - 10));
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "pid"), String(process.ppid));
    writeLog(e);
    expect(existsSync(olderLogFile())).toBe(true);
    expect(statSync(logFile()).size).toBeLessThan(MAX_LINE_BYTES);
  });

  it("while another process holds the rotation lock lines are appended up to a hard ceiling, then dropped", () => {
    const e: LogEntry = { event: "story-skipped", reason: "off", detector: "d", repo: "r", fingerprint: "f" };
    const errors: string[] = [];
    mkdirSync(join(home, "monitor-log.lock"));
    writeFileSync(join(home, "monitor-log.lock", "pid"), String(process.ppid));
    writeFileSync(logFile(), "x".repeat(MAX_LOG_BYTES - 10));
    writeLog(e, { onError: (m) => errors.push(m) });
    expect(existsSync(olderLogFile())).toBe(false);
    expect(statSync(logFile()).size).toBeGreaterThan(MAX_LOG_BYTES);
    const before = statSync(logFile()).size;
    writeFileSync(logFile(), "x".repeat(HARD_LOG_BYTES));
    writeLog(e, { onError: (m) => errors.push(m) });
    expect(statSync(logFile()).size).toBe(HARD_LOG_BYTES);
    expect(before).toBeLessThan(HARD_LOG_BYTES);
    expect(errors).toHaveLength(1);
  });

  it("an on that stalls inside its write cannot commit after an off took the lock over", () => {
    saveGuard({ version: 1, off: { since: at(0).toISOString(), by: "cli" } });
    expect(() =>
      switchStories("on", UUID, {
        beforeCommit: () => {
          // the temporary file is written; the admin's off takes the lock over, reads the still-off file and returns unchanged
          expect(switchStories("off", "cli", { waitMs: 20 })).toMatchObject({ changed: false, state: "off" });
        },
      }),
    ).toThrow(/taken over/);
    expect(currentState().state).toBe("off");
    expect(leftovers()).toEqual([]);
  });

  it("does not throw on an unwritable path and calls onError", () => {
    const errors: string[] = [];
    expect(() => writeLog({ event: "on" }, { file: join(home, "monitor-guard.json", "x", "log.jsonl"), onError: (m) => errors.push(m) })).not.toThrow();
    writeFileSync(join(home, "plain"), "x");
    writeLog({ event: "on" }, { file: join(home, "plain", "log.jsonl"), onError: (m) => errors.push(m) });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("describes entries in plain words", () => {
    expect(describeEntry({ event: "story-skipped", reason: "off", detector: "restart-loop" })).toBe("bug story skipped (restart-loop): bug stories are off");
    expect(describeEntry({ event: "off" })).toBe("bug stories switched off");
  });
});

describe("the reporter with the guard", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let file: string;
  let found: FindingInput[];
  let clock: Date;
  let rec: LogEntry[];
  let verdict: (() => Verdict) | undefined;
  let limits: { per_day: number; per_check: number };
  let monitor: Monitor;
  let reporter: Reporter;

  const fi = (id: string, over: Partial<FindingInput> = {}): FindingInput => ({
    detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [at(0).toISOString()], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] }, ...over,
  });
  const cfg = () => ConfigSchema.parse({ monitor: { report_to: TARGET, report_limits: limits } }).monitor;
  const make = () =>
    new Reporter({
      config: cfg, buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }),
      guard: () => (verdict ? verdict() : storiesVerdict()), record: (e) => rec.push(e),
    });
  const mon = (r: Reporter) =>
    new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }),
      watchers: () => [], thresholds: cfg, log: () => {}, file, now: () => clock, reporter: r, detectors: [{ name: "t", description: "test", run: () => found }],
    });
  const check = async (h: number, m = monitor) => {
    clock = at(h);
    await m.tick();
    return m.status;
  };
  const stored = () => loadFindings(file).findings;
  const calls = () => gh.ghLog().split("\n").filter((l) => /^gh (api|label|issue comment)/.test(l) && !l.startsWith("gh api rate_limit"));
  const skips = (reason?: string) => rec.filter((e) => e.event === "story-skipped" && (!reason || e.reason === reason));

  beforeEach(() => {
    gh = fakeGithub();
    file = join(gh.tmp, "monitor-findings.json");
    found = [fi("a")];
    rec = [];
    verdict = undefined;
    limits = { per_day: 3, per_check: 1 };
    reporter = make();
    monitor = mon(reporter);
  });
  afterEach(() => {
    delete process.env.FAKE_GH_FAIL_API;
    gh.restore();
  });

  it("off stops a story that was due; on makes it at the next check", async () => {
    await check(0);
    process.env.FAKE_GH_FAIL_API = "list";
    await check(1);
    expect(stored()[0]!.due).toBeDefined();
    expect(skips("github")).toHaveLength(1);
    switchStories("off", "cli");
    delete process.env.FAKE_GH_FAIL_API;
    const before = gh.ghLog();
    const st = await check(2);
    expect(gh.ghLog()).toBe(before);
    expect(stored()[0]!.due).toBeDefined();
    expect(st.notes).toContain("1 bug story waits: bug stories are switched off.");
    expect(skips("off")).toHaveLength(1);
    const n = rec.length;
    await check(3);
    expect(rec.length).toBe(n);
    switchStories("on", "cli");
    await check(4);
    expect(rec.some((e) => e.event === "story-made")).toBe(true);
    expect(stored()[0]!.report).toBeDefined();
    expect(stored()[0]!.skipped).toBeUndefined();
    expect(st.lastActions.some((a) => a.includes("bug story skipped"))).toBe(false); // no monitor wiring here: only the reporter
  });

  it("nothing becomes owed while off, and the skip is cleared when the problem goes", async () => {
    switchStories("off", "cli");
    await check(0);
    await check(1);
    expect(stored()[0]!.due).toBeUndefined();
    expect(calls()).toEqual([]);
    expect(skips("off")).toHaveLength(1);
    found = [];
    switchStories("on", "cli");
    await check(2);
    await check(3);
    expect(calls()).toEqual([]);
    expect(stored()[0]!.skipped).toBeUndefined();
  });

  it("cool-down: no call and nothing owed until the end", async () => {
    const startedAt = at(0);
    verdict = () => storiesVerdict({ startedAt, cooldownMinutes: 10, now: clock });
    for (const m of [0, 5, 9]) {
      clock = new Date(at(0).getTime() + m * MIN);
      await monitor.tick();
    }
    expect(calls()).toEqual([]);
    expect(stored()[0]!.due).toBeUndefined();
    expect(skips("cooldown")).toHaveLength(1);
    clock = new Date(at(0).getTime() + 10 * MIN);
    await monitor.tick();
    expect(rec.some((e) => e.event === "story-made")).toBe(true);
  });

  it("a broken state file: no call, a note, reason unreadable", async () => {
    writeFileSync(guardFile(), "{nope");
    await check(0);
    const st = await check(1);
    expect(calls()).toEqual([]);
    expect(st.notes?.some((n) => n.endsWith("cannot be read."))).toBe(true);
    expect(skips("unreadable")).toHaveLength(1);
  });

  /** A guard that says on for the first `n` questions and off after that. */
  const onFor = (n: number): (() => Verdict) => {
    let i = 0;
    return () => (++i <= n ? { go: true } : { go: false, reason: "off", note: "bug stories are switched off" });
  };

  it("off after the list answer: only the list call, no label, no issue, one skip line", async () => {
    await check(0);
    verdict = onFor(1); // the top of the check; the next question is after the list
    await check(1);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain("api");
    expect(stored()[0]!.report).toBeUndefined();
    expect(stored()[0]!.due).toBeDefined(); // owed since the top of the check: it stays owed
    expect(skips("off")).toHaveLength(1);
  });

  it("off between the labels and the story: no issue is made", async () => {
    await check(0);
    verdict = onFor(3); // top, after the list, before the labels; off before the story
    await check(1);
    expect(gh.ghLog()).not.toContain("issue create");
    expect(rec.some((e) => e.event === "story-made")).toBe(false);
    expect(stored()[0]!.report).toBeUndefined();
    expect(stored()[0]!.due).toBeDefined();
  });

  it("off before the comment: no comment, and lookedAt is unchanged", async () => {
    await check(0);
    await check(1);
    const made = stored()[0]!.report!;
    gh.setBugIssues([{ number: made.issue, state: "open", state_reason: null, title: "t", body: `text\n\n${markerFor("restart-loop|a")}`, labels: [{ name: "bug" }], html_url: made.url, created_at: at(0).toISOString(), closed_at: null }]);
    verdict = onFor(2); // top and after the list; off before the comment
    await check(8);
    expect(gh.ghLog()).not.toContain("issue comment");
    expect(stored()[0]!.report!.lookedAt).toBe(made.lookedAt);
  });

  it("off after the first label call: the second label call is not made, and no issue", async () => {
    await check(0);
    verdict = onFor(4); // top, after the list, before the loop, before label 1; off before label 2
    await check(1);
    expect(calls().filter((l) => l.startsWith("gh label"))).toHaveLength(1);
    expect(gh.ghLog()).not.toContain("issue create");
    expect(stored()[0]!.due).toBeDefined();
    expect(skips("off")).toHaveLength(1);
  });

  it("off while the comment is saved: no comment, and lookedAt is unchanged", async () => {
    await check(0);
    await check(1);
    const made = stored()[0]!.report!;
    gh.setBugIssues([{ number: made.issue, state: "open", state_reason: null, title: "t", body: `text\n\n${markerFor("restart-loop|a")}`, labels: [{ name: "bug" }], html_url: made.url, created_at: at(0).toISOString(), closed_at: null }]);
    verdict = onFor(3); // top, after the list, before the comment; off right after the save
    await check(8);
    expect(gh.ghLog()).not.toContain("issue comment");
    expect(stored()[0]!.report!.lookedAt).toBe(made.lookedAt);
  });

  it("logs a story held back by the budget of calls", async () => {
    clock = at(10);
    const stamp = clock.toISOString();
    const base = (id: string, over: object = {}) => ({ ...fi(id), firstSeen: at(0).toISOString(), lastSeen: stamp, count: 3, streak: 3, gone: false, ...over });
    const withReport = (i: number) => base(`r${i}`, { report: { repo: TARGET, issue: 100 + i, url: "u", at: at(-100).toISOString(), seen: 1, lookedAt: at(-50).toISOString() } });
    const input = [base("owed", { due: at(9).toISOString() }), ...[1, 2, 3, 4].map(withReport)];
    const r = await make().report(input, clock, () => {});
    expect(r.notes.join(" ")).toContain("they are made at the next check");
    // the four stories that could not be read are owed again too: all five wait, each is logged once
    expect(skips("check_limit").map((e) => e.fingerprint)).toContain("restart-loop|owed");
    expect(skips("check_limit")).toHaveLength(5);
    expect(gh.ghLog()).not.toContain("issue create");
  });

  it("writes story-made even when the local save fails", async () => {
    await check(0);
    clock = at(1);
    const input = stored().map((f) => ({ ...f, lastSeen: clock.toISOString(), streak: 2, count: 2 }));
    await expect(
      make().report(input, clock, () => {
        throw new Error("disk");
      }),
    ).rejects.toThrow("disk");
    expect(rec.some((e) => e.event === "story-made")).toBe(true);
  });

  it("writes a skipped story once per finding and reason, also over a restart, and again after the story", async () => {
    switchStories("off", "cli");
    await check(0);
    await check(1);
    expect(skips("off")).toHaveLength(1);
    switchStories("on", "cli");
    limits = { per_day: 1, per_check: 1 };
    found = [fi("a"), fi("b")];
    await check(2); // a is made (first of the day)
    await check(3); // b waits: the day limit
    await check(4);
    expect(skips("day_limit")).toHaveLength(1);
    switchStories("off", "cli");
    await check(5);
    expect(skips("off").map((e) => e.fingerprint)).toEqual(["restart-loop|a", "restart-loop|b"]); // a before it was made, b now; no second line for a
    const n = rec.length;
    reporter = make();
    monitor = mon(reporter); // a restart
    await check(6);
    expect(rec.length).toBe(n);
  });

  it("logs the check limit once over two checks, and the day limit", async () => {
    found = [fi("a"), fi("b"), fi("c")];
    await check(0);
    await check(1);
    await check(2);
    expect(skips("check_limit")).toHaveLength(2);
    limits = { per_day: 1, per_check: 1 };
    found = [fi("a"), fi("b"), fi("c"), fi("d")];
    await check(3);
    expect(skips("day_limit").length).toBeGreaterThan(0);
  });
});
