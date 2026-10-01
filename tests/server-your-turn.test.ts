import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import { allNext } from "../src/server/next.js";
import { dismissTurn, turnFor } from "../src/server/your-turn.js";
import type { ApiContext } from "../src/server/server.js";

// The Your turn rules against a stub context (no server, no GitHub).

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const cfg = (watchers: Record<string, unknown>[] = []) => ConfigSchema.parse({ watchers });
const issuesWatcher = { id: "a", github_repo: "acme/app", flow: "github-issue" };

const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, flow: "github-issue", flowDef: { steps: [] }, task: `task ${runId}`, vars: { github_repo: "acme/app" }, repo: "/x",
  status: "failed", reason: "boom", runDir: "/tmp/none", startedAt: ago(1), finishedAt: ago(1), history: [],
  state: { next: null, steps: {}, visits: {} }, totalCostUsd: 0, ...over,
}) as never as import("../src/engine/state.js").RunSummary;

type Tracked = { watcher: unknown; status: Record<string, unknown>; issues: { issue: number; title: string; runId?: string }[] };

function stub(o: { config?: ReturnType<typeof cfg>; runs?: ReturnType<typeof run>[]; tracked?: Tracked[]; listed?: number } = {}) {
  const runs = o.runs ?? [];
  const config = o.config ?? cfg();
  return {
    config: () => config,
    scheduler: {
      list: (n = 100) => runs.slice(0, o.listed ?? n).slice(0, n),
      get: (id: string) => runs.find((r) => r.runId === id),
      briefs: () => runs.map((r) => ({ runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, source: r.source, runDir: r.runDir })),
      queue: () => ({ pending: [], active: [] }),
    },
    watchers: { tracked: () => o.tracked ?? [] },
  } as unknown as ApiContext;
}

const hold = (next: NextStep, extra: Record<string, unknown> = {}) => ({ issue: next.issue, reason: next.text, next, ...extra });
const q = (issue: number, extra: Record<string, unknown> = {}) => hold(nextStep("questions", { repo: "acme/app", issue, title: `T${issue}` }, { watched: true, questions: 1 }), extra);
const items = (ctx: ApiContext) => turnFor(ctx, NOW).data.groups.flatMap((g) => g.items);
const tracked = (c: ReturnType<typeof cfg>, i: number, holds: unknown[], issues: Tracked["issues"], status: Record<string, unknown> = {}): Tracked =>
  ({ watcher: c.watchers[i], status: { id: c.watchers[i]!.id, lastActions: [], holds, ...status }, issues });

describe("Your turn items", () => {
  it("lists a question and counts the story that waits for it, but not the waiting story", () => {
    const c = cfg([issuesWatcher]);
    const dep = hold(nextStep("dependency", { repo: "acme/app", issue: 4, title: "T4" }, { watched: true, blockers: [{ issue: 3 }] }));
    const out = items(stub({ config: c, tracked: [tracked(c, 0, [q(3), dep], [{ issue: 3, title: "T3" }, { issue: 4, title: "T4" }])] }));
    expect(out.map((i) => [i.next.issue, i.unblocks])).toEqual([[3, 1]]);
  });

  it("reads every watcher of an issue, while /api/next keeps one record", () => {
    const c = cfg([issuesWatcher, { ...issuesWatcher, id: "b", label: "other" }]);
    const dep = hold(nextStep("dependency", { repo: "acme/app", issue: 5, title: "T5" }, { watched: true, blockers: [{ issue: 2 }] }));
    const ctx = stub({ config: c, tracked: [tracked(c, 0, [dep], [{ issue: 5, title: "T5" }]), tracked(c, 1, [q(5)], [{ issue: 5, title: "T5" }])] });
    expect(items(ctx).map((i) => i.next.issue)).toEqual([5]);
    expect(allNext(ctx).issues).toHaveLength(1);
  });

  it("lists a watcher error that cannot be dismissed", () => {
    const c = cfg([issuesWatcher]);
    const out = items(stub({ config: c, tracked: [tracked(c, 0, [], [], { lastError: "gh down", errorSince: ago(0.1) })] }));
    expect(out).toMatchObject([{ next: { kind: "watcher_error" }, dismissable: false, since: ago(0.1) }]);
  });

  it("lists a release pull request once, by its title", () => {
    const c = cfg([issuesWatcher]);
    const pr = { number: 9, url: "https://github.com/acme/app/pull/9" };
    const rel = (issue?: number) => hold(nextStep("release", { repo: "acme/app", issue, title: "T" }, { watched: true, pr }), { since: ago(1) });
    const status = { pausedBy: { ...pr, title: "Daily 30 Sep" } };
    const ctx = stub({ config: c, tracked: [tracked(c, 0, [rel(), rel(1), rel(2)], [{ issue: 1, title: "a" }, { issue: 2, title: "b" }], status)] });
    expect(items(ctx)).toMatchObject([{ what: "Daily 30 Sep", unblocks: 2 }]);
  });
});

