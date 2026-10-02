import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoard, columnOf, COLUMNS, EMPTY_BOARD, phasesOf, stepProgress, stepText, ticketTitle, type BoardCard, type BoardRun, type BoardSource, type Phase } from "../src/board.js";
import { ConfigSchema } from "../src/config.js";
import { evalsDir } from "../src/evals.js";
import { parseFlow } from "../src/flow/load.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import { boardFor } from "../src/server/board.js";
import type { ApiContext } from "../src/server/server.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

// ---- phasesOf: every step of the seven GitHub issue flows ----

type Groups = [Phase, string][];
const g = (phase: Phase, ids: string): [Phase, string][] => ids.split(" ").map((id) => [phase, id]);
const REVIEW = "review_1 address_review_1 run_tests_1 fix_tests_1 review_2 address_review_2 run_tests_2 fix_tests_2 docs final_guard";
const FLOWS: Record<string, Groups> = {
  "issue-gitflow": [
    ...g("planning", "pull_ticket feature_branch baseline_tests plan plan_review revise_gate revise_plan send_back split_gate approve_split create_split size_gate force_split risk_gate approve_plan claim_areas wait_for_area"),
    ...g("coding", "implement guard fix_guard run_tests fix_tests"),
    ...g("reviewing", "review_1 address_review_1 run_tests_1 fix_tests_1 review_gate review_2 address_review_2 run_tests_2 fix_tests_2 docs final_guard"),
    ...g("merging", "commit push_feature merge_develop resolve_conflicts finish_merge test_develop fix_develop commit_develop_fix push_develop report"),
    ...g("planning", "baseline_failed"),
  ],
  "issue-deliver": [
    ...g("planning", "pull_ticket daily_branch baseline_tests plan plan_review revise_plan send_back split_gate approve_split create_split risk_gate approve_plan"),
    ...g("coding", "implement guard fix_guard run_tests fix_tests"), ...g("reviewing", REVIEW),
    ...g("merging", "commit push open_pr report"), ...g("planning", "baseline_failed"),
  ],
  "issue-code-daily": [
    ...g("planning", "pull_ticket daily_branch baseline_tests"), ...g("coding", "implement guard fix_guard run_tests fix_tests"),
    ...g("reviewing", REVIEW), ...g("merging", "commit push report"), ...g("planning", "baseline_failed wait_for_merge"),
  ],
  "issue-plan": g("planning", "pull_ticket clone plan plan_review revise_plan send_back post_plan"),
  "github-issue": [
    ...g("planning", "check_repo pull_ticket pull_repo plan ask_for_info push_plan"), ...g("coding", "implement run_tests fix_tests"),
    ...g("reviewing", "review address_review"), ...g("merging", "commit push push_result"),
  ],
  "github-pr": [
    ...g("planning", "check_repo pull_ticket pull_repo plan ask_for_info push_plan"), ...g("coding", "implement run_tests fix_tests"),
    ...g("reviewing", "review address_review"),
    ...g("merging", "commit approval_gate request_approval approve push open_pr wait_ci fix_ci push_ci_fix push_result learn save_learnings"),
  ],
  "github-auto": [
    ...g("planning", "check_repo pull_ticket pull_repo triage split_ticket plan ask_for_info push_plan"), ...g("coding", "implement run_tests fix_tests"),
    ...g("reviewing", "review address_review"), ...g("merging", "commit push open_pr wait_ci fix_ci push_ci_fix push_result learn save_learnings"),
  ],
};

describe("phasesOf", () => {
  for (const [name, groups] of Object.entries(FLOWS)) {
    it(`puts every step of ${name} in its phase`, () => {
      const flow = parseFlow(readFileSync(join("flows", `${name}.yaml`), "utf8"), name);
      const ids = flow.steps.map((s) => s.id);
      expect(groups.map(([, id]) => id)).toEqual(ids); // a renamed or new step fails here
      expect(phasesOf(ids)).toEqual(groups.map(([p]) => p));
    });
  }

  it("treats unknown names as coding, and steps after a phase start stay in it", () => {
    expect(phasesOf(["do", "test", "fix"])).toEqual(["coding", "coding", "coding"]);
    expect(phasesOf(["a", "b"])).toEqual(["coding", "coding"]);
    expect(phasesOf([])).toEqual([]);
    expect(phasesOf(["plan", "x", "implement", "y"])).toEqual(["planning", "planning", "coding", "coding"]);
  });
});

