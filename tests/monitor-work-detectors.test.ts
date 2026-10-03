import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary, type StepRecord } from "../src/engine/state.js";
import { buildHistory } from "../src/estimate.js";
import { runDetectors, type ActiveRun, type DetectorInput } from "../src/monitor/detectors.js";
import type { FindingInput } from "../src/monitor/findings.js";
import { ALL_DETECTORS, detectorInfo, WORK_DETECTORS } from "../src/monitor/work-detectors.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { labelLies, labelNames, Watcher } from "../src/queue/watcher.js";
import { fakeGithub } from "./helpers/fake-github.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const config = ConfigSchema.parse({}).monitor;
const withConfig = (patch: Record<string, unknown>) => ConfigSchema.parse({ monitor: patch }).monitor;

let n = 0;
const flowDef = (steps: object[] = [{ id: "build", type: "shell", run: "x", timeout_sec: 600 }], defaults: object = {}) => ({ name: "issue-gitflow", defaults, steps }) as never;
const rec = (over: Partial<StepRecord> = {}): StepRecord =>
  ({ id: "build", type: "shell", visit: 1, ok: true, output: "", startedAt: ago(MIN), durationMs: 1, logFile: "x", ...over }) as StepRecord;
const run = (over: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: `20261001-1200${String(++n).padStart(2, "0")}-abcd`, flow: "issue-gitflow", task: "t", status: "failed", startedAt: ago(10 * MIN), finishedAt: ago(5 * MIN),
    vars: { github_repo: "acme/app", issue: String(n) }, history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} }, runDir: "/tmp/none", flowDef: flowDef(), ...over,
  }) as unknown as RunSummary;

const input = (over: Partial<DetectorInput> = {}): DetectorInput => ({ now: NOW, asleep: false, config, runs: [], watchers: [], log: [], queue: { pending: [], active: [], concurrency: 2 }, monitorId: "mon", ...over });
const find = (name: string, over: Partial<DetectorInput> = {}): FindingInput[] => WORK_DETECTORS.find((d) => d.name === name)!.run(input(over));

