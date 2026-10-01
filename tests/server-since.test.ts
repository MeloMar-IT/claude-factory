import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { nextStep } from "../src/next-step.js";
import type { MergedRead } from "../src/since.js";
import type { ApiContext } from "../src/server/server.js";
import { mergedPrs, sinceFor } from "../src/server/since.js";
import { dismissTurn, turnFor } from "../src/server/your-turn.js";
import { fakeGithub } from "./helpers/fake-github.js";

// "Since you last looked" against a stub context (no server) and the fake gh.

const NOW = new Date("2026-10-01T12:00:00Z");
const SINCE = new Date("2026-10-01T09:00:00Z");
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h, m)).toISOString();
const cfg = (watchers: Record<string, unknown>[] = []) => ConfigSchema.parse({ watchers });
const issuesWatcher = { id: "a", github_repo: "acme/app", flow: "github-issue" };

const step = (id: string, ok = true) => ({ id, ok, output: "" });
const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, flow: "github-issue", flowDef: { steps: [] }, task: `task ${runId}`, vars: { github_repo: "acme/app", issue: "7" }, repo: "/x",
  status: "succeeded", runDir: "/tmp/none", startedAt: at(9, 30), finishedAt: at(10), history: [step("commit")],
  state: { next: null, steps: {}, visits: {} }, totalCostUsd: 0, ...over,
}) as never as import("../src/engine/state.js").RunSummary;

type Tracked = { watcher: unknown; status: Record<string, unknown>; issues: { issue: number; title: string; runId?: string }[] };

function stub(o: { config?: ReturnType<typeof cfg>; runs?: ReturnType<typeof run>[]; tracked?: Tracked[] } = {}) {
  const runs = o.runs ?? [];
  const config = o.config ?? cfg();
  return {
    config: () => config,
    scheduler: {
      list: (n = 100) => runs.slice(0, n),
      get: (id: string) => runs.find((r) => r.runId === id),
      briefs: () => runs.map((r) => ({ runId: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, source: r.source, runDir: r.runDir })),
      queue: () => ({ pending: [], active: [] }),
    },
    watchers: { tracked: () => o.tracked ?? [] },
  } as unknown as ApiContext;
}

const none = (repo: string): Promise<MergedRead> => Promise.resolve({ repo, ok: true, full: false, prs: [] });
const ids = (s: Awaited<ReturnType<typeof sinceFor>>) => Object.fromEntries(s.groups.map((g) => [g.id, g.items.map((i) => i.issue ?? i.title)]));