// ---- stepProgress, ticketTitle ----

const runOf = (over: Record<string, unknown> = {}) => ({
  runId: "r1", status: "running", history: [], state: { next: "implement", steps: {}, visits: {} },
  flowDef: { steps: [{ id: "pull_ticket" }, { id: "plan" }, { id: "implement" }, { id: "review" }, { id: "commit" }] }, ...over,
}) as never as BoardRun;

describe("stepProgress", () => {
  it("gives the phase, position and total of the step to run", () => {
    const p = stepProgress(runOf())!;
    expect(p).toEqual({ phase: "coding", index: 2, total: 5 });
    expect(stepText(p)).toBe("coding — step 3 of 5");
  });

  it("has nothing for an unknown step, a finished run or a run without a flow", () => {
    expect(stepProgress(runOf({ state: { next: "nope", steps: {}, visits: {} } }))).toBeUndefined();
    expect(stepProgress(runOf({ status: "succeeded" }))).toBeUndefined();
    expect(stepProgress(runOf({ status: "failed" }))).toMatchObject({ phase: "coding", index: 2 }); // a stopped run shows the step it resumes at
    expect(stepProgress(runOf({ flowDef: undefined }))).toBeUndefined();
    expect(stepProgress(undefined)).toBeUndefined();
  });

  it("starts at the first step that is not jump-only when nothing ran yet", () => {
    const flowDef = { steps: [{ id: "approve", jump_only: true }, { id: "plan" }, { id: "implement" }] };
    expect(stepProgress(runOf({ flowDef, state: { next: null, steps: {}, visits: {} } }))).toEqual({ phase: "planning", index: 1, total: 3 });
  });
});

describe("ticketTitle", () => {
  const withOut = (output: unknown) => runOf({ state: { next: null, steps: { pull_ticket: { output } }, visits: {} } });
  it("reads the title the pull_ticket step printed", () => {
    expect(ticketTitle(withOut("# #37: Next step 6\n\nbody"))).toBe("Next step 6");
  });
  it("is empty without the step or with other output", () => {
    expect(ticketTitle(runOf())).toBe("");
    expect(ticketTitle(withOut("hello"))).toBe("");
    expect(ticketTitle(withOut(5))).toBe("");
    expect(ticketTitle(undefined)).toBe("");
  });
});

// ---- columnOf ----

const rec = (kind: Parameters<typeof nextStep>[0], data: Parameters<typeof nextStep>[2] = {}, issue = 1) =>
  nextStep(kind, { repo: "acme/app", issue, title: `T${issue}`, runId: "r1" }, data);

describe("columnOf", () => {
  const cases: [string, NextStep, string | undefined][] = [
    ["questions", rec("questions"), "your_turn"],
    ["approve plan", rec("approve_plan"), "your_turn"],
    ["approval", rec("approval"), "your_turn"],
    ["stopped", rec("stopped"), "your_turn"],
    ["watcher error", rec("watcher_error"), "your_turn"],
    ["release with a pull request", rec("release", { pr: { number: 3 } }), "your_turn"],
    ["scheduled release", rec("release", { releaseAt: "17:00" }), "merging"],
    ["dependency", rec("dependency", { blockers: [{ issue: 2 }] }), "waiting"],
    ["one at a time", rec("one_at_a_time"), "waiting"],
    ["area lock", rec("area_lock"), "waiting"],
    ["queued", rec("queued"), "queued"],
    ["starting", rec("starting"), "queued"],
    ["checking", rec("checking"), "queued"],
    ["usage limit", rec("usage_limit"), "queued"],
    ["daily budget", rec("daily_budget"), "queued"],
    ["restart", rec("restart"), "queued"],
    ["unwatched interrupted", rec("interrupted"), "your_turn"],
    ["watched interrupted", rec("interrupted", { watched: true }), "queued"],
    ["unwatched cancelled", rec("cancelled"), "your_turn"],
    ["watched cancelled", rec("cancelled", { watched: true }), "queued"],
    ["failed", rec("failed"), "failed"],
    ["done", rec("done"), "done"],
    ["superseded", rec("superseded"), undefined],
    ["running", rec("running"), "coding"],
  ];
  for (const [name, next, column] of cases) it(`${name} → ${column}`, () => expect(columnOf(next)).toBe(column));
  it("puts running work in its phase", () => expect(columnOf(rec("running"), "reviewing")).toBe("reviewing"));
});