describe("stuck run", () => {
  /** A running run at step `build` (timeout 600 s) that wrote its last log line `quiet` ms ago. */
  const stuck = (quiet: number, over: Partial<RunSummary> = {}, flow = flowDef()): ActiveRun => ({
    run: run({ status: "running", finishedAt: undefined, startedAt: ago(10 * HOUR), stepStartedAt: ago(10 * HOUR), state: { next: "build", steps: {}, visits: {} }, flowDef: flow, ...over }),
    lastWrite: ago(quiet),
  });
  const limit = 10 * MIN + 10 * MIN; // timeout 600 s + 10 minutes

  it("is found at timeout + 11 minutes, not at + 10", () => {
    expect(find("stuck-run", { active: [stuck(limit)] })).toEqual([]);
    const f = find("stuck-run", { active: [stuck(limit + MIN)] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "major", fingerprint: "stuck-run|acme/app|issue-gitflow|build", about: "foundry", evidence: { steps: ["build"], flows: ["issue-gitflow"], counts: { runs: 1, quiet_minutes: 21 } } });
  });

  it("uses the flow's default timeout, the no-timeout limit and the config", () => {
    const dflt = flowDef([{ id: "build", type: "shell", run: "x" }], { timeout_sec: 1800 });
    expect(find("stuck-run", { active: [stuck(40 * MIN, {}, dflt)] })).toEqual([]);
    expect(find("stuck-run", { active: [stuck(41 * MIN, {}, dflt)] })).toHaveLength(1);
    const none = flowDef([{ id: "build", type: "shell", run: "x" }]);
    expect(find("stuck-run", { active: [stuck(130 * MIN, {}, none)] })).toEqual([]);
    expect(find("stuck-run", { active: [stuck(131 * MIN, {}, none)] })).toHaveLength(1);
    expect(find("stuck-run", { active: [stuck(131 * MIN, {}, none)], config: withConfig({ stuck_run: { no_timeout_minutes: 200 } }) })).toEqual([]);
    expect(find("stuck-run", { active: [stuck(limit + MIN)], config: withConfig({ stuck_run: { extra_minutes: 30 } }) })).toEqual([]);
  });

  it("uses the longest child of a parallel step", () => {
    const par = flowDef([
      { id: "both", type: "parallel", steps: ["a", "b"] },
      { id: "a", type: "shell", run: "x", timeout_sec: 600, jump_only: true },
      { id: "b", type: "shell", run: "x", timeout_sec: 3600, jump_only: true },
    ]);
    const at = (quiet: number) => stuck(quiet, { state: { next: "both", steps: {}, visits: {} } }, par);
    expect(find("stuck-run", { active: [at(60 * MIN + 10 * MIN)] })).toEqual([]);
    expect(find("stuck-run", { active: [at(60 * MIN + 11 * MIN)] })).toHaveLength(1);
  });

  it("is quiet when asleep, counts from the wake-up, and ignores runs that are not running", () => {
    const old = stuck(5 * HOUR);
    expect(find("stuck-run", { active: [old], asleep: true })).toEqual([]);
    expect(find("stuck-run", { active: [old], wokeAt: ago(MIN) })).toEqual([]);
    expect(find("stuck-run", { active: [old], wokeAt: ago(limit + MIN) })).toHaveLength(1);
    expect(find("stuck-run", { active: [stuck(5 * HOUR, { status: "waiting" })] })).toEqual([]);
  });

  it("is quiet for a run resumed a minute ago whose logs are a day old, and for a new run without a log", () => {
    const resumed = stuck(24 * HOUR, { resumeLog: [{ at: ago(MIN), from: "build" }], stepStartedAt: undefined, startedAt: ago(30 * HOUR) });
    expect(find("stuck-run", { active: [resumed] })).toEqual([]);
    const fresh = (since: number): ActiveRun => ({ run: run({ status: "running", startedAt: ago(since), state: { next: null, steps: {}, visits: {} }, flowDef: flowDef([{ id: "build", type: "shell", run: "x" }]) }) });
    expect(find("stuck-run", { active: [fresh(100 * MIN)] })).toEqual([]);
    expect(find("stuck-run", { active: [fresh(131 * MIN)] })).toHaveLength(1);
  });

  it("does not judge a flow step, or a parallel step with a flow child", () => {
    const sub = flowDef([{ id: "build", type: "flow", flow: "x" }]);
    expect(find("stuck-run", { active: [stuck(5 * HOUR, {}, sub)] })).toEqual([]);
    const par = flowDef([{ id: "both", type: "parallel", steps: ["a", "b"] }, { id: "a", type: "shell", run: "x", jump_only: true }, { id: "b", type: "flow", flow: "x", jump_only: true }]);
    expect(find("stuck-run", { active: [stuck(5 * HOUR, { state: { next: "both", steps: {}, visits: {} } }, par)] })).toEqual([]);
  });

  it("keeps the same flow and step in two repositories apart", () => {
    const other = stuck(3 * HOUR, { vars: { github_repo: "acme/other", issue: "9" } });
    const f = find("stuck-run", { active: [stuck(3 * HOUR), other] });
    expect(f.map((x) => x.repo).sort()).toEqual(["acme/app", "acme/other"]);
  });

  it("gives one finding for two runs at one step, and shows no run id", () => {
    const f = find("stuck-run", { active: [stuck(3 * HOUR), stuck(4 * HOUR)] });
    expect(f).toHaveLength(1);
    expect(f[0]!.evidence.counts).toMatchObject({ runs: 2 });
    expect(JSON.stringify(f)).not.toMatch(/20261001-/);
  });
});

