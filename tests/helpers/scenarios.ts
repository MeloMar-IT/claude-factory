import { ConfigSchema, type Config } from "../../src/config.js";
import type { RunSummary } from "../../src/engine/state.js";
import { nextStep, runNextStep, type NextStep, type NextWho } from "../../src/next-step.js";
import type { ApiContext } from "../../src/server/server.js";

// Real situations, each with the sentence and action the owner should see, and what the screens show.
// Used by tests/scenarios.test.ts and tests/clarity.test.ts. No server, no GitHub: a stub context.

export const NOW = new Date("2026-10-01T12:00:00Z");
export const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
export const cfg = (watchers: Record<string, unknown>[] = []): Config => ConfigSchema.parse({ watchers });
export const REPO = "acme/app";
export const issuesWatcher = { id: "a", github_repo: REPO, flow: "github-issue" };
const issueUrl = (n: number) => `https://github.com/${REPO}/issues/${n}`;

export const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, flow: "github-issue", flowDef: { steps: [] }, task: `task ${runId}`, vars: { github_repo: REPO }, repo: "/x",
  status: "failed", reason: "boom", runDir: "/tmp/none", startedAt: ago(1), finishedAt: ago(1), history: [],
  state: { next: null, steps: {}, visits: {} }, totalCostUsd: 0, ...over,
}) as never as RunSummary;

export type Tracked = { watcher: unknown; status: Record<string, unknown>; issues: { issue: number; title: string; runId?: string }[] };

/** What the stub context knows. */
export interface World {
  config: Config;
  runs: RunSummary[];
  tracked: Tracked[];
  /** Run ids in the scheduler's active list. */
  active?: string[];
  /** Run ids queued without a run file yet. */
  pending?: string[];
  restart?: { why: "new_version" | "data_folder"; since: string };
}

export const hold = (next: NextStep, extra: Record<string, unknown> = {}) => ({ issue: next.issue, reason: next.text, next, ...extra });

/** A watcher (the first of `config`) with its holds, issues and status. It has finished a good check. */
export const track = (config: Config, holds: unknown[], issues: Tracked["issues"], status: Record<string, unknown> = {}, i = 0): Tracked =>
  ({ watcher: config.watchers[i], status: { id: config.watchers[i]!.id, lastActions: [], holds, lastOk: ago(0.001), ...status }, issues });

export function scenarioCtx(w: World): ApiContext {
  return {
    config: () => w.config,
    restart: w.restart,
    scheduler: {
      list: (n = 100) => w.runs.slice(0, n),
      get: (id: string) => w.runs.find((r) => r.runId === id),
      briefs: () => w.runs.map((r) => ({ runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, source: r.source, runDir: r.runDir })),
      queue: () => ({ pending: (w.pending ?? []).map((runId) => ({ runId, kind: "run", enqueuedAt: ago(0.01) })), active: (w.active ?? []).map((runId) => ({ runId })) }),
      isActive: (id: string) => (w.active ?? []).includes(id),
    },
    watchers: { tracked: () => w.tracked },
  } as unknown as ApiContext;
}

export interface Expect {
  who: NextWho;
  action: string;
  text: string;
  /** Is the item on Your turn? */
  yourTurn: boolean;
  /** The buttons of the item, without Dismiss. */
  buttons: string[];
  /** The text of the link button (when listed). */
  link?: string;
  dismissable?: boolean;
}

export interface Scenario {
  id: string;
  /** The real situation in a few words. */
  realCase: string;
  /** Where the case is recorded; "kind only" when no dated case is. */
  source: string;
  /** One of the five scenarios of the usability check. */
  sheet?: boolean;
  world: World;
  /** The record of the situation. */
  record: () => NextStep;
  expect: Expect;
}

const c = cfg([issuesWatcher]);
const story = (n: number) => ({ issue: n, title: `Story ${n}` });
const base = (n: number) => ({ repo: REPO, issue: n, title: `Story ${n}` });
const data = (n: number, more: Record<string, unknown> = {}) => ({ watched: true, issueUrl: issueUrl(n), ...more });

/** A story with one hold. */
function held(next: NextStep, extra: { status?: Record<string, unknown>; runs?: RunSummary[]; active?: string[] } = {}): World {
  return { config: c, runs: extra.runs ?? [], active: extra.active, tracked: [track(c, [hold(next)], next.issue ? [story(next.issue)] : [], extra.status)] };
}

/** A story whose newest run is the record (no hold). */
function ranRecord(r: RunSummary, n: number): { world: World; record: () => NextStep } {
  const o = { watched: true, failedLabel: "factory:failed", issueUrl: issueUrl(n), title: `Story ${n}` };
  return { world: { config: c, runs: [r], tracked: [track(c, [], [{ ...story(n), runId: r.runId }])] }, record: () => runNextStep(r, o) };
}