let home: string;
let saved: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "factory-since-"));
  saved = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("sinceFor", () => {
  it("puts done, develop, failed and waiting items in their groups", async () => {
    const c = cfg([issuesWatcher]);
    const question = nextStep("questions", { repo: "acme/app", issue: 3, title: "T3" }, { watched: true, questions: 1 });
    const tracked: Tracked = {
      watcher: c.watchers[0], status: { id: "a", lastActions: [], holds: [{ issue: 3, reason: "q", next: question, since: at(11) }] },
      issues: [{ issue: 3, title: "T3" }],
    };
    const runs = [
      run("done", { vars: { github_repo: "acme/app", issue: "1" }, source: "watcher a issue #1" }),
      run("dev", { vars: { github_repo: "acme/app", issue: "2" }, history: [step("push_develop")], source: "watcher a issue #2" }),
      run("bad", { status: "failed", vars: { github_repo: "acme/other" }, history: [], source: "ui", finishedAt: at(11, 30) }),
    ];
    const s = await sinceFor(stub({ config: c, runs, tracked: [tracked] }), SINCE, NOW, { prs: none });
    expect(ids(s)).toEqual({ done: [1], develop: [2], failed: ["task bad"], waiting: [3] });
    expect(s.groups.find((g) => g.id === "failed")!.items[0]!.where.url).toBe("#/runs/bad");
    expect(s).toMatchObject({ total: 4, complete: true, notes: [] });
  });

  it("does not list a failed hand-started run as newly waiting", async () => {
    const bad = run("bad", { status: "failed", history: [], source: "ui", vars: { github_repo: "acme/x" } });
    const s = await sinceFor(stub({ runs: [bad] }), SINCE, NOW, { prs: none });
    expect(s.groups.map((g) => g.id)).toEqual(["failed"]);
  });

  it("does not list a dismissed item as newly waiting", async () => {
    const c = cfg([issuesWatcher]);
    const question = nextStep("questions", { repo: "acme/app", issue: 3, title: "T3" }, { watched: true, questions: 1 });
    const ctx = () => stub({ config: c, tracked: [{ watcher: c.watchers[0], status: { id: "a", lastActions: [], holds: [{ issue: 3, reason: "q", next: question, since: at(11) }] }, issues: [{ issue: 3, title: "T3" }] }] });
    expect((await sinceFor(ctx(), SINCE, NOW, { prs: none })).groups.map((g) => g.id)).toEqual(["waiting"]);
    dismissTurn(ctx(), turnFor(ctx(), NOW).all[0]!.key, NOW);
    expect((await sinceFor(ctx(), SINCE, NOW, { prs: none })).total).toBe(0);
  });

  it("skips eval runs, also those of an older version, and does not ask for their repository", async () => {
    mkdirSync(join(home, "evals"), { recursive: true });
    writeFileSync(join(home, "evals", "s-1.json"), JSON.stringify({ results: [{ runId: "old-eval" }] }));
    const runs = [
      run("e", { source: "eval x", vars: { github_repo: "ev/one", issue: "1" } }),
      run("old-eval", { vars: { github_repo: "ev/two", issue: "2" } }),
    ];
    const prs = vi.fn(none);
    const s = await sinceFor(stub({ runs }), SINCE, NOW, { prs });
    expect(s.total).toBe(0);
    expect(prs).not.toHaveBeenCalled();
  });

  it("lists the run that finished last when two runs of a story overlap", async () => {
    const early = run("early", { startedAt: at(9, 10), finishedAt: at(11, 30) });
    const late = run("late", { startedAt: at(9, 20), finishedAt: at(10), history: [step("push_develop")] });
    const s = await sinceFor(stub({ runs: [early, late] }), SINCE, NOW, { prs: none });
    expect(Object.keys(ids(s))).toEqual(["done"]);
  });

  it("does not list an older failed run that a newer run of the same issue replaced", async () => {
    const older = run("old", { status: "failed", history: [], startedAt: at(9, 10), finishedAt: at(9, 30), source: "watcher a issue #7" });
    const newer = run("new", { startedAt: at(10), finishedAt: at(10, 30), source: "watcher a issue #7" });
    const s = await sinceFor(stub({ runs: [newer, older] }), SINCE, NOW, { prs: none });
    expect(Object.keys(ids(s))).toEqual(["done"]);
  });

  it("checks only the newest runs and says so", async () => {
    const runs = Array.from({ length: 5 }, (_, i) => run(`r${i}`, { vars: { github_repo: "acme/app", issue: String(i + 1) }, finishedAt: at(10, i) }));
    const s = await sinceFor(stub({ runs }), SINCE, NOW, { prs: none, maxRuns: 3 });
    expect(ids(s).done).toEqual([5, 4, 3]);
    expect(s.notes).toEqual(["Only the newest 2000 finished runs were checked."]);
  });

  it("asks once for each repository: watchers (also disabled) and runs in the window", async () => {
    const c = cfg([issuesWatcher, { ...issuesWatcher, id: "b", enabled: false }, { id: "c", github_repo: "acme/two", flow: "github-issue", enabled: false }]);
    const runs = [run("hand", { source: "ui", vars: { github_repo: "acme/three", issue: "1" } }), run("bad-repo", { vars: { github_repo: "not a repo", issue: "2" } })];
    const prs = vi.fn(none);
    await sinceFor(stub({ config: c, runs }), SINCE, NOW, { prs });
    expect(prs.mock.calls.map((x) => x[0])).toEqual(["acme/app", "acme/two", "acme/three"]);
  });

  it("finds a release in a watched repository without any run, and says when repositories were left out", async () => {
    const c = cfg([issuesWatcher]);
    const prs = (repo: string): Promise<MergedRead> =>
      Promise.resolve({ repo, ok: true, full: false, prs: repo === "acme/app" ? [{ number: 9, title: "Rel", url: "https://github.com/acme/app/pull/9", mergedAt: at(11), baseRefName: "main" }] : [] });
    const s = await sinceFor(stub({ config: c }), SINCE, NOW, { prs });
    expect(Object.keys(ids(s))).toEqual(["released"]);
    expect(s.complete).toBe(true);

    const many = cfg(Array.from({ length: 22 }, (_, i) => ({ id: `w${i}`, github_repo: `acme/r${i}`, flow: "github-issue" })));
    const asked = vi.fn(none);
    const cut = await sinceFor(stub({ config: many }), SINCE, NOW, { prs: asked });
    expect(asked).toHaveBeenCalledTimes(20);
    expect(cut).toMatchObject({ complete: false, notes: ["Only the first 20 repositories were checked for releases."] });
  });

  it("asks for the repository of an older manual run, not of an eval run", async () => {
    const runs = [
      run("old", { source: "ui", vars: { github_repo: "acme/manual", issue: "1" }, startedAt: at(1), finishedAt: at(2) }),
      run("ev", { source: "eval x", vars: { github_repo: "acme/eval", issue: "2" }, startedAt: at(1), finishedAt: at(2) }),
    ];
    const prs = vi.fn(none);
    await sinceFor(stub({ runs }), SINCE, NOW, { prs });
    expect(prs.mock.calls.map((x) => x[0])).toEqual(["acme/manual"]);
  });

  it("is incomplete when a read fails or rejects, and keeps the other groups", async () => {
    const c = cfg([issuesWatcher, { id: "b", github_repo: "acme/two", flow: "github-issue" }]);
    const prs = (repo: string): Promise<MergedRead> => (repo === "acme/app" ? Promise.reject(new Error("x")) : Promise.resolve({ repo, ok: false, full: false, prs: [] }));
    const s = await sinceFor(stub({ config: c, runs: [run("a")] }), SINCE, NOW, { prs });
    expect(s.complete).toBe(false);
    expect(s.notes).toEqual(["Releases of acme/app, acme/two could not be read from GitHub right now."]);
    expect(Object.keys(ids(s))).toEqual(["done"]);
  });
});