describe("same step failing", () => {
  const steps = [{ id: "baseline_tests", type: "shell", run: "x", on_failure: "baseline_failed" }, { id: "baseline_failed", type: "shell", run: "x" }, { id: "build", type: "shell", run: "x" }];
  const failedAt = (step: string, issue: string, over: Partial<RunSummary> = {}) =>
    run({ reason: `step "${step}" failed: boom`, vars: { github_repo: "acme/app", issue }, flowDef: flowDef(steps), history: [rec({ id: step, ok: false, error: "boom" })], ...over });

  it("finds 3 issues, not 2, and not 3 runs of one issue", () => {
    expect(find("same-step-failing", { runs: [failedAt("build", "1"), failedAt("build", "2")] })).toEqual([]);
    expect(find("same-step-failing", { runs: [failedAt("build", "1"), failedAt("build", "1"), failedAt("build", "1")] })).toEqual([]);
    const f = find("same-step-failing", { runs: ["1", "2", "3"].map((i) => failedAt("build", i)) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "major", about: "project", repo: "acme/app", fingerprint: "same-step-failing|acme/app|issue-gitflow|build", evidence: { counts: { issues: 3, runs: 3 }, steps: ["build"], lines: ["boom"] } });
    expect(JSON.stringify(f)).not.toMatch(/20261001-/);
  });

  it("keeps another repository, flow or step apart, and ignores runs outside the window", () => {
    const other = (over: Partial<RunSummary>, i: string) => failedAt("build", i, over);
    expect(find("same-step-failing", { runs: [failedAt("build", "1"), failedAt("build", "2"), other({ vars: { github_repo: "acme/other", issue: "3" } }, "3")] })).toEqual([]);
    expect(find("same-step-failing", { runs: [failedAt("build", "1"), failedAt("build", "2"), other({ flow: "other-flow" }, "3")] })).toEqual([]);
    expect(find("same-step-failing", { runs: [failedAt("build", "1"), failedAt("build", "2"), failedAt("baseline_tests", "3")] })).toEqual([]);
    expect(find("same-step-failing", { runs: [failedAt("build", "1"), failedAt("build", "2"), other({ finishedAt: ago(25 * HOUR) }, "3")] })).toEqual([]);
    expect(find("same-step-failing", { runs: ["1", "2", "3"].map((i) => other({ finishedAt: ago(25 * HOUR) }, i)), config: withConfig({ same_step_failing: { within_hours: 48 } }) })).toHaveLength(1);
    expect(find("same-step-failing", { runs: ["1", "2", "3"].map((i) => failedAt("build", i)), config: withConfig({ same_step_failing: { issues: 4 } }) })).toEqual([]);
  });

  it("names the step that really failed, not its on_failure handler", () => {
    const viaHandler = (i: string) => run({ reason: 'step "baseline_failed" failed: boom', vars: { github_repo: "acme/app", issue: i }, flowDef: flowDef(steps), history: [rec({ id: "baseline_tests", ok: false, error: "boom" }), rec({ id: "baseline_failed", ok: false, error: "boom" })] });
    const f = find("same-step-failing", { runs: ["1", "2", "3"].map(viaHandler) });
    expect(f).toHaveLength(1);
    expect(f[0]!.fingerprint).toBe("same-step-failing|acme/app|issue-gitflow|baseline_tests");
  });

  it("does not count a step that failed and was fixed", () => {
    const fixed = (status: "succeeded" | "running", i: string) => failedAt("build", i, { status, reason: undefined, history: [rec({ id: "build", ok: false, error: "boom" }), rec({ id: "build", ok: true })] });
    expect(find("same-step-failing", { runs: [fixed("succeeded", "1"), fixed("running", "2"), fixed("succeeded", "3")] })).toEqual([]);
  });

  it("does not count a rejected approval, the run budget, an interrupted run or a cancelled run", () => {
    const bad = (over: Partial<RunSummary>, i: string) => failedAt("build", i, over);
    const runs = [
      bad({ reason: 'step "build" failed: rejected', history: [rec({ id: "build", ok: false, error: "rejected" })] }, "1"),
      bad({ reason: "run budget of $5 reached", history: [rec({ id: "build", ok: false, error: "x" })] }, "2"),
      bad({ reason: "interrupted — resume it to continue" }, "3"),
      bad({ status: "cancelled" }, "4"),
    ];
    expect(find("same-step-failing", { runs })).toEqual([]);
  });
});

