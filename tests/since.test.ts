import { describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import { buildSince, isReleaseBody, parseSince, storyOutcome, storyTitle, type MergedRead } from "../src/since.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const SINCE = new Date("2026-10-01T09:00:00Z");
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h, m)).toISOString();

const step = (id: string, ok = true, output = "") => ({ id, ok, output }) as never;
const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, flow: "github-issue", task: "t", vars: { github_repo: "o/a", issue: "7" }, status: "succeeded",
  startedAt: at(9, 30), finishedAt: at(10), history: [step("commit")], ...over,
}) as never as RunSummary;
const rec = (r: RunSummary, kind: Parameters<typeof nextStep>[0] = "failed"): NextStep =>
  nextStep(kind, { repo: r.vars.github_repo, issue: Number(r.vars.issue), title: "", runId: r.runId }, {});
const entry = (r: RunSummary, kind?: Parameters<typeof nextStep>[0]) => ({ run: r, next: rec(r, kind) });
const read = (over: Partial<MergedRead> = {}): MergedRead => ({ repo: "o/a", ok: true, full: false, prs: [], ...over });
const pr = (n: number, mergedAt: string, base = "main", url = `https://github.com/o/a/pull/${n}`) => ({ number: n, title: `PR ${n}`, url, mergedAt, baseRefName: base });
const build = (o: Partial<Parameters<typeof buildSince>[0]> = {}) => buildSince({ since: SINCE, now: NOW, runs: [], merged: [], waiting: [], ...o });
const ids = (s: ReturnType<typeof build>) => s.groups.map((g) => g.id);
const group = (s: ReturnType<typeof build>, id: string) => s.groups.find((g) => g.id === id);

describe("parseSince", () => {
  it("reads a time, clamps the future, rejects garbage", () => {
    expect(parseSince(null)).toBeUndefined();
    expect(parseSince("")).toBeUndefined();
    expect(parseSince("x")).toBeUndefined();
    expect(parseSince("2027-01-01T00:00:00Z", NOW)).toEqual(NOW);
    const old = new Date(NOW.getTime() - 400 * 86_400_000);
    expect(parseSince(old.toISOString(), NOW)).toEqual(old);
  });
});

describe("isReleaseBody", () => {
  it("accepts only the release and daily markers", () => {
    expect(isReleaseBody("x\n<!-- claude-factory run=abc release -->")).toBe(true);
    expect(isReleaseBody("<!-- claude-factory run=abc daily -->")).toBe(true);
    expect(isReleaseBody("<!-- claude-factory run= release -->")).toBe(true);
    expect(isReleaseBody("<!-- spaghetti-code-foundry run=abc release -->")).toBe(true);
    expect(isReleaseBody("<!-- claude-factory run=abc -->")).toBe(false);
    expect(isReleaseBody("<!-- claude-factory run=abc approval -->")).toBe(false);
    expect(isReleaseBody("<!-- claude-factory run=abc plan -->")).toBe(false);
    expect(isReleaseBody("")).toBe(false);
  });
});

describe("storyOutcome and storyTitle", () => {
  it("tells merged into develop from done", () => {
    expect(storyOutcome(run("a", { history: [step("push_develop")] }))).toBe("develop");
    expect(storyOutcome(run("a", { status: "failed", history: [step("push_develop"), step("report", false)] }))).toBe("develop");
    expect(storyOutcome(run("a", { history: [step("commit")] }))).toBe("done");
    expect(storyOutcome(run("a", { history: [step("push_develop", false), step("push_develop")] }))).toBe("develop");
    expect(storyOutcome(run("a", { history: [step("build/commit")] }))).toBe("done");
  });

  it("is undefined without a finished story", () => {
    expect(storyOutcome(run("a", { status: "failed", history: [step("commit")] }))).toBeUndefined();
    expect(storyOutcome(run("a", { history: [step("commit", false)] }))).toBeUndefined();
    expect(storyOutcome(run("a", { vars: { github_repo: "o/a" } }))).toBeUndefined();
    expect(storyOutcome(run("a", { vars: { github_repo: "o/a", issue: "x" } }))).toBeUndefined();
    expect(storyOutcome(run("a", { history: [step("create_split")] }))).toBeUndefined();
  });

  it("reads the title of the ticket", () => {
    expect(storyTitle(run("a", { history: [step("pull_ticket", true, "# #7: Add x\nhttps://…")] }))).toBe("Add x");
    expect(storyTitle(run("a", { history: [] }))).toBe("");
    expect(storyTitle(run("a", { history: [step("pull_ticket", true, "other")] }))).toBe("");
  });
});