// ---- buildBoard ----

const src = (next: NextStep, over: Partial<BoardSource> = {}): BoardSource => ({ next, since: ago(1), ...over });
const cardsOf = (b: ReturnType<typeof buildBoard>, col: string, repo = "acme/app") =>
  b.repos.find((r) => r.repo === repo)!.columns.find((c) => c.id === col)!.cards;

describe("buildBoard", () => {
  it("has the nine columns in order for a repository without cards, and says so only without repositories", () => {
    const b = buildBoard([], { now: NOW, repos: ["acme/app"] });
    expect(b.repos[0]!.columns.map((c) => c.title)).toEqual(COLUMNS.map((c) => c.title));
    expect(b.repos[0]!.columns.map((c) => c.title)).toEqual([
      "Your turn", "Waiting for another story", "Queued", "Planning", "Coding", "Reviewing", "Merging", "Done", "Failed",
    ]);
    expect(b.empty).toBeUndefined();
    expect(buildBoard([], { now: NOW })).toEqual({ repos: [], empty: EMPTY_BOARD });
  });

  it("drops sources without an issue or a repository", () => {
    const b = buildBoard([src(rec("queued", {}, 0)), src({ ...rec("queued"), repo: "" })], { now: NOW });
    expect(b.repos).toEqual([]);
  });

  it("picks the source that needs the user, else the lower rank", () => {
    const b = buildBoard([src(rec("running"), { rank: 0 }), src(rec("questions"), { rank: 3 })], { now: NOW });
    expect(cardsOf(b, "your_turn").map((c) => c.issue)).toEqual([1]);
    const c = buildBoard([src(rec("queued"), { rank: 3 }), src(rec("running"), { rank: 0 })], { now: NOW });
    expect(cardsOf(c, "coding").map((x) => x.issue)).toEqual([1]);
    expect(cardsOf(c, "queued")).toEqual([]);
  });

  it("groups Done into Today and This week, newest first, and drops older or undated ones", () => {
    const done = (issue: number, since?: string) => src(rec("done", {}, issue), { since });
    const b = buildBoard([done(1, ago(3)), done(2, ago(0.001)), done(3, ago(8)), done(4, undefined), done(5, ago(2))], { now: NOW });
    expect(cardsOf(b, "done").map((c) => [c.issue, c.group])).toEqual([[2, "Today"], [5, "This week"], [1, "This week"]]);
  });

  it("keeps an old failed card", () => {
    const b = buildBoard([src(rec("failed"), { since: ago(30) })], { now: NOW });
    expect(cardsOf(b, "failed")).toHaveLength(1);
  });

  it("opens the story's newest run when the record names none, and shows the step only for the record's own run", () => {
    const running = rec("running");
    const noRun = { ...rec("queued"), runId: undefined };
    expect(cardsOf(buildBoard([src(noRun, { runId: "r9" })], { now: NOW }), "queued")[0]!.runId).toBe("r9");
    const withStep = buildBoard([src(running, { run: runOf() })], { now: NOW });
    expect(cardsOf(withStep, "coding")[0]).toMatchObject({ step: "coding — step 3 of 5", runId: "r1" });
    const other = buildBoard([src(running, { run: runOf({ runId: "r2" }) })], { now: NOW });
    expect(cardsOf(other, "coding")[0]!.step).toBeUndefined();
  });

  it("follows the chain of a dependency through nested records and other cards, and ends on a cycle", () => {
    const dep = (issue: number, blockers: { issue: number; next?: NextStep }[]) => rec("dependency", { blockers }, issue);
    const n88 = dep(88, [{ issue: 87 }]);
    const b = buildBoard([
      src(dep(89, [{ issue: 88, next: n88 }])),
      src(n88),
      src(dep(90, [{ issue: 88 }])),
      src(dep(1, [{ issue: 2 }])), src(dep(2, [{ issue: 1 }])),
      src(dep(5, [{ issue: 404 }])),
    ], { now: NOW });
    const waiting = new Map(cardsOf(b, "waiting").map((c) => [c.issue, c]));
    expect(waiting.get(89)).toMatchObject({ after: [88], chain: [87, 88] });
    expect(waiting.get(90)).toMatchObject({ after: [88], chain: [87, 88] });
    expect(waiting.get(1)).toMatchObject({ after: [2], chain: [2] });
    expect(waiting.get(2)).toMatchObject({ after: [1], chain: [1] });
    expect(waiting.get(5)).toMatchObject({ after: [404], chain: [404] });
  });

  it("gives a card exactly the documented keys, without the run", () => {
    const [card] = cardsOf(buildBoard([src(rec("running"), { run: runOf(), watcher: "w" })], { now: NOW }), "coding") as BoardCard[];
    expect(Object.keys(card!).sort()).toEqual(["after", "chain", "column", "issue", "key", "next", "runId", "since", "step", "title", "watcher"].sort());
    expect(card!.key).toBe("acme/app#1");
  });

  it("sorts repositories and cards", () => {
    const b = buildBoard([src({ ...rec("queued", {}, 2), repo: "b/x" }), src(rec("queued", {}, 9)), src(rec("queued", {}, 3))], { now: NOW, repos: ["c/y"] });
    expect(b.repos.map((r) => r.repo)).toEqual(["acme/app", "b/x", "c/y"]);
    expect(cardsOf(b, "queued").map((c) => c.issue)).toEqual([3, 9]);
  });
});