describe("Your turn runs", () => {
  const ids = (runs: ReturnType<typeof run>[], c = cfg([issuesWatcher])) => items(stub({ config: c, runs })).map((i) => i.next.runId);

  it("lists by who started a run", () => {
    const failed = (id: string, issue: string, source?: string) => run(id, { vars: { github_repo: "acme/app", issue }, ...(source ? { source } : {}) });
    expect(ids([failed("r9", "9", "ui"), failed("r10", "10", "watcher a issue #10"), failed("r11", "11")])).toEqual(["r9"]);
  });

  it("skips eval runs and lists failed runs of other watcher flows", () => {
    expect(ids([run("e", { source: "eval smoke" }), run("w", { source: "watcher rel schedule", flow: "release-daily" })])).toEqual(["w"]);
  });

  it("lists a failed run without a source for 7 days", () => {
    expect(ids([run("new", { finishedAt: ago(6) })])).toEqual(["new"]);
    expect(ids([run("old", { finishedAt: ago(8) })])).toEqual([]);
  });

  it("lists a waiting hand-started run at any age", () => {
    const waiting = run("w", { status: "waiting", source: "ui", startedAt: ago(30), finishedAt: undefined, waiting: { stepId: "gate", message: "ok?", since: ago(30) } });
    expect(items(stub({ runs: [waiting] }))).toMatchObject([{ next: { kind: "approval", runId: "w" }, since: ago(30) }]);
  });

  it("does not stop at the newest 200 runs", () => {
    const fresh = Array.from({ length: 250 }, (_, i) => run(`s${i}`, { status: "succeeded", reason: undefined, source: "ui", startedAt: ago(0.1), finishedAt: ago(0.1) }));
    const oldWaiting = run("ow", { status: "waiting", source: "ui", waiting: { stepId: "gate", message: "ok?", since: ago(40) }, startedAt: ago(40) });
    const oldFailed = run("of", { source: "ui", finishedAt: ago(3) });
    expect(ids([...fresh, oldWaiting, oldFailed]).sort()).toEqual(["of", "ow"]);
  });

  it("shows a run that a tracked issue refers to once", () => {
    const c = cfg([issuesWatcher]);
    const r = run("r1", { vars: { github_repo: "acme/app", issue: "7" }, source: "watcher a issue #7" });
    const failed = hold(nextStep("failed", { repo: "acme/app", issue: 7, title: "T7", runId: "r1" }, { watched: true, reason: "boom" }));
    expect(items(stub({ config: c, runs: [r], tracked: [tracked(c, 0, [failed], [{ issue: 7, title: "T7", runId: "r1" }])] }))).toHaveLength(1);
  });

  it("does not list a cancelled run", () => {
    expect(ids([run("c", { status: "cancelled", source: "ui" })])).toEqual([]);
  });
});