describe("mergedPrs", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let repoN = 0;
  const repo = () => `own/r${++repoN}-${process.pid}`;
  const body = (marker: string) => `text\n<!-- claude-factory run=abc${marker} -->`;
  const pr = (n: number, b: string) => ({ number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, mergedAt: at(10), baseRefName: "main", body: b });
  const calls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh pr list")).length;
  beforeEach(() => { gh = fakeGithub(); });
  afterEach(() => gh.restore());

  it("keeps release and daily pull requests, drops others and the body", async () => {
    process.env.FAKE_GH_MERGED_PRS = JSON.stringify([pr(1, body(" release")), pr(2, body(" daily")), pr(3, body("")), pr(4, "no marker")]);
    const r = await mergedPrs(repo());
    expect(r).toMatchObject({ ok: true, full: false });
    expect(r.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(r.prs[0]).not.toHaveProperty("body");
    expect(gh.ghLog()).toContain("--state merged");
  });

  it("reuses an answer for 15 seconds", async () => {
    process.env.FAKE_GH_MERGED_PRS = "[]";
    const name = repo();
    await mergedPrs(name, 8000, 1_000_000);
    await mergedPrs(name, 8000, 1_000_000);
    expect(calls()).toBe(1);
    await mergedPrs(name, 8000, 1_016_000);
    expect(calls()).toBe(2);
  });

  it("marks a full list", async () => {
    process.env.FAKE_GH_MERGED_PRS = JSON.stringify(Array.from({ length: 200 }, (_, i) => pr(i, body(" release"))));
    expect((await mergedPrs(repo())).full).toBe(true);
  });

  it("does not keep a failure", async () => {
    process.env.FAKE_GH_MERGED_PRS = JSON.stringify([pr(1, body(" release"))]);
    const name = repo();
    const good = process.env.FACTORY_GH_BIN;
    process.env.FACTORY_GH_BIN = join(gh.tmp, "missing");
    expect(await mergedPrs(name)).toMatchObject({ ok: false, prs: [] });
    if (good === undefined) delete process.env.FACTORY_GH_BIN;
    else process.env.FACTORY_GH_BIN = good;
    expect((await mergedPrs(name)).prs).toHaveLength(1);
  });

  it("gives up on a gh that hangs", async () => {
    const bin = join(gh.tmp, "slow-gh");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 5\n");
    chmodSync(bin, 0o755);
    process.env.FACTORY_GH_BIN = bin;
    const t = Date.now();
    expect(await mergedPrs(repo(), 200)).toMatchObject({ ok: false });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