describe("label and run disagree", () => {
  const L = labelNames(WatcherSchema.parse({ id: "w", github_repo: "acme/app" }));
  const r = (status: RunSummary["status"], reason?: string) => run({ status, reason });

  it("lies exactly when the label does not fit the newest run", () => {
    const table: [string, string | undefined, boolean, RunSummary | undefined, string | undefined][] = [
      ["working with a running run", L.working, false, r("running"), undefined],
      ["working with a succeeded run", L.working, false, r("succeeded"), "succeeded"],
      ["working with a failed run", L.working, false, r("failed"), "failed"],
      ["working with an interrupted run", L.working, false, r("failed", "interrupted — resume it"), undefined],
      ["working with a run paused by a limit", L.working, false, r("stopped", "usage limit reached"), undefined],
      ["working with a run that asks questions", L.working, false, r("stopped", "stopped at step ask"), "stopped"],
      ["working with a cancelled run", L.working, false, r("cancelled"), undefined],
      ["failed with a failed run", L.failed, false, r("failed"), undefined],
      ["failed with a cancelled run", L.failed, false, r("cancelled"), undefined],
      ["waiting with a cancelled run", L.waiting, false, r("cancelled"), "cancelled"],
      ["failed with a succeeded run", L.failed, false, r("succeeded"), "succeeded"],
      ["waiting with a waiting run", L.waiting, false, r("waiting"), undefined],
      ["waiting with a failed run", L.waiting, false, r("failed"), "failed"],
      ["needs-info with a stopped run", L.needsInfo, false, r("stopped", "stopped at step ask"), undefined],
      ["done with a failed run (left alone)", L.done, false, r("failed"), undefined],
      ["done while busy (left alone)", L.done, true, r("running"), undefined],
      ["no label", undefined, false, r("failed"), undefined],
      ["a label that is not a status label", "bug", false, r("failed"), undefined],
      ["no run", L.failed, false, undefined, undefined],
      ["busy with working", L.working, true, r("failed"), undefined],
      ["busy with failed", L.failed, true, r("failed"), "working"],
      ["busy without a run file", L.waiting, true, undefined, "working"],
    ];
    for (const [name, status, busy, run_, want] of table) expect(labelLies(status, busy, run_, L)?.run, name).toBe(want);
    expect(labelLies(L.failed, false, r("succeeded"), L)).toEqual({ label: "failed", run: "succeeded" });
  });

  const entry = (checks: number, over: Record<string, unknown> = {}) => ({
    cfg: WatcherSchema.parse({ id: "w", github_repo: "acme/app" }), status: { id: "w", lastActions: [], ...over },
    issues: [{ issue: 12, title: "t", labelOff: { checks, label: "failed", run: "succeeded" } }, { issue: 13, title: "u" }],
  });

  it("is found at 4 checks, not at 3", () => {
    expect(find("label-mismatch", { watchers: [entry(3)] })).toEqual([]);
    const f = find("label-mismatch", { watchers: [entry(4)] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "minor", fingerprint: "label-mismatch|w", repo: "acme/app", evidence: { counts: { issues: 1, checks: 4 }, lines: ["#12: the label says failed, the run is succeeded"], watchers: ["w"] } });
    expect(find("label-mismatch", { watchers: [entry(4)], config: withConfig({ label_mismatch: { checks: 4 } }) })).toEqual([]);
  });

  it("is skipped while a restart waits, and for a watcher in error", () => {
    expect(find("label-mismatch", { watchers: [entry(9)], restart: { why: "new_version", since: ago(MIN) } })).toEqual([]);
    expect(find("label-mismatch", { watchers: [entry(9, { lastError: "boom" })] })).toEqual([]);
  });

  describe("with a real watcher", () => {
    let gh: ReturnType<typeof fakeGithub>;
    beforeEach(() => (gh = fakeGithub()));
    afterEach(() => gh.restore());
    const issue = (label: string) => (process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 7, title: "seven", state: "OPEN", labels: [{ name: "claude-factory" }, { name: label }] }]));
    const make = () => {
      const runsDir = join(gh.tmp, "runs");
      const s = run({ status: "succeeded", reason: undefined, vars: { github_repo: "acme/app", issue: "7" }, runDir: join(runsDir, "r7"), finishedAt: new Date().toISOString() });
      mkdirSync(s.runDir, { recursive: true });
      saveRun(s);
      const w = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", flow: "issue-gitflow" }), { scheduler: new Scheduler({ runsDir, config: () => ConfigSchema.parse({}) }), runsDir, repo: gh.tmp, log: () => {} });
      return w;
    };
    const at = (w: Watcher) => find("label-mismatch", { watchers: [{ cfg: w.cfg, status: w.status, issues: w.tracked }] });

    it("4 checks with a label that never changes give the finding; a fitting label clears it", async () => {
      issue("factory:waiting-approval"); // the fake gh never changes labels
      const w = make();
      for (let i = 0; i < 3; i++) await w.tick();
      expect(at(w)).toEqual([]);
      await w.tick();
      expect(at(w)).toHaveLength(1);
      issue("factory:done");
      await w.tick();
      expect(at(w)).toEqual([]);
    });
  });
});

