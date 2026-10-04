import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunBrief, type RunSummary } from "../src/engine/state.js";
import { decideBreaker, failedFixes, forgetSkip, isStoryRun, keepEarlier, storyKeys, withoutStoryRuns } from "../src/monitor/breaker.js";
import type { FindingInput } from "../src/monitor/findings.js";
import { loadFindings, saveFindings, type Finding } from "../src/monitor/findings.js";
import { breakerNow, guardFile, logFile, loadGuard, storiesVerdict, switchStories, type LogEntry } from "../src/monitor/guard.js";
import { Monitor, type LockFile } from "../src/monitor/monitor.js";
import { Reporter } from "../src/monitor/report.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { fakeGithub } from "./helpers/fake-github.js";

const MIN = 60_000;
const T0 = new Date(2026, 9, 1, 12, 0, 0);
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const iso = (min: number) => at(min).toISOString();
const TARGET = "acme/app";

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry", evidence: {},
  firstSeen: iso(0), lastSeen: iso(0), count: 1, gone: false, ...over,
});
const story = (issue: number, repo = TARGET) => ({ repo, issue, url: `https://github.com/${repo}/issues/${issue}`, at: iso(-100), seen: 1 });
const brief = (id: string, status: RunBrief["status"], finished: number, issue = "12", over: Partial<RunBrief> = {}): RunBrief => ({
  runId: id, dirName: id, flow: "issue-gitflow", status, startedAt: iso(finished - 5), finishedAt: iso(finished), runDir: `/x/${id}`, updatedAt: iso(finished),
  githubRepo: TARGET, issue, ...over,
});
const cfg = ConfigSchema.parse({}).monitor.breaker;
const logLines = () => (existsSync(logFile()) ? readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

describe("story runs", () => {
  const f12 = finding("a", { report: story(12), earlier: [{ repo: "Old/Repo", issue: 3 }] });
  const stories = storyKeys([f12]);

  it("storyKeys and isStoryRun ignore the case of the repository and match earlier stories", () => {
    expect(isStoryRun({ githubRepo: "ACME/app", issue: "12" }, stories)).toBe(true);
    expect(isStoryRun({ githubRepo: "old/repo", issue: "3" }, stories)).toBe(true);
    expect(isStoryRun({ githubRepo: TARGET, issue: "13" }, stories)).toBe(false);
    expect(isStoryRun({ githubRepo: "other/app", issue: "12" }, stories)).toBe(false);
    expect(isStoryRun({ githubRepo: TARGET, issue: "twelve" }, stories)).toBe(false);
    expect(isStoryRun({ githubRepo: TARGET }, stories)).toBe(false);
    expect(isStoryRun({ issue: "12" }, stories)).toBe(false);
  });

  it("withoutStoryRuns takes runs, active runs, tracked issues and locks out, and leaves the input alone", () => {
    const run = (runId: string, issue: string, repo = TARGET) => ({ runId, vars: { github_repo: repo, issue } }) as unknown as RunSummary;
    const lock = (runId: string): LockFile => ({ key: runId, repo: "r", runId, runDir: "/x", areas: ["a"], at: iso(0) });
    const watcher = (repo: string) => ({ cfg: { github_repo: repo } as never, status: { id: "w", lastActions: [] }, issues: [{ issue: 12, title: "t" }, { issue: 20, title: "u" }] });
    const input = {
      runs: [run("s1", "12"), run("o1", "20")], active: [{ run: run("s2", "12") }, { run: run("o2", "20") }],
      watchers: [watcher(TARGET), watcher("other/app")], locks: [lock("s1"), lock("s2"), lock("o1"), lock("known-by-id")],
    };
    const copy = JSON.stringify(input);
    const out = withoutStoryRuns(input, stories, ["known-by-id"]);
    expect(out.runs.map((r) => r.runId)).toEqual(["o1"]);
    expect(out.active.map((a) => a.run.runId)).toEqual(["o2"]);
    expect(out.watchers[0]!.issues!.map((i) => i.issue)).toEqual([20]);
    expect(out.watchers[1]!.issues!.map((i) => i.issue)).toEqual([12, 20]);
    expect(out.locks.map((l) => l.runId)).toEqual(["o1"]);
    expect(JSON.stringify(input)).toBe(copy);
  });

  it("keepEarlier adds a replaced story once, and leaves unchanged findings alone", () => {
    const before = [finding("a", { report: story(12) }), finding("b", { report: story(5) })];
    const same = keepEarlier(before, before);
    expect(same[0]).toBe(before[0]);
    const after = [{ ...before[0]!, report: story(13) }, { ...before[1]!, report: story(5, "new/repo") }];
    const out = keepEarlier(before, after);
    expect(out[0]!.earlier).toEqual([{ repo: TARGET, issue: 12 }]);
    expect(out[1]!.earlier).toEqual([{ repo: TARGET, issue: 5 }]);
    expect(keepEarlier(before, out)[0]!.earlier).toEqual([{ repo: TARGET, issue: 12 }]); // no doubles
    const gone = keepEarlier(before, [{ ...before[0]!, report: undefined }]);
    expect(gone[0]!.earlier).toEqual([{ repo: TARGET, issue: 12 }]);
    let chain = before[0]!;
    for (let i = 20; i < 35; i++) chain = keepEarlier([chain], [{ ...chain, report: story(i) }])[0]!;
    expect(chain.earlier).toHaveLength(10);
    expect(chain.earlier!.some((e) => e.issue === (chain.report!.issue))).toBe(false);
  });

  it("forgetSkip removes only the given reason", () => {
    const a = finding("a", { skipped: ["breaker", "off"] });
    const b = finding("b", { skipped: ["off"] });
    const c = finding("c", { skipped: ["breaker"] });
    const out = forgetSkip([a, b, c], "breaker");
    expect(out[0]!.skipped).toEqual(["off"]);
    expect(out[1]).toBe(b);
    expect(out[2]!.skipped).toBeUndefined();
  });
});

describe("failedFixes", () => {
  const f = finding("a", { report: story(12), earlier: [{ repo: TARGET, issue: 3 }] });

  it("counts each failed finish once, and names the story", () => {
    const first = failedFixes([f], [brief("r1", "failed", 10)]);
    expect(first.findings[0]!.fixFailed).toEqual({ count: 1, at: iso(10) });
    expect(first.failed.map((x) => [x.issue, x.count])).toEqual([[12, 1]]);
    const again = failedFixes(first.findings, [brief("r1", "failed", 10)]);
    expect(again.failed).toEqual([]);
    expect(again.findings[0]).toBe(first.findings[0]);
    const later = failedFixes(first.findings, [brief("r1", "failed", 10), brief("r2", "failed", 20)]);
    expect(later.findings[0]!.fixFailed!.count).toBe(2);
    const resumed = failedFixes(later.findings, [brief("r1", "failed", 10), brief("r2", "failed", 30)]);
    expect(resumed.findings[0]!.fixFailed).toEqual({ count: 3, at: iso(30) });
    const earlier = failedFixes([f], [brief("r3", "failed", 10, "3")]);
    expect(earlier.failed.map((x) => [x.repo, x.issue])).toEqual([[TARGET, 3]]);
  });

  it("does not count other statuses, interrupted runs or runs of another story", () => {
    const runs = ["stopped", "waiting", "cancelled", "succeeded", "running"].map((s, i) => brief(`r${i}`, s as never, 10 + i));
    runs.push(brief("int", "failed", 30, "12", { interrupted: true }), brief("other", "failed", 31, "99"));
    const out = failedFixes([f], runs);
    expect(out.failed).toEqual([]);
    expect(out.findings[0]).toBe(f);
  });
});

describe("decideBreaker", () => {
  const input = (findings: Finding[], storyRuns: RunBrief[] = [], over = {}) => ({ findings, storyRuns, config: cfg, now: at(30), ...over });
  const fresh = (n: number, over: Partial<Finding> = {}) => Array.from({ length: n }, (_, i) => finding(`n${i}`, { firstSeen: iso(10), ...over }));

  it("opens for more than 5 new findings within the hour", () => {
    expect(decideBreaker(input(fresh(5)))).toBeUndefined();
    expect(decideBreaker(input(fresh(6)))).toEqual({ reason: "findings", count: 6, minutes: 60 });
  });

  it("does not count old, quiet-start or earlier-than-from findings", () => {
    expect(decideBreaker(input(fresh(6, { firstSeen: iso(-31) })))).toBeUndefined(); // 61 minutes old
    expect(decideBreaker(input(fresh(6, { quietStart: true })))).toBeUndefined();
    expect(decideBreaker(input(fresh(6), [], { from: iso(10) }))).toBeUndefined();
    expect(decideBreaker(input(fresh(6), [], { from: iso(9) }))).toBeDefined();
  });

  it("opens when the newest 3 finished story runs all failed; a success resets", () => {
    const F = (i: number) => brief(`f${i}`, "failed", i);
    const S = (i: number) => brief(`s${i}`, "succeeded", i);
    expect(decideBreaker(input([], [F(1), F(2), F(3)]))).toEqual({ reason: "failed_fixes", count: 3 });
    expect(decideBreaker(input([], [F(1), S(2), F(3), F(4)]))).toBeUndefined();
    expect(decideBreaker(input([], [F(1), S(2), F(3), F(4), F(5)]))).toEqual({ reason: "failed_fixes", count: 3 });
    expect(decideBreaker(input([], [F(1), F(2), brief("c", "cancelled", 3), brief("i", "failed", 4, "12", { interrupted: true }), F(5)]))).toEqual({ reason: "failed_fixes", count: 3 });
    expect(decideBreaker(input([], [F(1), F(2)]))).toBeUndefined();
    expect(decideBreaker(input([], [F(1), F(2), F(3)], { from: iso(3) }))).toBeUndefined();
  });

  it("respects the settings", () => {
    expect(decideBreaker(input(fresh(2), [], { config: { ...cfg, new_findings: 1 } }))).toMatchObject({ reason: "findings", count: 2 });
    expect(decideBreaker(input([], [brief("f", "failed", 1)], { config: { ...cfg, failed_fixes: 1 } }))).toEqual({ reason: "failed_fixes", count: 1 });
  });
});

describe("briefs of story runs", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => gh.restore());

  it("carry the repository and the issue, and mark a run with no process as interrupted", () => {
    const runsDir = join(gh.tmp, "runs");
    const runDir = join(runsDir, "r1");
    mkdirSync(runDir, { recursive: true });
    saveRun({ runId: "r1", flow: "f", task: "t", status: "running", startedAt: iso(0), vars: { github_repo: TARGET, issue: "12" }, runDir, history: [] } as unknown as RunSummary);
    const [b] = new Scheduler({ runsDir, config: () => ConfigSchema.parse({}) }).briefs();
    expect(b).toMatchObject({ githubRepo: TARGET, issue: "12", status: "failed", interrupted: true });
  });
});