describe("Your turn dismissals", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "factory-turn-"));
    saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    process.env.FACTORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const c = cfg([issuesWatcher]);
  const failedHold = (seen: string) => hold(nextStep("failed", { repo: "acme/app", issue: 8, title: "T8" }, { watched: true, failedLabel: "factory:failed" }), { seen });
  const withHolds = (...h: unknown[]) => stub({ config: c, tracked: [tracked(c, 0, h, [{ issue: 8, title: "T8" }, { issue: 3, title: "T3" }])] });

  it("keeps a dismissed hold without a real time hidden after a new first-seen time", () => {
    const first = withHolds(failedHold(ago(1)));
    dismissTurn(first, items(first)[0]!.key, NOW);
    expect(items(first)).toEqual([]);
    expect(items(withHolds(failedHold(ago(0))))).toEqual([]);
  });

  it("a hold about a run keeps the run's time after a restart, and a later approval of the same run shows again", () => {
    const r = run("r1", { status: "waiting", vars: { github_repo: "acme/app", issue: "8" }, source: "watcher a issue #8", waiting: { stepId: "gate", message: "ok?", since: ago(2) } });
    const approval = () => hold(nextStep("approval", { repo: "acme/app", issue: 8, title: "T8", runId: "r1" }, { watched: true }), { seen: ago(0) }); // seen: restart-local
    const ctx = () => stub({ config: c, runs: [r], tracked: [tracked(c, 0, [approval()], [{ issue: 8, title: "T8", runId: "r1" }])] });
    expect(items(ctx())[0]!.since).toBe(ago(2));
    dismissTurn(ctx(), items(ctx())[0]!.key, NOW);
    expect(items(ctx())).toEqual([]);
    r.waiting = { stepId: "gate2", message: "again?", since: ago(0.5) };
    expect(items(ctx())).toHaveLength(1);
  });

  it("does not list eval runs of an older version (no source) that an eval report names", () => {
    mkdirSync(join(home, "evals"), { recursive: true });
    writeFileSync(join(home, "evals", "s-1.json"), JSON.stringify({ results: [{ runId: "old-eval" }] }));
    expect(items(stub({ runs: [run("old-eval"), run("manual")] })).map((i) => i.next.runId)).toEqual(["manual"]);
  });

  it("keeps an earlier dismissal when the watchers are not there yet", () => {
    const both = withHolds(failedHold(ago(1)), q(3, { since: ago(2) }));
    const [a, b] = [items(both).find((i) => i.next.issue === 8)!, items(both).find((i) => i.next.issue === 3)!];
    dismissTurn(both, a.key, NOW);
    const none = stub({ config: c, runs: [run("rb", { source: "ui" })] });
    dismissTurn(none, items(none)[0]!.key, NOW);
    expect(items(both).map((i) => i.next.issue)).toEqual([3]);
    expect(b.key).not.toBe(a.key);
  });

  it("drops a stored dismissal that is gone for 31 days, and keeps one from yesterday", () => {
    writeFileSync(join(home, "your-turn.json"), JSON.stringify({ dismissed: {
      "old|key": { since: "", at: ago(31) }, "recent|key": { since: "", at: ago(1) },
    } }));
    const ctx = withHolds(q(3, { since: ago(2) }));
    dismissTurn(ctx, items(ctx)[0]!.key, NOW);
    const stored = Object.keys((JSON.parse(readFileSync(join(home, "your-turn.json"), "utf8")) as { dismissed: object }).dismissed);
    expect(stored).toContain("recent|key");
    expect(stored).not.toContain("old|key");
  });

  it("reads a broken or oddly shaped file as empty", () => {
    const ctx = withHolds(q(3, { since: ago(2) }));
    writeFileSync(join(home, "your-turn.json"), "{ not json");
    expect(items(ctx)).toHaveLength(1);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "your-turn.json"), JSON.stringify({ dismissed: { x: "nope" } }));
    expect(items(ctx)).toHaveLength(1);
  });
});

describe("Your turn empty state", () => {
  const release = { id: "rel", github_repo: "acme/app", source: "schedule", flow: "release-daily", at: "17:00", task: "release" };
  const running = (id: string, issue: string | undefined, steps: string[]) =>
    run(id, { status: "running", reason: undefined, finishedAt: undefined, vars: { github_repo: "acme/app", ...(issue ? { issue } : {}) }, flowDef: { steps: steps.map((s) => ({ id: s })) }, source: "ui" });
  const empty = (runs: ReturnType<typeof run>[], c = cfg([issuesWatcher, release])) => turnFor(stub({ config: c, runs }), NOW).data.empty;

  it("names the stories being built and the release time", () => {
    expect(empty([running("r1", "3", ["code", "push_develop"])])).toBe("Nothing needs you. 1 story is being built; the next thing for you is expected around 17:00 (release pull request).");
  });
  it("leaves out the time for a flow without delivery steps", () => {
    expect(empty([running("r1", "3", ["code"])])).toBe("Nothing needs you. 1 story is being built.");
  });
  it("counts stories only, and the time comes from the one that feeds the release", () => {
    expect(empty([running("r1", "3", ["push_develop"]), running("r2", undefined, ["code"])])).toBe("Nothing needs you. 1 story is being built; the next thing for you is expected around 17:00 (release pull request).");
  });
  it("is plain when only a run without an issue runs", () => {
    expect(empty([running("r1", undefined, ["code"])])).toBe("Nothing needs you.");
  });
});
