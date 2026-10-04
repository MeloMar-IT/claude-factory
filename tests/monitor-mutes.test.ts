import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import type { Names } from "../src/monitor/clean.js";
import { loadFindings, saveFindings, type Finding, type FindingInput } from "../src/monitor/findings.js";
import { describeEntry, guardFile, loadGuard, logFile, lockDir, openBreaker, saveGuard, storiesVerdict, switchStories, validReason, type LogEntry, type Mute } from "../src/monitor/guard.js";
import { Monitor } from "../src/monitor/monitor.js";
import { activeMutes, addMute, endMute, expireMutes, MuteError, muteFor, muteLine } from "../src/monitor/mutes.js";
import { Reporter } from "../src/monitor/report.js";
import { markerHash } from "../src/monitor/story.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { fakeGithub } from "./helpers/fake-github.js";

const UUID = "0b6b5e0e-6a2c-4a5e-9d6e-3a2f9c1d7e11";
const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 1, 12, 0, 0);
const at = (h: number) => new Date(T0.getTime() + h * HOUR);
const iso = (h: number) => at(h).toISOString();
const TARGET = "acme/app";
const NAMES: Names = { target: TARGET, users: [], emails: [], repos: [], watchers: [], complete: true };

let gh: ReturnType<typeof fakeGithub>;
let home: string;
let saved: string | undefined;
beforeEach(() => {
  gh = fakeGithub();
  saved = process.env.FACTORY_HOME;
  home = join(gh.tmp, "home");
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  delete process.env.FAKE_GH_FAIL_API;
  process.env.FACTORY_HOME = saved;
  gh.restore();
});

const logLines = () => (existsSync(logFile()) ? readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
const leftovers = () => (existsSync(home) ? readdirSync(home).filter((n) => n.endsWith(".tmp") || n === "monitor.lock") : []);
const mutes = () => (loadGuard() as { ok: true; data: { mutes?: Mute[] } }).data.mutes ?? [];
const mute = (over: Partial<Parameters<typeof addMute>[0]> = {}, now = at(0)) => addMute({ detector: "restart-loop", reason: "known noise", by: UUID, ...over }, { now });
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof MuteError ? e.code : `other: ${(e as Error).message}`;
  }
  return undefined;
};

describe("the mutes in the state file", () => {
  const good = { id: "0123456789abcdef", kind: "detector", detector: "restart-loop", reason: "noise", since: iso(0), by: UUID };
  const write = (m: unknown) => writeFileSync(guardFile(), JSON.stringify({ version: 1, mutes: [m] })) ;

  beforeEach(() => mkdirSync(home, { recursive: true }));

  it("loads a valid list", () => {
    writeFileSync(guardFile(), JSON.stringify({ version: 1, mutes: [good, { ...good, id: "fedcba9876543210", kind: "finding", fingerprint: "x|y", until: iso(2), by: "cli" }] }));
    expect(loadGuard().ok).toBe(true);
  });

  it("refuses each malformed entry", () => {
    const bad: unknown[] = [
      { ...good, id: "nope" },
      { ...good, kind: "finding" },
      { ...good, reason: "a\nb" },
      { ...good, reason: "x".repeat(201) },
      { ...good, until: "not a time" },
      { ...good, by: "Ann" },
      { ...good, fingerprint: "x" },
      5,
    ];
    for (const m of bad) {
      write(m);
      expect(loadGuard()).toEqual({ ok: false });
    }
    writeFileSync(guardFile(), JSON.stringify({ version: 1, mutes: "x" }));
    expect(loadGuard()).toEqual({ ok: false });
  });

  it("switching off and on keeps the mutes; on over an unreadable file starts without them", () => {
    mute();
    switchStories("off", "cli", { now: at(1) });
    expect(mutes()).toHaveLength(1);
    switchStories("on", "cli", { now: at(2) });
    expect(mutes()).toHaveLength(1);
    writeFileSync(guardFile(), "{broken");
    switchStories("on", "cli", { now: at(3) });
    expect(mutes()).toEqual([]);
  });

  it("validReason", () => {
    expect(validReason("ok")).toBe(true);
    for (const r of ["", " a", "a ", "a\tb", "x".repeat(201), 5]) expect(validReason(r)).toBe(false);
  });
});