describe("lock without owner", () => {
  it("finds an area lock whose owner is gone for more than 10 minutes", () => {
    const lock = (min: number) => ({ repo: "acme_app", areas: ["src/engine", "docs"], at: ago(5 * HOUR), orphanSince: ago(min * MIN) });
    expect(find("orphan-lock", { areaLocks: [lock(9)] })).toEqual([]);
    const f = find("orphan-lock", { areaLocks: [lock(11)] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "major", fingerprint: "orphan-lock|area|acme_app", about: "foundry", evidence: { counts: { locks: 1, minutes: 11 } } });
    expect(JSON.stringify(f)).not.toMatch(/20261001-/);
    expect(f[0]!.evidence.lines).toEqual(["src/engine", "docs"]);
    expect(find("orphan-lock", { areaLocks: [lock(11)], config: withConfig({ orphan_lock: { minutes: 20 } }) })).toEqual([]);
  });

  it("ignores a lock that has an owner, and time before the wake-up", () => {
    expect(find("orphan-lock", { areaLocks: [{ repo: "r", areas: ["a"], at: ago(HOUR) }] })).toEqual([]);
    const l = { repo: "r", areas: ["a"], at: ago(HOUR), orphanSince: ago(30 * MIN) };
    expect(find("orphan-lock", { areaLocks: [l], wokeAt: ago(2 * MIN) })).toEqual([]);
    expect(find("orphan-lock", { areaLocks: [l], asleep: true })).toEqual([]);
  });

  it("cleans the areas in the evidence", () => {
    const f = find("orphan-lock", { areaLocks: [{ repo: "r", areas: ["/Users/me/work/project/src"], at: ago(HOUR), orphanSince: ago(30 * MIN) }] });
    expect(f[0]!.evidence.lines).toEqual(["<path>"]);
  });

  it("finds a run lock held by an ended run, not while it runs", () => {
    const entry = (status: RunSummary["status"], ended: number) => {
      const r = run({ status, finishedAt: ago(ended) });
      return { r, queue: { pending: [], active: [{ runId: r.runId, lockKey: "w:acme/app#1" }], concurrency: 2 } as never };
    };
    const ended = entry("failed", 11 * MIN);
    const f = find("orphan-lock", { queue: ended.queue, active: [{ run: ended.r }] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fingerprint: "orphan-lock|run|issue-gitflow" });
    expect(JSON.stringify(f)).not.toMatch(/20261001-/);
    const fresh = entry("failed", 9 * MIN);
    expect(find("orphan-lock", { queue: fresh.queue, active: [{ run: fresh.r }] })).toEqual([]);
    const live = entry("running", 3 * HOUR);
    expect(find("orphan-lock", { queue: live.queue, active: [{ run: live.r }] })).toEqual([]);
    expect(find("orphan-lock", { queue: ended.queue, active: [{ run: ended.r }], config: withConfig({ orphan_lock: { minutes: 30 } }) })).toEqual([]);
  });
});