// ---- boardFor, against a stub context ----

type RunSummary = import("../src/engine/state.js").RunSummary;
const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, flow: "other", flowDef: { steps: [] }, task: `task ${runId}`, vars: { github_repo: "acme/app", issue: "5" }, repo: "/x",
  status: "failed", reason: "boom", runDir: "/tmp/none", source: "ui", startedAt: ago(1), finishedAt: ago(1), history: [],
  state: { next: null, steps: {}, visits: {} }, totalCostUsd: 0, ...over,
}) as never as RunSummary;

const issuesWatcher = { id: "a", github_repo: "acme/app", flow: "github-issue" };
type Tracked = { watcher: unknown; status: Record<string, unknown>; issues: { issue: number; title: string; runId?: string; done?: boolean }[] };

function stub(o: { watchers?: Record<string, unknown>[]; runs?: RunSummary[]; tracked?: (c: ReturnType<typeof ConfigSchema.parse>) => Tracked[]; active?: string[]; pending?: Record<string, unknown>[] } = {}) {
  const runs = o.runs ?? [];
  const config = ConfigSchema.parse({ watchers: o.watchers ?? [issuesWatcher] });
  return {
    config: () => config,
    scheduler: {
      list: (n = 100) => runs.slice(0, n),
      get: (id: string) => runs.find((r) => r.runId === id),
      briefs: () => runs.map((r) => ({ runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, source: r.source, runDir: r.runDir })),
      queue: () => ({ pending: o.pending ?? [], active: (o.active ?? []).map((runId) => ({ runId })) }),
    },
    watchers: { tracked: () => o.tracked?.(config) ?? [] },
  } as unknown as ApiContext;
}
const trackedOf = (status: Record<string, unknown>, issues: Tracked["issues"]) => (c: ReturnType<typeof ConfigSchema.parse>): Tracked[] =>
  [{ watcher: c.watchers[0], status: { id: "a", lastActions: [], ...status }, issues }];

const board = (ctx: ApiContext) => boardFor(ctx, NOW);
const cards = (ctx: ApiContext, col: string) => cardsOf(board(ctx), col);
const allCards = (ctx: ApiContext) => board(ctx).repos.flatMap((r) => r.columns.flatMap((c) => c.cards));