describe("addMute", () => {
  it("stores the mute, keeps other keys, logs, mode 0600, leaves nothing behind", () => {
    saveGuard({ version: 1, extra: 7, off: { since: iso(0), by: "cli" }, breaker: { from: iso(0) } });
    const m = mute({ hours: 2 }, at(1));
    expect(m).toMatchObject({ kind: "detector", detector: "restart-loop", reason: "known noise", since: iso(1), until: iso(3), by: UUID });
    expect(m.id).toMatch(/^[0-9a-f]{16}$/);
    expect(loadGuard()).toMatchObject({ ok: true, data: { extra: 7, off: { by: "cli" }, breaker: { from: iso(0) }, mutes: [m] } });
    expect(logLines()).toMatchObject([{ event: "mute-made", by: UUID, detector: "restart-loop", mute: m.id, text: "known noise", until: iso(3) }]);
    expect(statSync(guardFile()).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it("without hours it is for good", () => {
    expect(mute().until).toBeUndefined();
  });

  it("refuses an invalid reason, hours or `by`", () => {
    for (const reason of ["", " noise", "a\nb", "x".repeat(201)]) expect(code(() => mute({ reason }))).toBe("invalid");
    for (const hours of [0, -1, NaN, Infinity, 8761]) expect(code(() => mute({ hours }))).toBe("invalid");
    expect(code(() => mute({ by: "Ann" }))).toBe("invalid");
    expect(mutes()).toEqual([]);
  });

  it("refuses the same detector or the same fingerprint twice", () => {
    mute();
    expect(code(() => mute())).toBe("exists");
    mute({ fingerprint: "restart-loop|a" });
    expect(code(() => mute({ fingerprint: "restart-loop|a" }))).toBe("exists");
  });

  it("allows two findings of one detector, and a finding next to its detector", () => {
    mute({ fingerprint: "restart-loop|a" });
    mute({ fingerprint: "restart-loop|b" });
    mute();
    expect(mutes()).toHaveLength(3);
  });

  it("is full at 200", () => {
    for (let i = 0; i < 200; i++) mute({ fingerprint: `restart-loop|${i}` });
    expect(code(() => mute())).toBe("full");
  });

  it("expired mutes do not count for the limit: they are purged and logged with their reason", () => {
    for (let i = 0; i < 200; i++) mute({ fingerprint: `restart-loop|${i}`, hours: 1, reason: `r${i}` });
    expect(code(() => mute())).toBe("full");
    expect(() => mute({}, at(2))).not.toThrow();
    expect(mutes()).toHaveLength(1);
    const ended = logLines().filter((l) => l.event === "mute-ended");
    expect(ended).toHaveLength(200);
    expect(ended[0]).toMatchObject({ reason: "expired", text: "r0" });
  });

  it("an unreadable file and a held lock", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(guardFile(), "{broken");
    expect(code(() => mute())).toBe("unreadable");
    rmSync(guardFile());
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "pid"), String(process.pid));
    expect(code(() => addMute({ detector: "restart-loop", reason: "r", by: UUID }, { waitMs: 0 }))).toBe("locked");
    expect(existsSync(guardFile())).toBe(false);
  });
});

describe("endMute", () => {
  it("removes the mute, logs who ended it, and the last one removes the key", () => {
    const a = mute();
    const b = mute({ detector: "slow-step" });
    endMute(a.id, UUID, { now: at(1) });
    expect(mutes()).toEqual([b]);
    endMute(b.id, "cli", { now: at(1) });
    expect(loadGuard()).toEqual({ ok: true, data: { version: 1 } });
    expect(logLines().filter((l) => l.event === "mute-ended")).toMatchObject([{ by: UUID, mute: a.id, text: "known noise" }, { by: "cli", mute: b.id, text: "known noise" }]);
  });

  it("an unknown id and an expired mute are not found", () => {
    const m = mute({ hours: 1 });
    expect(code(() => endMute("0000000000000000", UUID))).toBe("not_found");
    expect(code(() => endMute(m.id, UUID, { now: at(2) }))).toBe("not_found");
  });
});