const questions = nextStep("questions", base(42), data(42, { questions: 1 }));
const plan = nextStep("approve_plan", base(43), data(43));
const failedRun = run("r44", {
  vars: { github_repo: REPO, issue: "44" }, status: "failed",
  reason: 'step "baseline_failed" failed: exit code 1\n\nThe tests already fail on feature/44 before any change — not starting.',
});
const failed = ranRecord(failedRun, 44);
const limitRun = run("r45", {
  vars: { github_repo: REPO, issue: "45" }, status: "stopped", finishedAt: ago(0.01),
  reason: "usage limit reached: You've hit your session limit · resets 4:20pm (Europe/Amsterdam) — continues automatically after the limit resets (or resume it)",
});
const limit = nextStep("usage_limit", base(45), { ...data(45), runId: "r45", reason: limitRun.reason, finishedAt: limitRun.finishedAt });
const signedRun = run("r55", {
  vars: { github_repo: REPO, issue: "55" }, status: "stopped", finishedAt: ago(0.01),
  reason: 'signed out — the Claude Code login has expired. Sign in again: run "claude" in a terminal and type /login. The run continues by itself after that.',
});
const signed = runNextStep(signedRun, { watched: true, issueUrl: issueUrl(55), title: "Story 55" });
const closedRun = run("r8", { vars: { github_repo: REPO, issue: "8" }, status: "running", finishedAt: undefined, startedAt: ago(0.05) });
const closed = nextStep("closed_elsewhere", base(8), { watched: true, issueUrl: issueUrl(8), runId: "r8" });
const interrupted = ranRecord(run("r46", { vars: { github_repo: REPO, issue: "46" }, status: "failed", reason: "interrupted — resume it to continue" }), 46);
const workingRun = run("r47", { vars: { github_repo: REPO, issue: "47" }, status: "running", finishedAt: undefined, startedAt: ago(0.02) });
const working = { world: { config: c, runs: [workingRun], active: ["r47"], tracked: [track(c, [], [{ ...story(47), runId: "r47" }])] } as World, record: () => runNextStep(workingRun, { watched: true, issueUrl: issueUrl(47), title: "Story 47" }) };
const watcherErr = nextStep("watcher_error", { repo: REPO }, { reason: "cannot access acme/app with gh: HTTP 401" });
const pr = { number: 9, url: `https://github.com/${REPO}/pull/9` };
const releasePr = (n?: number) => nextStep("release", { repo: REPO, issue: n, title: n ? `Story ${n}` : "" }, { watched: true, pr });
const scheduled = nextStep("release", base(48), { watched: true, releaseAt: "17:00" });
const blocked = [61, 11, 64].map((n) => nextStep("questions", base(n), data(n, { questions: 1 })));
const waits = nextStep("dependency", base(21), { watched: true, issueUrl: issueUrl(21), blockers: [61, 11, 64].map((issue, i) => ({ issue, next: blocked[i] })) });
const handRun = run("r50", { vars: {}, source: "ui", status: "waiting", finishedAt: undefined, waiting: { stepId: "gate", message: "Delete the old data?", since: ago(0.2) } });
const budget = run("r49", { vars: { github_repo: REPO, issue: "49" }, status: "stopped", finishedAt: ago(0.01), reason: "daily budget reached" });

