import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { saveGuard, switchStories } from "../src/monitor/guard.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import type { Notice } from "../src/notify.js";
import { TurnNotifier } from "../src/server/notifier.js";
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

function stub(o: { config?: ReturnType<typeof cfg>; runs?: ReturnType<typeof run>[]; tracked?: Tracked[]; statuses?: unknown[]; listed?: number } = {}) {
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
    watchers: { tracked: () => o.tracked ?? [], statuses: () => o.statuses ?? [] },
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

  describe("the circuit breaker", () => {
    const monitor = (enabled = true) => ({ id: "mon", source: "monitor", every: "1h", enabled });
    const openIt = (at: string) => saveGuard({ version: 1, breaker: { open: { since: at, reason: "findings", count: 7, minutes: 60 } } });

    it("shows one item that cannot be dismissed, and none once it is closed", () => {
      openIt(ago(0.5));
      const ctx = stub({ statuses: [monitor()] });
      const out = items(ctx);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ dismissable: false, since: ago(0.5), next: { kind: "monitor_stopped", where: { url: "#/watchers" } } });
      expect(out[0]!.next.text).toContain("7 new findings within 60 minutes");
      expect(() => dismissTurn(ctx, out[0]!.key, NOW)).toThrow(expect.objectContaining({ status: 404 }));
      switchStories("on", "cli");
      expect(items(ctx)).toEqual([]);
    });

    it("shows nothing without a monitor or with a disabled one", () => {
      openIt(ago(0.5));
      expect(items(stub())).toEqual([]);
      expect(items(stub({ statuses: [monitor(false)] }))).toEqual([]);
    });
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

describe("Your turn notifications", () => {
  let home: string;
  let saved: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "factory-notify-"));
    saved = process.env.FACTORY_HOME;
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    process.env.FACTORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const BASE = "http://localhost:4777";
  const min = (m: number) => new Date(Date.UTC(2026, 9, 1, 12, m));
  const at = (h: number, m = 0, day = 1) => new Date(Date.UTC(2026, 9, day, h, m));
  const issueUrl = (n: number) => `https://github.com/acme/app/issues/${n}`;
  const pr = { number: 9, url: "https://github.com/acme/app/pull/9" };
  const h = (kind: Parameters<typeof nextStep>[0], issue: number, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    hold(nextStep(kind, { repo: "acme/app", issue, title: `T${issue}` }, { watched: true, issueUrl: issueUrl(issue), ...data }), { since: ago(2), ...extra });
  const qh = (issue: number, extra: Record<string, unknown> = {}) => h("questions", issue, { questions: 1 }, extra);
  const done = (id: string, finishedAt: string, over: Record<string, unknown> = {}) =>
    run(id, { status: "succeeded", reason: undefined, source: "ui", startedAt: finishedAt, finishedAt, ...over });
  const channel = { macos: false, slack_webhook: "http://127.0.0.1:9/hook" };

  function rig(notify: Record<string, unknown> = {}) {
    const state = { config: ConfigSchema.parse({ watchers: [issuesWatcher], notify: { ...channel, ...notify } }), runs: [] as ReturnType<typeof run>[], tracked: [] as Tracked[] };
    const ctx = stub({ config: state.config, runs: state.runs });
    (ctx as unknown as { config: () => unknown }).config = () => state.config;
    (ctx as unknown as { watchers: unknown }).watchers = { tracked: () => state.tracked, statuses: () => [] };
    const sent: Notice[] = [];
    const slow = { ms: 0 };
    const make = () =>
      new TurnNotifier(ctx, {
        baseUrl: BASE, timeZone: "UTC",
        send: async (n) => { if (slow.ms) await new Promise((r) => setTimeout(r, slow.ms)); sent.push(n); },
      });
    const holds = (...hs: { issue?: number }[]) => {
      state.tracked = [tracked(state.config, 0, hs, hs.map((x) => ({ issue: x.issue ?? 0, title: `T${x.issue}` })))];
    };
    return { state, ctx, sent, slow, make, holds, notifier: make(), runs: state.runs, config: state.config };
  }

  it("tells about a new question once, with the issue link", async () => {
    const t = rig();
    t.holds(qh(3));
    await t.notifier.check(min(0));
    await t.notifier.check(min(10));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ title: "Foundry · your turn", url: issueUrl(3) });
    expect(t.sent[0]!.message).toContain("acme/app#3 T3");
  });

  it("links each kind of item", async () => {
    const cases: [ReturnType<typeof h>, string][] = [
      [h("approve_plan", 4), issueUrl(4)],
      [h("approve_split", 5), issueUrl(5)],
      [h("release", 6, { pr }), pr.url],
    ];
    for (const [hd, url] of cases) {
      rmSync(join(home, "notifications.json"), { force: true });
      const t = rig();
      t.holds(hd);
      await t.notifier.check(min(0));
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]!.url).toBe(url);
    }
    rmSync(join(home, "notifications.json"), { force: true });
    const t = rig();
    t.state.tracked = [tracked(t.config, 0, [], [], { lastError: "gh down", errorSince: ago(0.1) })];
    await t.notifier.check(min(0));
    expect(t.sent[0]).toMatchObject({ url: `${BASE}/#/watchers` });
  });

  it("groups several new items", async () => {
    const t = rig();
    t.holds(qh(3), qh(4), qh(5));
    await t.notifier.check(min(0));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ title: "Foundry · 3 things need you", url: `${BASE}/#/your-turn` });
  });

  it("throttles", async () => {
    const t = rig({ throttle_minutes: 5 });
    t.holds(qh(3));
    await t.notifier.check(min(0));
    t.holds(qh(3), qh(4));
    await t.notifier.check(min(1));
    expect(t.sent).toHaveLength(1);
    await t.notifier.check(min(5));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]!.message).toContain("T4");
    expect(t.sent[1]!.message).not.toContain("T3");
  });

  it("waits for the end of quiet hours and names only what is still there", async () => {
    const t = rig({ quiet_hours: { from: "11:00", to: "13:00" } });
    t.holds(qh(3));
    await t.notifier.check(at(12));
    expect(t.sent).toHaveLength(0);
    t.holds(qh(4));
    await t.notifier.check(at(13));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.message).toContain("T4");
    expect(t.sent[0]!.message).not.toContain("T3");
  });

  it("does not repeat after a restart or when seen changes, but does for a new stamp", async () => {
    const t = rig();
    t.holds(qh(3, { seen: "a" }));
    await t.notifier.check(min(0));
    t.holds(qh(3, { seen: "b" }));
    await t.notifier.check(min(10));
    await t.make().check(min(20));
    expect(t.sent).toHaveLength(1);
    t.holds(qh(3, { since: ago(1) }));
    await t.notifier.check(min(30));
    expect(t.sent).toHaveLength(2);
  });

  it("does not tell about a dismissed item", async () => {
    const t = rig();
    t.holds(qh(3));
    dismissTurn(t.ctx, "acme/app#3|questions|", NOW);
    await t.notifier.check(min(0));
    expect(t.sent).toHaveLength(0);
  });

  it("tells about a failed run of another process once, and not about a cancelled one", async () => {
    const t = rig();
    t.runs.push(run("r9", { source: "cli" }), run("c1", { status: "cancelled", source: "cli" }));
    await t.notifier.check(min(0));
    await t.notifier.check(min(10));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.url).toBe(`${BASE}/#/runs/r9`);
  });

  describe("successes", () => {
    it("are not told when switched off", async () => {
      const t = rig();
      await t.notifier.check(min(0));
      t.runs.push(done("s1", min(5).toISOString()));
      await t.notifier.check(min(10));
      expect(t.sent).toHaveLength(0);
    });

    it("are told only when they finish after the switch went on, and once", async () => {
      const t = rig({ successes: true });
      t.runs.push(done("old", min(-30).toISOString()));
      await t.notifier.check(min(0));
      expect(t.sent).toHaveLength(0);
      t.runs.push(done("s1", min(5).toISOString()), done("ev", min(5).toISOString(), { source: "eval smoke" }));
      await t.notifier.check(min(10));
      await t.notifier.check(min(20));
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ title: "Foundry · run succeeded", url: `${BASE}/#/runs/s1` });
    });

    it("that finish between switching on and the next check are told", async () => {
      const t = rig();
      await t.notifier.check(min(0));
      t.state.config = ConfigSchema.parse({ watchers: [issuesWatcher], notify: { ...channel, successes: true } });
      t.runs.push(done("s1", new Date(min(0).getTime() + 10_000).toISOString()));
      await t.notifier.check(new Date(min(0).getTime() + 30_000));
      expect(t.sent).toHaveLength(1);
    });

    it("finished in quiet hours are told after a restart", async () => {
      const t = rig({ successes: true, quiet_hours: { from: "11:00", to: "13:00" } });
      await t.notifier.check(at(12));
      t.runs.push(done("s1", at(12, 30).toISOString()));
      const again = t.make();
      await again.check(at(13));
      await again.check(at(14));
      expect(t.sent).toHaveLength(1);
    });
  });

  describe("daily summary", () => {
    const sum = { daily_summary_at: "09:00" };
    it("is sent at the time with the counts, once a day", async () => {
      const t = rig(sum);
      t.runs.push(done("s1", at(5).toISOString(), { vars: { github_repo: "acme/app", issue: "1" } }), done("s2", at(6).toISOString()), done("ev", at(6).toISOString(), { source: "eval x" }));
      await t.notifier.check(at(8));
      expect(t.sent).toHaveLength(0);
      await t.notifier.check(at(9));
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ title: "Foundry · daily summary", url: `${BASE}/#/your-turn` });
      expect(t.sent[0]!.message).toBe("Done since yesterday: 1 story, 1 other run. Waiting for you: nothing. Expected today: nothing yet.");
      await t.notifier.check(at(10));
      expect(t.sent).toHaveLength(1);
      t.runs.push(done("s3", at(7, 0, 2).toISOString()));
      await t.notifier.check(at(9, 0, 2));
      expect(t.sent).toHaveLength(2);
    });

    it("skips an empty summary and does not retry it", async () => {
      const t = rig(sum);
      await t.notifier.check(at(9));
      await t.notifier.check(at(9, 30));
      expect(t.sent).toHaveLength(0);
      t.runs.push(done("s1", at(9, 40).toISOString()));
      await t.notifier.check(at(10));
      expect(t.sent).toHaveLength(0);
    });

    it("waits for the end of quiet hours", async () => {
      const t = rig({ ...sum, quiet_hours: { from: "08:00", to: "10:00" } });
      t.runs.push(done("s1", at(5).toISOString()));
      await t.notifier.check(at(9));
      expect(t.sent).toHaveLength(0);
      await t.notifier.check(at(10));
      expect(t.sent).toHaveLength(1);
    });

    it("scheduled in overnight quiet hours is sent when they end", async () => {
      const t = rig({ daily_summary_at: "23:00", quiet_hours: { from: "22:00", to: "07:00" } });
      t.runs.push(done("s1", at(20).toISOString()));
      await t.notifier.check(at(21, 30));
      await t.notifier.check(at(23));
      expect(t.sent).toHaveLength(0);
      await t.notifier.check(at(7, 0, 2));
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]!.title).toBe("Foundry · daily summary");
      await t.notifier.check(at(8, 0, 2));
      expect(t.sent).toHaveLength(1);
    });

    it("goes after a new item and through the throttle, without repeating the item", async () => {
      const t = rig(sum);
      t.runs.push(done("s1", at(5).toISOString()));
      t.holds(qh(3));
      await t.notifier.check(at(9));
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]).toMatchObject({ title: "Foundry · your turn", url: issueUrl(3) });
      await t.notifier.check(at(9, 2));
      expect(t.sent).toHaveLength(1);
      await t.notifier.check(at(9, 5));
      expect(t.sent).toHaveLength(2);
      expect(t.sent[1]!.title).toBe("Foundry · daily summary");
      expect(t.sent[1]!.message).toContain("Waiting for you: 1.");
    });

    it("names the release only when it is still today", async () => {
      const release = { id: "rel", github_repo: "acme/app", source: "schedule", flow: "release-daily", at: "17:00", task: "release" };
      const running = run("r1", { status: "running", reason: undefined, finishedAt: undefined, vars: { github_repo: "acme/app", issue: "3" }, flowDef: { steps: [{ id: "push_develop" }] }, source: "ui" });
      const message = async (when: string, now: Date) => {
        rmSync(join(home, "notifications.json"), { force: true });
        const t = rig();
        t.state.config = ConfigSchema.parse({ watchers: [issuesWatcher, release], notify: { ...channel, daily_summary_at: when } });
        t.runs.push(running);
        await t.notifier.check(now);
        return t.sent[0]?.message;
      };
      expect(await message("09:00", at(9))).toContain("1 story being built, release pull request around 17:00");
      expect(await message("18:00", at(18))).toBe("Done since yesterday: nothing. Waiting for you: nothing. Expected today: 1 story being built.");
    });
  });

  it("sends one notice for two overlapping checks", async () => {
    const t = rig();
    t.holds(qh(3));
    t.slow.ms = 30;
    await Promise.all([t.notifier.check(min(0)), t.notifier.check(min(0))]);
    expect(t.sent).toHaveLength(1);
  });

  it("does nothing without a channel", async () => {
    const t = rig({ slack_webhook: undefined });
    t.holds(qh(3));
    await t.notifier.check(min(0));
    expect(t.sent).toHaveLength(0);
    expect(existsSync(join(home, "notifications.json"))).toBe(false);
  });

  it("reads a broken state file as empty", async () => {
    const t = rig();
    t.holds(qh(3));
    writeFileSync(join(home, "notifications.json"), "{ not json");
    await t.notifier.check(min(0));
    expect(t.sent).toHaveLength(1);
  });

  it("tries again at the next check when no channel got the notice", async () => {
    const t = rig();
    const tries: Notice[] = [];
    let ok = false;
    const n = new TurnNotifier(t.ctx, { baseUrl: BASE, timeZone: "UTC", send: async (x) => (tries.push(x), ok) });
    t.holds(qh(3));
    await n.check(min(0));
    ok = true;
    await n.check(min(1));
    await n.check(min(2));
    expect(tries).toHaveLength(2);
  });

  it("counts a success that finishes before the first check after start", async () => {
    const t = rig({ successes: true });
    const n = t.make();
    n.start(3_600_000);
    n.stop();
    t.runs.push(done("s1", new Date(Date.now() + 1000).toISOString()));
    await n.check(new Date(Date.now() + 5000));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.title).toBe("Foundry · run succeeded");
  });

  it("never throws", async () => {
    const t = rig();
    (t.ctx.scheduler as unknown as { list: () => never }).list = () => { throw new Error("boom"); };
    await expect(t.notifier.check(min(0))).resolves.toBeUndefined();
  });
});