describe("activeMutes and muteFor", () => {
  it("a mute for a time ends exactly at until", () => {
    mute({ hours: 2 });
    expect(activeMutes(loadGuard(), at(1.99))).toHaveLength(1);
    expect(activeMutes(loadGuard(), at(2))).toHaveLength(0);
    expect(activeMutes({ ok: false }, at(0))).toEqual([]);
  });

  it("the finding mute wins over the detector mute and holds only its finding", () => {
    const d = mute();
    const f = mute({ fingerprint: "restart-loop|a" });
    const all = activeMutes(loadGuard(), at(0));
    expect(muteFor(all, { detector: "restart-loop", fingerprint: "restart-loop|a" })?.id).toBe(f.id);
    expect(muteFor(all, { detector: "restart-loop", fingerprint: "restart-loop|b" })?.id).toBe(d.id);
    expect(muteFor([f], { detector: "restart-loop", fingerprint: "restart-loop|b" })).toBeUndefined();
  });

  it("muteLine names a finding by its hash, never by its fingerprint", () => {
    const f = mute({ fingerprint: "secret|fp" });
    expect(muteLine(f)).toContain(markerHash("secret|fp"));
    expect(muteLine(f)).not.toContain("secret|fp");
    expect(describeEntry({ event: "story-skipped", reason: "muted", detector: "d", text: "why" })).toBe("bug story skipped (d): muted: why");
  });
});

describe("expireMutes", () => {
  it("drops only expired mutes and logs expired", () => {
    const a = mute({ hours: 1 });
    const b = mute({ detector: "slow-step", hours: 5 });
    expect(expireMutes(at(2), { now: at(2) }).map((m) => m.id)).toEqual([a.id]);
    expect(mutes()).toEqual([b]);
    expect(logLines().filter((l) => l.event === "mute-ended")).toMatchObject([{ reason: "expired", mute: a.id, text: "known noise" }]);
  });

  it("takes no lock when nothing expired, and returns [] while the lock is held", () => {
    const a = mute({ hours: 1 });
    mkdirSync(lockDir());
    writeFileSync(join(lockDir(), "pid"), String(process.pid));
    expect(expireMutes(at(0), { now: at(0) })).toEqual([]);
    expect(expireMutes(at(2), { now: at(2) })).toEqual([]);
    expect(mutes()).toEqual([a]);
  });
});