describe("boardFor", () => {
  it("puts a tracked running issue in its phase with a step line", () => {
    const r = run("r1", { status: "running", finishedAt: undefined, flowDef: { steps: [{ id: "pull_ticket" }, { id: "plan" }, { id: "implement" }] }, state: { next: "implement", steps: {}, visits: {} } });
    const ctx = stub({ runs: [r], active: ["r1"], tracked: trackedOf({}, [{ issue: 5, title: "Five", runId: "r1" }]) });
    expect(cards(ctx, "coding")).toMatchObject([{ issue: 5, title: "Five", step: "coding — step 3 of 3", runId: "r1" }]);
  });

  it("puts a story that waits for another one in Waiting, with its earlier run to open", () => {
    const hold = (runId?: string) => ({ issue: 4, reason: "x", next: nextStep("dependency", { repo: "acme/app", issue: 4, title: "Four", runId }, { watched: true, blockers: [{ issue: 3 }] }) });
    const withRun = stub({ runs: [run("r0")], tracked: trackedOf({ holds: [hold()] }, [{ issue: 4, title: "Four", runId: "r0" }]) });
    expect(cards(withRun, "waiting")).toMatchObject([{ issue: 4, after: [3], runId: "r0" }]);
    expect(cards(withRun, "waiting")[0]!.step).toBeUndefined();
    const without = stub({ tracked: trackedOf({ holds: [hold()] }, [{ issue: 4, title: "Four" }]) });
    const card = cards(without, "waiting")[0]!;
    expect(card.after).toEqual([3]);
    expect(card.runId).toBeUndefined();
  });

  it("keeps a tracked issue whose run failed long ago in Failed", () => {
    const ctx = stub({ runs: [run("r1", { startedAt: ago(30), finishedAt: ago(30) })], tracked: trackedOf({}, [{ issue: 5, title: "Five", runId: "r1" }]) });
    expect(cards(ctx, "failed").map((c) => c.issue)).toEqual([5]);
  });

  it("shows a succeeded watcher run of a closed issue as Done, by the ticket title, and hides its failed one", () => {
    const state = { next: null, steps: { pull_ticket: { output: "# #9: Nine\n" } }, visits: {} };
    const w = { flow: "github-issue", source: "watcher a issue #9", vars: { github_repo: "acme/app", issue: "9" } };
    const ok = run("r9", { ...w, status: "succeeded", reason: undefined, state, finishedAt: ago(0.001) });
    expect(cards(stub({ runs: [ok] }), "done")).toMatchObject([{ issue: 9, title: "Nine", group: "Today", runId: "r9" }]);
    const bad = run("r8", { ...w, vars: { github_repo: "acme/app", issue: "8" }, finishedAt: ago(0.001) });
    expect(allCards(stub({ runs: [bad] }))).toEqual([]);
  });

  it("shows a failed or cancelled hand-started run for 7 days", () => {
    for (const [status, col] of [["failed", "failed"], ["cancelled", "your_turn"]] as const) {
      const at = (d: number) => stub({ runs: [run("r1", { status, startedAt: ago(d), finishedAt: ago(d) })] });
      expect(cards(at(3), col).map((c) => c.issue)).toEqual([5]);
      expect(allCards(at(8))).toEqual([]);
    }
  });

  it("does not show a run without an issue, or one for the placeholder repository", () => {
    const ctx = stub({ runs: [run("r1", { vars: { github_repo: "acme/app" } }), run("r2", { vars: { github_repo: "owner/repo", issue: "3" } })] });
    expect(allCards(ctx)).toEqual([]);
  });

  it("does not show eval runs, also those of older versions without a source", () => {
    expect(allCards(stub({ runs: [run("r1", { source: "eval suite" })] }))).toEqual([]);
    mkdirSync(evalsDir(), { recursive: true });
    const file = join(evalsDir(), "board-test.json");
    writeFileSync(file, JSON.stringify({ results: [{ runId: "r2" }] }));
    try {
      expect(allCards(stub({ runs: [run("r2", { source: undefined })] }))).toEqual([]);
      expect(cards(stub({ runs: [run("r3", { source: undefined })] }), "failed")).toHaveLength(1);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it("shows a queued job that has no run file yet, in Queued or Waiting", () => {
    const job = { runId: "p1", kind: "run", githubRepo: "acme/app", issue: "8", task: "t", repo: "/x" };
    expect(cards(stub({ pending: [job] }), "queued")).toMatchObject([{ issue: 8 }]);
    const held = cards(stub({ pending: [{ ...job, waitingFor: "r7" }] }), "waiting");
    expect(held).toMatchObject([{ issue: 8 }]);
    expect(held[0]!.runId).toBe("p1"); // the card opens the run page before the run file exists
  });

  it("still shows an older waiting run beyond the newest 200", () => {
    const filler = Array.from({ length: 204 }, (_, i) => run(`f${i}`, { vars: { github_repo: "acme/app" } }));
    const old = run("old", { status: "waiting", reason: undefined, finishedAt: undefined, waiting: { stepId: "gate", message: "ok?", since: ago(20) }, vars: { github_repo: "acme/app", issue: "6" } });
    expect(cards(stub({ runs: [...filler, old] }), "your_turn")).toMatchObject([{ issue: 6, runId: "old" }]);
  });

  it("lets a live run replace an older one of the same story", () => {
    const live = run("r2", { status: "running", finishedAt: undefined, startedAt: ago(0.1) });
    const ctx = stub({ runs: [run("r1"), live], active: ["r2"] });
    expect(cards(ctx, "coding").map((c) => c.runId)).toEqual(["r2"]);
    expect(cards(ctx, "failed")).toEqual([]);
  });

  it("lets a newer live run take over a story the watcher has not rechecked yet", () => {
    const flowDef = { steps: [{ id: "pull_ticket" }, { id: "implement" }] };
    const oldRun = run("r1", { flowDef, state: { next: "implement", steps: {}, visits: {} } });
    const newer = run("r2", { status: "running", finishedAt: undefined, startedAt: ago(0.01), flowDef, state: { next: "implement", steps: {}, visits: {} } });
    const ctx = stub({ runs: [newer, oldRun], active: ["r2"], tracked: trackedOf({}, [{ issue: 5, title: "Five", runId: "r1" }]) });
    expect(cards(ctx, "failed")).toEqual([]);
    expect(cards(ctx, "coding")).toMatchObject([{ issue: 5, title: "Five", runId: "r2", step: "coding — step 2 of 2" }]);
    const job = { runId: "p2", kind: "run", githubRepo: "acme/app", issue: "5", task: "t", repo: "/x" };
    const queued = stub({ runs: [oldRun], pending: [job], tracked: trackedOf({}, [{ issue: 5, title: "Five", runId: "r1" }]) });
    expect(cards(queued, "queued")).toMatchObject([{ issue: 5, runId: "p2" }]);
  });

  it("keeps the real title when a queued job without a task takes over a story", () => {
    const job = { runId: "p2", kind: "run", githubRepo: "acme/app", issue: "5", task: "", repo: "/x" };
    const ctx = stub({ runs: [run("r1")], pending: [job], tracked: trackedOf({}, [{ issue: 5, title: "Five", runId: "r1" }]) });
    expect(cards(ctx, "queued")).toMatchObject([{ title: "Five", runId: "p2" }]);
  });

  it("keeps old finished work that still waits for the scheduled release, in Merging", () => {
    const release = { id: "s", source: "schedule", flow: "release-daily", at: "17:00", task: "release", github_repo: "acme/app" };
    const r = run("r1", { status: "succeeded", reason: undefined, startedAt: ago(10), finishedAt: ago(10), history: [{ id: "push_develop" }] });
    expect(cards(stub({ watchers: [release], runs: [r] }), "merging")).toMatchObject([{ issue: 5, runId: "r1" }]);
    expect(allCards(stub({ runs: [r] }))).toEqual([]); // plain old Done expires
  });

  it("shows the step a failed run stopped at", () => {
    const flowDef = { steps: [{ id: "pull_ticket" }, { id: "implement" }, { id: "run_tests" }] };
    const r = run("r1", { flowDef, state: { next: "run_tests", steps: {}, visits: {} } });
    expect(cards(stub({ runs: [r] }), "failed")).toMatchObject([{ step: "coding — step 3 of 3" }]);
  });

  it("lists the repositories of the issues watchers, without cards", () => {
    expect(board(stub()).repos.map((r) => r.repo)).toEqual(["acme/app"]);
  });
});