describe("buildSince", () => {
  it("is empty and complete when nothing happened", () => {
    expect(build()).toMatchObject({ total: 0, complete: true, notes: [], groups: [] });
  });

  it("keeps a fixed group order and sums the total", () => {
    const w = { key: "k", repo: "o/a", what: "Q", next: nextStep("questions", { repo: "o/a", issue: 3, title: "Q" }, {}), unblocks: 0, dismissable: true, stamp: at(11) };
    const s = build({
      runs: [entry(run("f", { status: "failed", vars: { github_repo: "o/b", issue: "2" }, history: [] })), entry(run("d")), entry(run("p", { vars: { github_repo: "o/a", issue: "8" }, history: [step("push_develop")] }))],
      merged: [read({ prs: [pr(1, at(11))] })], waiting: [w],
    });
    expect(ids(s)).toEqual(["done", "develop", "released", "failed", "waiting"]);
    expect(s.total).toBe(5);
    expect(group(s, "waiting")!.items[0]).toMatchObject({ repo: "o/a", issue: 3, title: "Q" });
  });

  it("lets the run that finished last win, whatever the start order", () => {
    const early = run("early", { startedAt: at(9, 10), finishedAt: at(11, 30), history: [step("commit"), step("pull_ticket", true, "# #7: Late")] });
    const late = run("late", { startedAt: at(9, 20), finishedAt: at(10), history: [step("commit"), step("pull_ticket", true, "# #7: Early")] });
    const s = build({ runs: [entry(early), entry(late)] });
    expect(group(s, "done")!.items.map((i) => i.title)).toEqual(["Late"]);
    const two = build({ runs: [entry(late), entry(early), entry(run("o", { vars: { github_repo: "o/a", issue: "9" }, finishedAt: at(11) }))] });
    expect(group(two, "done")!.items.map((i) => i.issue)).toEqual([7, 9]);
  });

  it("lists a done story and a failed retry of it both", () => {
    const retry = run("retry", { status: "failed", finishedAt: at(11), history: [] });
    const s = build({ runs: [entry(run("ok")), entry(retry)] });
    expect(ids(s)).toEqual(["done", "failed"]);
    expect(group(s, "failed")!.items[0]!.where.url).toBe("#/runs/retry");
  });

  it("lists a failed run with a push to develop under both", () => {
    const r = run("r", { status: "failed", history: [step("push_develop"), step("report", false)] });
    expect(ids(build({ runs: [entry(r)] }))).toEqual(["develop", "failed"]);
  });

  it("shows one entry per story and counts and cuts a long list", () => {
    const two = build({ runs: [entry(run("a", { finishedAt: at(10) })), entry(run("b", { finishedAt: at(11) }))] });
    expect(group(two, "done")).toMatchObject({ count: 1 });
    const many = build({ runs: Array.from({ length: 7 }, (_, i) => entry(run(`r${i}`, { vars: { github_repo: "o/a", issue: String(i + 1) }, finishedAt: at(10, i) }))) });
    const g = group(many, "done")!;
    expect(g.count).toBe(7);
    expect(g.items.map((i) => i.issue)).toEqual([7, 6, 5, 4, 3]);
    expect(g.label).toBe("7 stories done");
    expect(group(build({ runs: [entry(run("a"))] }), "done")!.label).toBe("1 story done");
  });

  it("counts a time exactly at since as out and at now as in", () => {
    expect(build({ runs: [entry(run("a", { finishedAt: SINCE.toISOString() }))] }).total).toBe(0);
    expect(build({ runs: [entry(run("a", { finishedAt: NOW.toISOString() }))] }).total).toBe(1);
  });

  it("counts a release once, within the window, with its base", () => {
    const s = build({
      merged: [read({ prs: [pr(1, at(10)), pr(2, at(8)), pr(3, at(11), "main")] }), read({ repo: "o/b", prs: [pr(1, at(10), "main", "https://github.com/o/a/pull/1")] })],
    });
    const g = group(s, "released")!;
    expect(g.label).toBe("2 releases to main");
    expect(g.items.map((i) => i.where.url)).toEqual(["https://github.com/o/a/pull/3", "https://github.com/o/a/pull/1"]);
    expect(group(build({ merged: [read({ prs: [pr(1, at(10), "master")] })] }), "released")!.label).toBe("1 release to master");
  });

  it("leaves out failed runs that were replaced or interrupted, and falls back to the flow name", () => {
    const r = (id: string) => run(id, { status: "failed", history: [], vars: { github_repo: "o/a", issue: String(id.length) } });
    const s = build({ runs: [entry(r("a"), "superseded"), entry(r("bb"), "interrupted"), entry(r("ccc"))] });
    expect(group(s, "failed")!.items).toHaveLength(1);
    expect(group(s, "failed")!.items[0]!.title).toBe("github-issue");
  });

  it("filters newly waiting items", () => {
    const w = (key: string, stamp: string, over: Record<string, unknown> = {}) => ({
      key, repo: "o/a", what: key, next: nextStep("questions", { repo: "o/a", issue: 3, title: key }, {}), unblocks: 0, dismissable: true, stamp, ...over,
    }) as never;
    const release = nextStep("release", { repo: "o/a", title: "R" }, { prUrl: "https://github.com/o/a/pull/9" } as never);
    const failedRun = run("f", { status: "failed", history: [] });
    const s = build({
      runs: [entry(failedRun)],
      waiting: [w("new", at(11)), w("none", ""), w("old", at(8)), w("failed", at(11), { next: { ...rec(failedRun), runId: "f" } }), w("rel", at(11, 30), { next: release })],
    });
    expect(group(s, "waiting")!.items.map((i) => i.title)).toEqual(["rel", "new"]);
    expect(group(s, "waiting")!.items[0]!.where).toEqual(release.where);
  });

  it("says when GitHub could not be read or a limit was hit", () => {
    const s = build({ merged: [read({ repo: "o/a", ok: false }), read({ repo: "o/b", ok: false })], runs: [entry(run("a"))] });
    expect(s.complete).toBe(false);
    expect(s.notes).toEqual(["Releases of o/a, o/b could not be read from GitHub right now."]);
    expect(ids(s)).toEqual(["done"]);
    expect(build({ merged: [read({ full: true, oldest: at(10) })] })).toMatchObject({ complete: false, notes: ["Only the newest 200 merged pull requests of o/a were checked."] });
    expect(build({ merged: [read({ full: true })] }).complete).toBe(false);
    expect(build({ runsCut: true })).toMatchObject({ complete: false, notes: ["Only the newest 2000 finished runs were checked."] });
    expect(build({ reposCut: true })).toMatchObject({ complete: false, notes: ["Only the first 20 repositories were checked for releases."] });
  });

  it("is complete when a full read reaches back before the window", () => {
    expect(build({ merged: [read({ full: true, oldest: at(8) })] })).toMatchObject({ complete: true, notes: [] });
  });
});