describe("the reporter with mutes", () => {
  let file: string;
  let found: FindingInput[];
  let clock: Date;
  let rec: LogEntry[];
  let late: undefined | (() => Mute[]);
  let monitor: Monitor;
  const cfg = () => ConfigSchema.parse({ monitor: { report_to: TARGET, report_limits: { per_day: 5, per_check: 3 } } }).monitor;
  const fi = (id: string): FindingInput => ({
    detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [iso(0)], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] },
  });
  const make = (stub?: () => Mute[]) =>
    new Reporter({
      config: cfg, buildLabel: () => "go", names: () => NAMES, builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }),
      guard: () => storiesVerdict(), mutes: (now) => (stub ? stub() : activeMutes(loadGuard(), now)), record: (e) => rec.push(e),
    });
  const mon = (r: Reporter) =>
    new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }),
      watchers: () => [], thresholds: cfg, log: () => {}, file, now: () => clock, reporter: r, detectors: [{ name: "t", description: "test", run: () => found }], guard: {},
    });
  const check = async (h: number, m = monitor) => {
    clock = at(h);
    await m.tick();
  };
  const stored = () => loadFindings(file).findings;
  const calls = () => gh.ghLog().split("\n").filter((l) => /^gh (api|label|issue comment)/.test(l) && !l.startsWith("gh api rate_limit"));
  const skips = (reason: string) => rec.filter((e) => e.event === "story-skipped" && e.reason === reason);

  beforeEach(() => {
    file = join(gh.tmp, "monitor-findings.json");
    found = [fi("a")];
    rec = [];
    late = undefined;
    monitor = mon(make());
  });

  it("a muted detector: recorded, no call, no due, one log line with the reason", async () => {
    const m = mute();
    await check(0);
    await check(1);
    expect(calls()).toEqual([]);
    expect(stored()[0]).toMatchObject({ count: 2, lastSeen: iso(1) });
    expect(stored()[0]!.due).toBeUndefined();
    expect(skips("muted")).toMatchObject([{ text: "known noise", mute: m.id }]);
    await check(2);
    expect(rec).toHaveLength(1);
  });

  it("a second mute that takes over from the first is logged again with its own reason", async () => {
    const a = mute({ reason: "first" });
    await check(0);
    await check(1);
    const b = mute({ fingerprint: "restart-loop|a", reason: "second" }, at(1));
    endMute(a.id, UUID, { now: at(1) });
    await check(2);
    expect(skips("muted")).toMatchObject([{ mute: a.id, text: "first" }, { mute: b.id, text: "second" }]);
    await check(3);
    expect(skips("muted")).toHaveLength(2);
  });

  it("a muted fingerprint makes no story; another finding of the detector does", async () => {
    mute({ fingerprint: "restart-loop|a" });
    found = [fi("a"), fi("b")];
    await check(0);
    await check(1);
    const f = stored();
    expect(f.find((x) => x.fingerprint.endsWith("|a"))!.report).toBeUndefined();
    expect(f.find((x) => x.fingerprint.endsWith("|b"))!.report).toBeDefined();
  });

  it("owed before the mute: no call, due stays; after unmute the story is made", async () => {
    await check(0);
    process.env.FAKE_GH_FAIL_API = "list";
    await check(1);
    delete process.env.FAKE_GH_FAIL_API;
    expect(stored()[0]!.due).toBeDefined();
    const m = mute({}, at(1));
    const before = gh.ghLog();
    await check(2);
    expect(gh.ghLog()).toBe(before);
    expect(stored()[0]!.due).toBeDefined();
    expect(skips("muted")).toHaveLength(1);
    endMute(m.id, UUID, { now: at(2) });
    await check(3);
    expect(stored()[0]!.report).toBeDefined();
    expect(stored()[0]!.skipped).toBeUndefined();
  });

  it("a mute for 2 hours ends by itself: the story is made at hour 3", async () => {
    mute({ hours: 2 });
    for (const h of [0, 1]) await check(h);
    expect(calls()).toEqual([]);
    await check(3);
    expect(stored()[0]!.report).toBeDefined();
    expect(mutes()).toEqual([]);
    expect(logLines().some((l) => l.event === "mute-ended" && l.reason === "expired")).toBe(true);
  });

  it("no comment while muted, and the seen count grows; after unmute the next check comments", async () => {
    await check(0);
    await check(1);
    expect(stored()[0]!.report).toBeDefined();
    const m = mute({}, at(1));
    const before = calls().length;
    const seen = stored()[0]!.report!.seen;
    await check(7);
    await check(8);
    expect(calls().length).toBe(before);
    expect(stored()[0]!.report!.seen).toBe(seen + 2);
    endMute(m.id, UUID, { now: at(8) });
    await check(9);
    expect(gh.ghLog()).toContain("issue comment");
  });

  it("muted during the check, before the story: no issue, one log line, due is kept", async () => {
    await check(0);
    const m = { id: "0123456789abcdef", kind: "detector", detector: "restart-loop", reason: "late", since: iso(1), by: UUID } as Mute;
    let n = 0;
    late = () => (n++ === 0 ? [] : [m]);
    monitor = mon(make(late));
    await check(1);
    expect(calls().some((c) => c.includes("POST") || c.includes("issues") && c.includes("-X POST"))).toBe(false);
    expect(stored()[0]!.report).toBeUndefined();
    expect(stored()[0]!.due).toBeDefined();
    expect(stored()[0]!.skipped).toEqual([`muted:${m.id}`]);
    expect(skips("muted")).toMatchObject([{ mute: m.id, text: "late" }]);
  });

  it("muted during the check, before the comment: no comment, lookedAt is not moved", async () => {
    await check(0);
    await check(1);
    const looked = stored()[0]!.report!.lookedAt;
    const m = { id: "0123456789abcdef", kind: "detector", detector: "restart-loop", reason: "late", since: iso(1), by: UUID } as Mute;
    let n = 0;
    monitor = mon(make(() => (n++ === 0 ? [] : [m])));
    const before = gh.ghLog();
    await check(8);
    expect(gh.ghLog()).not.toContain("issue comment");
    expect(gh.ghLog().split("issue comment").length).toBe(before.split("issue comment").length);
    expect(stored()[0]!.report!.lookedAt).toBe(looked);
  });

  it("muted while bug stories are off: the line says muted; after unmute, off is written", async () => {
    switchStories("off", "cli", { now: at(0) });
    const m = mute({}, at(0));
    await check(0);
    await check(1);
    expect(skips("muted")).toHaveLength(1);
    expect(skips("off")).toHaveLength(0);
    endMute(m.id, UUID, { now: at(1) });
    await check(2);
    expect(skips("off")).toHaveLength(1);
  });
});