describe("queue not moving", () => {
  const job = (over: object = {}) => ({ runId: "q1", enqueuedAt: ago(2 * HOUR), kind: "run" as const, ...over });
  const q = (pending: object[], active = 0, concurrency = 2) => ({ pending, active: Array.from({ length: active }, (_, i) => ({ runId: `a${i}` })), concurrency }) as never;

  it("is found at 16 minutes, not at 14", () => {
    expect(find("queue-stalled", { queue: q([job()]), lastStart: ago(14 * MIN) })).toEqual([]);
    const f = find("queue-stalled", { queue: q([job()]), lastStart: ago(16 * MIN) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", fingerprint: "queue-stalled", evidence: { counts: { queued: 1, free_slots: 2, stalled_minutes: 16 } } });
    expect(find("queue-stalled", { queue: q([job()]), lastStart: ago(16 * MIN), config: withConfig({ queue_stalled: { minutes: 30 } }) })).toEqual([]);
  });

  it("is quiet with full slots, when every job waits for a lock, after a recent start, a recent job, or when asleep", () => {
    const old = ago(HOUR);
    expect(find("queue-stalled", { queue: q([job()], 2), lastStart: old })).toEqual([]);
    expect(find("queue-stalled", { queue: q([job({ waitingFor: "a0" })], 1), lastStart: old })).toEqual([]);
    expect(find("queue-stalled", { queue: q([job()]), lastStart: ago(MIN) })).toEqual([]);
    expect(find("queue-stalled", { queue: q([job({ enqueuedAt: ago(MIN) })]), lastStart: old })).toEqual([]);
    expect(find("queue-stalled", { queue: q([job()]), lastStart: old, asleep: true })).toEqual([]);
    expect(find("queue-stalled", { queue: q([]), lastStart: old })).toEqual([]);
    expect(find("queue-stalled", { queue: q([job()]) })).toEqual([]);
  });
});

describe("restart overdue", () => {
  it("is found after 2 hours and 1 minute, not before", () => {
    expect(find("restart-overdue", { restart: { why: "new_version", since: ago(2 * HOUR) } })).toEqual([]);
    const f = find("restart-overdue", { restart: { why: "new_version", since: ago(2 * HOUR + MIN) } });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "major", fingerprint: "restart-overdue", evidence: { counts: { waited_minutes: 121 } } });
    expect(find("restart-overdue", { restart: { why: "new_version", since: ago(2 * HOUR + MIN) }, config: withConfig({ restart_overdue: { hours: 3 } }) })).toEqual([]);
  });

  it("is not found for a moved data folder or without a restart", () => {
    expect(find("restart-overdue", { restart: { why: "data_folder", since: ago(9 * HOUR) } })).toEqual([]);
    expect(find("restart-overdue")).toEqual([]);
  });

  it("makes the watcher-silent detector quiet while a restart waits", () => {
    const watchers = [{ cfg: WatcherSchema.parse({ id: "w", github_repo: "acme/app", every: "5m" }), status: { id: "w", lastActions: [], lastTick: ago(5 * HOUR) } }];
    const silent = ALL_DETECTORS.find((d) => d.name === "watcher-silent")!;
    expect(silent.run(input({ watchers }))).toHaveLength(1);
    expect(silent.run(input({ watchers, restart: { why: "new_version", since: ago(HOUR) } }))).toEqual([]);
  });
});