describe("the monitor with the circuit breaker", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let file: string;
  let runsDir: string;
  let found: FindingInput[];
  let clock: Date;
  let rec: LogEntry[];
  let over: Record<string, unknown>;
  let reportTo: string | undefined;
  let cooldown: number;
  let n = 0;

  const fi = (id: string): FindingInput => ({
    detector: "restart-loop", fingerprint: `restart-loop|${id}`, severity: "critical", summary: "s", about: "foundry",
    evidence: { counts: { runs: 2 }, times: [iso(0)], steps: ["claim_areas"], flows: ["issue-gitflow"], lines: ["exit code 1"] },
  });
  const six = () => Array.from({ length: 6 }, (_, i) => fi(`f${i}`));
  const config = () => ConfigSchema.parse({ monitor: { ...(reportTo ? { report_to: reportTo } : {}), cooldown_minutes: cooldown, report_limits: { per_day: 50, per_check: 3 } } }).monitor;
  const mk = (extra: Record<string, unknown> = {}) => {
    const reporter = new Reporter({
      config, buildLabel: () => "go", names: () => ({ target: TARGET, users: [], emails: [], repos: [], watchers: [], complete: true }),
      builtinSteps: () => ({ "issue-gitflow": ["claim_areas"] }), guard: () => storiesVerdict({ startedAt: extra.startedAt as Date | undefined, cooldownMinutes: cooldown, now: clock }),
      record: (e) => rec.push(e),
    });
    return new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
      scheduler: new Scheduler({ runsDir, config: () => ConfigSchema.parse({}) }), watchers: () => [], thresholds: config, log: () => {}, file, now: () => clock,
      reporter, detectors: [{ name: "t", description: "test", run: () => found }], guard: { ...(extra.startedAt ? { startedAt: extra.startedAt as Date } : {}), ...(over as object) },
    });
  };
  let monitor: Monitor;
  const check = async (min: number, m = monitor) => {
    clock = at(min);
    await m.tick();
    return m.status;
  };
  const stored = () => loadFindings(file).findings;
  const calls = () => gh.ghLog().split("\n").filter((l) => /^gh (api|label|issue comment)/.test(l));
  const storyRun = (status: string, finished: number, issue = "12") => {
    const runId = `run-${++n}`;
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    saveRun({ runId, flow: "issue-gitflow", task: "t", status, startedAt: iso(finished - 5), finishedAt: iso(finished), vars: { github_repo: TARGET, issue }, runDir, history: [], totalCostUsd: 0 } as unknown as RunSummary);
  };
  const seedStory = (issue = 12) => saveFindings([finding("a", { report: story(issue), lastSeen: iso(0) })], file);

  let savedHome: string | undefined;
  beforeEach(() => {
    gh = fakeGithub();
    savedHome = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = join(gh.tmp, "home"); // a fresh guard file, log and lock for every test
    file = join(gh.tmp, "monitor-findings.json");
    runsDir = join(gh.tmp, "runs");
    found = six();
    rec = [];
    over = {};
    reportTo = TARGET;
    cooldown = 0;
    n = 0;
    monitor = mk();
  });
  afterEach(() => {
    process.env.FACTORY_HOME = savedHome;
    gh.restore();
  });

  it("opens on six new findings, skips the stories, stays open over a restart and closes with on", async () => {
    const st = await check(0);
    expect(breakerNow()).toMatchObject({ reason: "findings", count: 6, minutes: 60, since: iso(0) });
    expect(st.lastActions.some((a) => a.includes("circuit breaker opened: 6 new findings within 60 minutes"))).toBe(true);
    expect(logLines().filter((l) => l.event === "breaker-open")).toHaveLength(1);
    expect(calls()).toEqual([]);
    expect(rec.filter((e) => e.event === "story-skipped")).toHaveLength(0);

    const st2 = await check(5);
    expect(calls()).toEqual([]);
    expect(st2.notes).toEqual(expect.arrayContaining([expect.stringContaining("the circuit breaker is open")]));
    expect(rec.filter((e) => e.event === "story-skipped" && e.reason === "breaker")).toHaveLength(6);
    await check(10);
    expect(rec.filter((e) => e.event === "story-skipped")).toHaveLength(6);
    expect(stored()).toHaveLength(6); // findings keep being recorded

    monitor = mk(); // a restart
    await check(15);
    expect(calls()).toEqual([]);
    expect(breakerNow()).toMatchObject({ since: iso(0), reason: "findings" });

    expect(switchStories("on", "cli", { now: at(20) })).toMatchObject({ changed: true, closed: true });
    expect(logLines().map((l) => l.event)).toEqual(["breaker-open", "on", "breaker-closed"]);
    await check(25);
    expect(breakerNow()).toBeUndefined();
    expect(calls().length).toBeGreaterThan(0); // stories are made again
  });

  it("opens again after on, when failed story runs pile up, and skips the owed stories again", async () => {
    await check(0);
    await check(5);
    switchStories("on", "cli", { now: at(6) });
    over = {};
    reportTo = TARGET;
    for (const m of [10, 11, 12]) storyRun("failed", m);
    // seed a story so the runs belong to a finding
    const list = stored().map((f, i) => (i === 0 ? { ...f, report: story(12) } : f));
    saveFindings(list, file);
    await check(15);
    expect(breakerNow()).toMatchObject({ reason: "failed_fixes", count: 3 });
    expect(stored()[0]!.fixFailed).toEqual({ count: 3, at: iso(12) });
    expect(logLines().filter((l) => l.event === "fix-failed")).toHaveLength(1);
    expect(logLines().filter((l) => l.event === "breaker-open")).toHaveLength(2);
  });

  it("a failed story run makes no finding and no story, but counts as the fix failed; F S F F does not open it", async () => {
    found = [];
    seedStory();
    storyRun("failed", 1);
    storyRun("succeeded", 2);
    storyRun("failed", 3);
    storyRun("failed", 4);
    await check(10);
    expect(stored()[0]!.fixFailed).toEqual({ count: 3, at: iso(4) });
    expect(breakerNow()).toBeUndefined();
    expect(logLines().filter((l) => l.event === "fix-failed").map((l) => l.count)).toEqual([3]);
    storyRun("failed", 11);
    await check(15);
    expect(breakerNow()).toMatchObject({ reason: "failed_fixes" });
  });

  it("does not open without report_to or while off", async () => {
    reportTo = undefined;
    await check(0);
    expect(breakerNow()).toBeUndefined();
    reportTo = TARGET;
    switchStories("off", "cli");
    await check(5);
    expect(loadGuard()).toMatchObject({ ok: true, data: { off: { by: "cli" } } });
    expect(breakerNow()).toBeUndefined();
    expect(logLines().some((l) => l.event === "breaker-open")).toBe(false);
  });

  it("does not count findings first seen in the quiet time after a restart, also after a second restart", async () => {
    cooldown = 10;
    const started = at(0);
    monitor = mk({ startedAt: started });
    await check(1);
    expect(breakerNow()).toBeUndefined();
    expect(stored().every((f) => f.quietStart)).toBe(true);
    monitor = mk({ startedAt: at(2) });
    await check(30);
    expect(breakerNow()).toBeUndefined();
    expect(existsSync(guardFile())).toBe(false);
  });

  it("opens nothing when a switch-on comes in between the decision and the commit", async () => {
    over = { beforeOpen: () => { switchStories("off", "cli", { now: at(1) }); switchStories("on", "cli", { now: at(1.5) }); } };
    monitor = mk();
    await check(1);
    expect(breakerNow()).toBeUndefined();
    expect(logLines().some((l) => l.event === "breaker-open")).toBe(false);
    over = {};
    monitor = mk();
    await check(2);
    expect(breakerNow()).toBeUndefined(); // the findings are from before the new `from`
  });

  it("a check with monitor.lock held by a live process makes no story and sets lastError", async () => {
    const lock = join(process.env.FACTORY_HOME!, "monitor.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), String(process.pid));
    const st = await check(0);
    expect(st.lastError).toBeDefined();
    expect(calls()).toEqual([]);
  });

  it("a queued story job never makes a queue-stalled finding, but the same job for another issue does", async () => {
    seedStory(12);
    const job = (issue: string) => ({ runId: `p${issue}`, enqueuedAt: iso(-60), kind: "run", githubRepo: TARGET, issue });
    const stalled = async (pending: object[]) => {
      const m = new Monitor(WatcherSchema.parse({ id: "mon", source: "monitor", every: "5m" }), {
        scheduler: { briefs: () => [], get: () => undefined, queue: () => ({ pending, active: [], concurrency: 2 }), lastStart: () => iso(-60) } as never,
        watchers: () => [], thresholds: config, log: () => {}, file, now: () => clock, guard: {},
      });
      clock = at(0);
      await m.tick();
      return stored().some((f) => f.detector === "queue-stalled");
    };
    expect(await stalled([job("12")])).toBe(false);
    expect(await stalled([job("13")])).toBe(true);
  });

  it("an earlier story of a finding is not looked at either", async () => {
    found = [];
    saveFindings([finding("a", { report: story(30), earlier: [{ repo: TARGET, issue: 12 }], lastSeen: iso(0) })], file);
    storyRun("failed", 3, "12");
    await check(10);
    expect(stored()[0]!.fixFailed).toEqual({ count: 1, at: iso(3) });
    expect(stored()[0]!.earlier).toEqual([{ repo: TARGET, issue: 12 }]);
  });
});