describe("the circuit breaker and mutes", () => {
  let file: string;
  let found: FindingInput[];
  let clock: Date;
  let n = 0;
  const cfg = () => ConfigSchema.parse({ monitor: { report_to: TARGET, report_limits: { per_day: 50, per_check: 3 } } }).monitor;
  const fi = (id: string, detector = "restart-loop"): FindingInput => ({
    detector, fingerprint: `${detector}|${id}`, severity: "critical", summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [iso(0)], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] },
  });
  const six = (detector = "restart-loop") => Array.from({ length: 6 }, (_, i) => fi(`f${i}`, detector));
  const mk = (beforeOpen?: () => void) =>
    new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler: new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ConfigSchema.parse({}) }),
      watchers: () => [], thresholds: cfg, log: () => {}, file, now: () => clock, detectors: [{ name: "t", description: "test", run: () => found }], guard: { beforeOpen },
    });
  const check = async (h: number, m: Monitor) => {
    clock = at(h);
    await m.tick();
  };
  const opened = () => !!(loadGuard() as { ok: true; data: { breaker?: { open?: unknown } } }).data.breaker?.open;
  const storyRun = (status: string, finished: number, issue: string) => {
    const runId = `run-${++n}`;
    const runDir = join(gh.tmp, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    saveRun({ runId, flow: "issue-gitflow", task: "t", status, startedAt: iso(finished - 0.1), finishedAt: iso(finished), vars: { github_repo: TARGET, issue }, runDir, history: [], totalCostUsd: 0 } as unknown as RunSummary);
  };
  const story = (issue: number) => ({ repo: TARGET, issue, url: `https://github.com/${TARGET}/issues/${issue}`, at: iso(0), seen: 0 });

  beforeEach(() => {
    file = join(gh.tmp, "monitor-findings.json");
    found = six();
    n = 0;
  });

  it("six new findings of a muted detector do not open it", async () => {
    mute();
    await check(0, mk());
    expect(opened()).toBe(false);
  });

  it("six findings with one muted do not open it; after unmute they do", async () => {
    const m = mute({ fingerprint: "restart-loop|f0" });
    await check(0, mk());
    expect(opened()).toBe(false);
    endMute(m.id, UUID, { now: at(0) });
    await check(0, mk());
    expect(opened()).toBe(true);
  });

  it("failed runs of the story of a muted finding do not count", async () => {
    found = [fi("a")];
    saveFindings([{ ...fi("a"), firstSeen: iso(-100), lastSeen: iso(0), count: 5, gone: false, report: story(12) } as Finding], file);
    for (const h of [0.1, 0.2, 0.3]) storyRun("failed", h, "12");
    mute();
    await check(1, mk());
    expect(opened()).toBe(false);
    rmSync(guardFile());
    await check(1.1, mk());
    expect(opened()).toBe(true);
  });

  it("a mute made between the decision and the opening keeps it closed", async () => {
    await check(0, mk(() => void mute()));
    expect(opened()).toBe(false);
    expect(logLines().some((l) => l.event === "breaker-open")).toBe(false);
  });

  it("openBreaker with a recheck that answers nothing opens nothing; without it, as before", () => {
    saveGuard({ version: 1, breaker: { from: iso(0) } });
    const why = { reason: "failed_fixes" as const, count: 3 };
    expect(openBreaker(why, iso(0), { recheck: () => undefined })).toBeUndefined();
    expect(opened()).toBe(false);
    expect(openBreaker(why, iso(0))).toMatchObject({ reason: "failed_fixes" });
  });
});