describe("develop is red", () => {
  const visit = (ok: boolean, minutesAgo: number, over: Partial<StepRecord> = {}) => rec({ id: "test_develop", ok, startedAt: ago(minutesAgo * MIN), durationMs: 1000, ...over });
  const story = (history: StepRecord[], over: Partial<RunSummary> = {}) => run({ history, ...over });

  it("finds two failed visits in one run, and one failure each in two stories in a row", () => {
    const f = find("develop-red", { runs: [story([visit(false, 60), visit(false, 30)])] });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "critical", about: "project", repo: "acme/app", fingerprint: "develop-red|acme/app", evidence: { counts: { failures_in_a_row: 2, stories: 1 }, steps: ["test_develop"] } });
    expect(f[0]!.evidence.lines).toBeUndefined();
    const two = find("develop-red", { runs: [story([visit(false, 60)]), story([visit(false, 30)])] });
    expect(two[0]!.evidence.counts).toMatchObject({ failures_in_a_row: 2, stories: 2 });
    expect(JSON.stringify(two)).not.toMatch(/20261001-/);
  });

  it("is not found for fail then pass, fail pass fail, or one failure", () => {
    expect(find("develop-red", { runs: [story([visit(false, 60), visit(true, 30)])] })).toEqual([]);
    expect(find("develop-red", { runs: [story([visit(false, 90), visit(true, 60), visit(false, 30)])] })).toEqual([]);
    expect(find("develop-red", { runs: [story([visit(false, 30)])] })).toEqual([]);
    expect(find("develop-red", { runs: [story([visit(false, 90), visit(false, 60), visit(true, 30)])] })).toEqual([]);
  });

  it("ignores cancelled runs, keeps repositories apart and ignores records before the look-back", () => {
    expect(find("develop-red", { runs: [story([visit(false, 60), visit(false, 30)], { status: "cancelled" })] })).toEqual([]);
    expect(find("develop-red", { runs: [story([visit(false, 60)]), story([visit(false, 30)], { vars: { github_repo: "acme/other", issue: "1" } })] })).toEqual([]);
    expect(find("develop-red", { runs: [story([visit(false, 26 * 60), visit(false, 25 * 60), visit(false, 30)])] })).toEqual([]);
    expect(find("develop-red", { runs: [story([visit(false, 26 * 60), visit(false, 25 * 60), visit(false, 30)])], config: withConfig({ develop_red: { within_hours: 48 } }) })).toHaveLength(1);
  });

  it("uses the number of failures from the config", () => {
    const runs = [story([visit(false, 90), visit(false, 60), visit(false, 30)])];
    expect(find("develop-red", { runs, config: withConfig({ develop_red: { failures: 3 } }) })).toHaveLength(1);
    expect(find("develop-red", { runs, config: withConfig({ develop_red: { failures: 4 } }) })).toEqual([]);
  });
});

describe("slow step", () => {
  const flow = flowDef([{ id: "a", type: "shell", run: "x" }, { id: "b", type: "shell", run: "x" }]);
  const done = (b: number, over: Partial<RunSummary> = {}) =>
    run({ status: "succeeded", flowDef: flow, history: [rec({ id: "a", durationMs: 5 * MIN }), rec({ id: "b", durationMs: b * MIN, startedAt: ago(40 * MIN) })], ...over });
  const history = buildHistory([10, 10, 12, 15, 20].map((b) => done(b)));
  const slow = (endedMinAgo: number) => done(60, { history: [rec({ id: "a", durationMs: 5 * MIN }), rec({ id: "b", durationMs: 60 * MIN, startedAt: ago(endedMinAgo * MIN + 60 * MIN) })] });

  it("finds three slow visits, not two", () => {
    expect(find("slow-step", { runs: [slow(10), slow(20)], history })).toEqual([]);
    const f = find("slow-step", { runs: [slow(10), slow(20), slow(30)], history });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "minor", fingerprint: "slow-step|acme/app|issue-gitflow|b", about: "foundry", evidence: { counts: { slow_visits: 3, slowest_minutes: 60, usual_minutes: 12 }, steps: ["b"] } });
  });

  it("does not count a visit outside the window, and needs a history", () => {
    expect(find("slow-step", { runs: [slow(10), slow(20), slow(25 * 60)], history })).toEqual([]);
    expect(find("slow-step", { runs: [slow(10), slow(20), slow(30)] })).toEqual([]);
    expect(find("slow-step", { runs: [slow(10), slow(20), slow(30)], history: new Map() })).toEqual([]);
  });

  it("uses the factor and the number of times from the config", () => {
    const runs = [slow(10), slow(20), slow(30)];
    expect(find("slow-step", { runs, history, config: withConfig({ slow_step: { times: 4 } }) })).toEqual([]);
    expect(find("slow-step", { runs, history, config: withConfig({ slow_step: { factor: 6 } }) })).toEqual([]);
  });
});

describe("descriptions", () => {
  it("every detector has a unique name and a description of two sentences, at most 240 characters", () => {
    const info = detectorInfo();
    expect(info).toHaveLength(14);
    expect(new Set(info.map((d) => d.name)).size).toBe(14);
    expect(info.map((d) => d.name)).toContain("detector-failed");
    for (const d of info) {
      expect(d.description.length, d.name).toBeLessThanOrEqual(240);
      expect(d.description.match(/[.!?](?:\s|$)/g)?.length, d.name).toBe(2);
    }
  });

  it("a detector that throws is still reported by name", () => {
    const bad = [{ name: "bad", description: "x. y.", run: () => { throw new Error("x"); } }];
    expect(runDetectors(bad, input())[0]!.fingerprint).toBe("detector-failed|bad");
  });
});