export const SCENARIOS: Scenario[] = [
  {
    id: "questions", sheet: true, realCase: "The Foundry asks questions before it builds an issue", source: "issue #42 (Q1 comment)",
    world: held(questions), record: () => questions,
    expect: { who: "You", action: "Answer 1 question", text: "It has questions before it starts — answer 1 question on the issue, or reply /defaults to go with the recommendations.", yourTurn: true, buttons: ["Show questions"], link: "Issue #42 ↗", dismissable: true },
  },
  {
    id: "approve-plan", sheet: true, realCase: "A risky plan waits for the owner's decision", source: "issue #42 (plan with risk gate)",
    world: held(plan), record: () => plan,
    expect: { who: "You", action: "Reply /approve or /reject", text: "The plan is risky and waits for your decision — reply /approve to start coding (optionally with notes), or /reject followed by what to change — it then plans again.", yourTurn: true, buttons: ["Show plan"], link: "Issue #43 ↗", dismissable: true },
  },
  {
    id: "failed-baseline", sheet: true, realCase: "The tests already fail before any change, so the run stops", source: "issue #42 (baseline_failed, Factory_ERROR comment)",
    world: failed.world, record: failed.record,
    expect: { who: "Something is wrong", action: "Look at the output of the step and fix the cause, then remove the `factory:failed` label to start over", text: "The step baseline_failed failed: its command ended with an error — look at the output of the step and fix the cause, then remove the `factory:failed` label to start over.", yourTurn: true, buttons: ["Retry", "Retry with a hint…"], link: "Issue #44 ↗", dismissable: true },
  },
  {
    id: "session-limit", sheet: true, realCase: "The session limit pauses the run until it resets", source: "changelog (hotfix: session limit pauses like a usage limit)",
    world: held(limit, { runs: [limitRun] }), record: () => limit,
    expect: { who: "A time limit", action: "Nothing — it continues by itself", text: "The usage limit is reached — nothing to do, it is tried again after the limit resets.", yourTurn: false, buttons: [] },
  },
  {
    id: "signed-out", sheet: true, realCase: "The agent is signed out; the owner has to sign in again", source: "changelog (hotfix: pause when the agent is signed out)",
    world: held(signed, { runs: [signedRun] }), record: () => signed,
    expect: { who: "You", action: 'Sign in again: run "claude" in a terminal and type /login', text: 'Claude Code is signed out (its login has expired) — sign in again: run "claude" in a terminal and type /login. It continues by itself after that.', yourTurn: true, buttons: [], link: "Issue #55 ↗", dismissable: true },
  },
  {
    id: "closed-while-working", realCase: "An issue is closed on GitHub while its run is still working", source: "changelog (hotfix: issues closed on GitHub)",
    world: { config: c, runs: [closedRun], active: ["r8"], tracked: [track(c, [hold(closed)], [])] }, record: () => closed,
    expect: { who: "You", action: "Cancel the run if the work is no longer wanted", text: "#8 was closed on GitHub but its run is still working — cancel the run if the work is no longer wanted.", yourTurn: true, buttons: [], link: "Run page", dismissable: true },
  },
  {
    id: "interrupted", realCase: "The server restarted during a run", source: "kind only",
    world: interrupted.world, record: interrupted.record,
    expect: { who: "Foundry", action: "Nothing — it continues by itself", text: "The run was interrupted — nothing to do, it resumes at the next check.", yourTurn: false, buttons: [] },
  },
  {
    id: "watcher-error", realCase: "A watcher cannot reach GitHub", source: "issue #56 (cannot access … with gh)",
    world: { config: c, runs: [], tracked: [track(c, [], [], { lastError: "cannot access acme/app with gh: HTTP 401", errorSince: ago(0.1) })] }, record: () => watcherErr,
    expect: { who: "Something is wrong", action: "Check the network and `gh auth status`", text: "The watcher for acme/app can't reach GitHub: GitHub did not answer or did not let it in — check the network and `gh auth status`.", yourTurn: true, buttons: [], link: "Watchers page", dismissable: false },
  },
  {
    id: "working", realCase: "A story is being built", source: "kind only",
    world: working.world, record: working.record,
    expect: { who: "Foundry", action: "Nothing — it continues by itself", text: "It is being worked on — nothing to do, it continues by itself.", yourTurn: false, buttons: [] },
  },
  {
    id: "release-schedule", realCase: "Finished work waits for the scheduled release", source: "kind only",
    world: held(scheduled), record: () => scheduled,
    expect: { who: "Foundry", action: "Nothing — it ships with the 17:00 release", text: "It is finished and waits for the 17:00 release — nothing to do, it ships with the 17:00 release.", yourTurn: false, buttons: [] },
  },
  {
    id: "release-pr", realCase: "The release pull request waits to be merged", source: "kind only",
    world: { config: c, runs: [], tracked: [track(c, [hold(releasePr()), hold(releasePr(1)), hold(releasePr(2))], [story(1), story(2)], { pausedBy: { ...pr, title: "Release 2 Oct" } })] }, record: () => releasePr(),
    expect: { who: "You", action: "Merge the release pull request #9", text: "Release pull request #9 is not merged yet — merge the release pull request #9 to continue.", yourTurn: true, buttons: [], link: "Release pull request #9 ↗", dismissable: true },
  },
  {
    id: "waits-for-stories", realCase: "A story waits for three stories that wait for the owner", source: "issue #21 and its blockers (#61, #11, #64)",
    world: { config: c, runs: [], tracked: [track(c, [hold(waits), ...blocked.map((b) => hold(b))], [21, 61, 11, 64].map(story))] }, record: () => waits,
    expect: { who: "Another story", action: "Nothing — it continues by itself", text: "#21 waits for #61, which waits for answers and #11, which waits for answers and #64, which waits for answers — nothing to do here, it starts by itself once you've handled #61, #11, #64.", yourTurn: false, buttons: [] },
  },
  {
    id: "approval-by-hand", realCase: "A run started by hand waits for approval", source: "kind only",
    world: { config: c, runs: [handRun], tracked: [] }, record: () => runNextStep(handRun, {}),
    expect: { who: "You", action: "Approve or reject it on the run page", text: "It waits for your approval: Delete the old data — approve or reject it on the run page.", yourTurn: true, buttons: [], link: "Run page", dismissable: true },
  },
  {
    id: "daily-budget", realCase: "The daily budget is used up", source: "kind only",
    world: held(nextStep("daily_budget", base(49), { watched: true, issueUrl: issueUrl(49) }), { runs: [budget] }), record: () => nextStep("daily_budget", base(49), { watched: true, issueUrl: issueUrl(49) }),
    expect: { who: "A time limit", action: "Nothing — it continues by itself", text: "The daily budget is used up — nothing to do, it starts tomorrow.", yourTurn: false, buttons: [] },
  },
];