describe("what is normal is never a finding (real watcher, 5 checks)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let runsDir: string;
  beforeEach(() => {
    gh = fakeGithub();
    runsDir = join(gh.tmp, "runs");
  });
  afterEach(() => gh.restore());

  const flow = flowDef([{ id: "ask", type: "shell", run: "x" }, { id: "approve_plan", type: "approval", message: "m" }, { id: "wait_for_merge", type: "shell", run: "x" }]);
  const issue = (number: number, label?: string, body = "") => ({ number, title: `issue ${number}`, state: "OPEN", body, labels: [{ name: "claude-factory" }, ...(label ? [{ name: label }] : [])] });
  const save = (issueNo: number, over: Partial<RunSummary>) => {
    const s = run({ vars: { github_repo: "acme/app", issue: String(issueNo) }, flowDef: flow, finishedAt: new Date().toISOString(), startedAt: new Date(Date.now() - MIN).toISOString(), ...over });
    s.runDir = join(runsDir, `r${issueNo}`);
    mkdirSync(s.runDir, { recursive: true });
    saveRun(s);
  };
  /** Five checks, then every detector on what the watcher saw. */
  const judge = async (over: Record<string, unknown> = {}) => {
    const scheduler = new Scheduler({ runsDir, config: () => ConfigSchema.parse({}) });
    const w = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", flow: "issue-gitflow", wait_for_dependencies: true, exclude_labels: ["other-flow"], ...over }), { scheduler, runsDir, repo: gh.tmp, log: () => {} });
    for (let i = 0; i < 5; i++) await w.tick();
    const runs = scheduler.list(100);
    const now = new Date(Date.now() + 5 * MIN);
    const found = runDetectors(ALL_DETECTORS, input({ now, runs, watchers: [{ cfg: w.cfg, status: w.status, issues: w.tracked }], queue: scheduler.queue(), lastStart: scheduler.lastStart(), history: new Map() }));
    expect(w.tracked.length).toBeGreaterThan(0);
    return found;
  };

  it("a run that waits for a person", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(1, "factory:waiting-approval"), issue(2, "factory:needs-info")]);
    save(1, { status: "waiting", reason: "m", waiting: { stepId: "approve_plan", message: "m", since: new Date().toISOString() }, state: { next: "approve_plan", steps: {}, visits: {} } });
    save(2, { status: "stopped", reason: 'stopped at step "ask": questions', state: { next: "ask", steps: {}, visits: {} } });
    expect(await judge()).toEqual([]);
  });

  it("a usage limit that resets by itself", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(3, "factory:working")]);
    save(3, { status: "stopped", reason: "usage limit reached — continues automatically after the limit resets (or resume it)", history: [rec({ id: "ask", ok: false, limited: true, error: "usage limit reached", durationMs: 4 * HOUR })], state: { next: "ask", steps: {}, visits: {} } });
    expect(await judge()).toEqual([]);
  });

  it("a sign-out", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(4, "factory:working")]);
    save(4, { status: "stopped", reason: "signed out — sign in again, then resume the run", history: [rec({ id: "ask", ok: false, limited: true, error: "signed out — sign in" })], state: { next: "ask", steps: {}, visits: {} } });
    expect(await judge()).toEqual([]);
  });

  it("a story that waits for a dependency", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(5, undefined, "### Depends on\n#6\n"), issue(6, "other-flow")]);
    expect(await judge()).toEqual([]);
  });

  it("a story held by an open release pull request, and a run stopped at wait_for_merge", async () => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(7), issue(8, "factory:working")]);
    process.env.FAKE_GH_PRS = JSON.stringify([{ number: 9, headRefName: "factory/release", state: "OPEN", title: "release" }]);
    save(8, { status: "stopped", reason: 'stopped at step "wait_for_merge"', state: { next: "wait_for_merge", steps: {}, visits: {} } });
    expect(await judge({ pause_while_pr_open: "factory/" })).toEqual([]);
  });
});
