import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyClarity, missing, newerClarity, onTurn, parseClarity, sampleState, summarize, candidateId,
  type Candidate, type ClarityState, type SampleItem, type Wait,
} from "../src/clarity.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import { ClarityRecorder, candidatesFor, clarityFor, sampleClarity } from "../src/server/clarity.js";
import { turnFor } from "../src/server/your-turn.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { NOW, REPO, SCENARIOS, ago, cfg, hold, issuesWatcher, run, scenarioCtx, track, type World } from "./helpers/scenarios.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MIN = 60_000;
const at = (min: number) => new Date(NOW.getTime() + min * MIN);
const iso = (min: number) => at(min).toISOString();
const item = (key: string, over: Partial<SampleItem> = {}): SampleItem => ({ key, repo: REPO, issue: 1, kind: "questions", since: iso(-10), stamp: iso(-10), dismissed: false, acted: false, ...over });
const sample = (s: ClarityState, items: SampleItem[], min: number, extra: { missing?: { id: string; status: string }[]; unsettled?: Set<string> } = {}) =>
  sampleState(s, { items, missing: extra.missing ?? [], unsettled: extra.unsettled }, at(min));
const open = (s: ClarityState) => s.waits.filter((w) => w.until === undefined);

describe("waits", () => {
  it("a new item opens a wait at its since; a missing, invalid or future since uses the sample time", () => {
    let s = sample(emptyClarity(), [item("a")], 0);
    expect(s.waits[0]).toMatchObject({ key: "a", since: iso(-10) });
    for (const since of [undefined, "nonsense", iso(30)]) {
      s = sample(emptyClarity(), [item("a", { since })], 0);
      expect(s.waits[0]!.since).toBe(iso(0));
    }
  });

  it("an item that is gone closes with ms = until - since", () => {
    let s = sample(emptyClarity(), [item("a")], 0);
    s = sample(s, [], 5);
    expect(s.waits[0]).toMatchObject({ until: iso(5), ms: 15 * MIN });
  });

  it("a changed stamp closes the old wait and opens a new one", () => {
    let s = sample(emptyClarity(), [item("a")], 0);
    s = sample(s, [item("a", { stamp: iso(1), since: iso(1) })], 2);
    expect(s.waits).toHaveLength(2);
    expect(s.waits[0]!.until).toBe(iso(2));
    expect(open(s)[0]!.since).toBe(iso(1));
  });

  it("acted: the wait ends when the item was first seen as done, not at the later sample", () => {
    let s = sample(emptyClarity(), [item("a")], 0);
    s = sample(s, [item("a", { acted: true })], 1);
    expect(s.waits[0]!.actedAt).toBe(iso(1));
    s = sample(s, [item("a", { acted: true })], 2);
    expect(s.waits[0]!.actedAt).toBe(iso(1));
    s = sample(s, [], 3);
    expect(s.waits[0]).toMatchObject({ until: iso(1), ms: 11 * MIN });
  });

  it("acted: an item that returns to the list clears actedAt and stays one wait", () => {
    let s = sample(emptyClarity(), [item("a")], 0);
    s = sample(s, [item("a", { acted: true })], 1);
    s = sample(s, [item("a")], 2);
    expect(s.waits).toHaveLength(1);
    expect(s.waits[0]!.actedAt).toBeUndefined();
    expect(s.waits[0]!.since).toBe(iso(-10));
    expect(s.waits[0]!.until).toBeUndefined();
  });

  it("a wait of an unsettled watcher stays open until the watcher is settled or gone", () => {
    let s = sample(emptyClarity(), [item("a", { watcher: "w" })], 0);
    s = sample(s, [], 1, { unsettled: new Set(["w"]) });
    expect(open(s)).toHaveLength(1);
    expect(sample(s, [], 2, { unsettled: new Set() }).waits[0]!.until).toBe(iso(2));
    expect(sample(s, [], 2).waits[0]!.until).toBe(iso(2));
  });

  it("a dismissed wait is flagged and left out of the numbers but counted apart", () => {
    let s = sample(emptyClarity(), [item("a", { dismissed: true }), item("b")], 0);
    expect(s.waits[0]!.dismissed).toBe(true);
    s = sample(s, [], 10);
    const sum = summarize(s, at(10));
    expect(sum).toMatchObject({ count: 1, dismissed: 1, halfMs: 20 * MIN, longestMs: 20 * MIN });
  });

  it("waits are keyed by item key", () => {
    const s = sample(emptyClarity(), [item("release|urlA"), item("release|urlB"), item("error|a"), item("error|b")], 0);
    expect(open(s).map((w) => w.key)).toEqual(["release|urlA", "release|urlB", "error|a", "error|b"]);
    expect(open(sample(s, [item("release|urlA"), item("error|b")], 1))).toHaveLength(2);
  });

  it("drops waits older than 90 days and keeps at most 500", () => {
    const old: Wait = { key: "o", repo: REPO, kind: "q", since: ago(100), until: ago(95), ms: 5 * 86_400_000, stamp: "" };
    const s = sample({ ...emptyClarity(), waits: [old] }, [], 0);
    expect(s.waits).toHaveLength(0);
    const many = Array.from({ length: 520 }, (_, i): Wait => ({ key: `k${i}`, repo: REPO, kind: "q", since: iso(-20), until: iso(-10), ms: 10 * MIN, stamp: "" }));
    expect(sample({ ...emptyClarity(), waits: many }, [], 0).waits).toHaveLength(500);
  });
});

describe("what is missing", () => {
  const rec = (kind: Parameters<typeof nextStep>[0], base: Parameters<typeof nextStep>[1] = {}, d: Parameters<typeof nextStep>[2] = {}) => nextStep(kind, { repo: REPO, ...base }, d);
  const listedItem = (key: string, next: NextStep) => ({ key, next });

  it("onTurn matches by run, story, release URL and key, and nothing else", () => {
    const q = rec("questions", { issue: 3, runId: "r3" });
    expect(onTurn({ next: q }, [listedItem("x", rec("approval", { runId: "r3" }))])).toBe(true);
    expect(onTurn({ next: q }, [listedItem("x", rec("approval", { issue: 3 }))])).toBe(true);
    const pr = { number: 9, url: "https://github.com/acme/app/pull/9" };
    expect(onTurn({ next: rec("release", {}, { pr }) }, [listedItem("x", rec("release", { issue: 4 }, { pr }))])).toBe(true);
    expect(onTurn({ next: rec("watcher_error"), key: "error|a" }, [listedItem("error|a", rec("watcher_error"))])).toBe(true);
    expect(onTurn({ next: q }, [listedItem("x", rec("approval", { issue: 4, runId: "r4" })), listedItem("y", rec("approval", { repo: "o/other", issue: 3 }))])).toBe(false);
  });

  it("ignores records that do not need the user (also cancelled) and returns one per id", () => {
    const need = { next: rec("questions", { issue: 3 }) };
    const out = missing([{ next: rec("running", { issue: 5 }) }, { next: rec("cancelled", { issue: 6 }) }, need, need], []);
    expect(out).toEqual([{ id: `${REPO}#3`, status: need.next.status }]);
  });

  it("two release pull requests in one repository are two candidates; with one on Your turn the other is returned", () => {
    const a = rec("release", {}, { pr: { number: 1, url: "https://x/pull/1" } });
    const b = rec("release", {}, { pr: { number: 2, url: "https://x/pull/2" } });
    expect(missing([{ next: a }, { next: b }], [])).toHaveLength(2);
    expect(missing([{ next: a }, { next: b }], [listedItem(`release|https://x/pull/1`, a)]).map((m) => m.id)).toEqual([candidateId({ next: b })]);
  });

  it("two failing watchers of one repository likewise", () => {
    const c = (id: string): Candidate => ({ next: rec("watcher_error", {}, { reason: "gh" }), key: `error|${id}`, watcher: id });
    expect(missing([c("a"), c("b")], [])).toHaveLength(2);
    expect(missing([c("a"), c("b")], [listedItem("error|a", c("a").next)]).map((m) => m.id)).toHaveLength(1);
  });

  it("a repository that is a path gives an id without the path", () => {
    const id = candidateId({ next: rec("approval", { repo: "/Users/me/secret/project", runId: "r1" }) });
    expect(id).toBe("run r1");
    expect(id).not.toContain("/Users");
  });
});

describe("misses", () => {
  const gone = [{ id: "acme/app#7", status: "waiting for you — questions" }];

  it("counts at the second sample in a row, and forgets a suspect that is fine at the next sample", () => {
    let s = sample(emptyClarity(), [], 0, { missing: gone });
    expect(s.missed).toBe(0);
    s = sample(s, [], 1, { missing: gone });
    expect(s.missed).toBe(1);
    expect(s.misses[0]).toMatchObject({ id: "acme/app#7", since: iso(0), lastSeen: iso(1) });
    let t = sample(emptyClarity(), [], 0, { missing: gone });
    t = sample(t, [], 1);
    t = sample(t, [], 2, { missing: gone });
    expect(t.missed).toBe(0);
  });

  it("an open incident seen again only moves lastSeen", () => {
    let s = sample(emptyClarity(), [], 0, { missing: gone });
    s = sample(s, [], 1, { missing: gone });
    s = sample(s, [], 2, { missing: gone });
    expect(s.missed).toBe(1);
    expect(s.misses).toHaveLength(1);
    expect(s.misses[0]!.lastSeen).toBe(iso(2));
  });

  it("missing, present, missing counts twice", () => {
    let s = emptyClarity();
    for (const [m, miss] of [[0, true], [1, true], [2, false], [3, true], [4, true]] as const) s = sample(s, [], m, { missing: miss ? gone : [] });
    expect(s.missed).toBe(2);
    expect(s.misses).toHaveLength(2);
    expect(s.misses[0]!.until).toBe(iso(2));
    expect(s.misses[1]!.until).toBeUndefined();
  });

  it("keeps at most 50 misses while missed keeps counting", () => {
    let s = emptyClarity();
    for (let i = 0; i < 60; i++) {
      const m = [{ id: `x${i}`, status: "s" }];
      s = sample(s, [], i * 2, { missing: m });
      s = sample(s, [], i * 2 + 1, { missing: m });
    }
    expect(s.missed).toBe(60);
    expect(s.misses).toHaveLength(50);
  });
});

describe("persistent misses", () => {
  it("keeps every active incident, so 51 omissions are counted once each across samples", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, status: "s" }));
    let s = emptyClarity();
    for (let m = 0; m < 5; m++) s = sample(s, [], m, { missing: many });
    expect(s.missed).toBe(51);
    expect(s.misses).toHaveLength(51);
  });
});

describe("parse and summarize", () => {
  it("a wrong shape reads as empty; a valid state round-trips", () => {
    for (const bad of [undefined, "x", [], { version: 1, waits: "x", misses: [], suspects: {}, missed: 0 }, { version: 1, waits: [{ key: 1 }], misses: [], suspects: {}, missed: 0 }, { version: 1, waits: [], misses: [], suspects: {}, missed: "0" }]) {
      expect(parseClarity(bad)).toEqual(emptyClarity());
    }
    let s = sample(emptyClarity(), [item("a")], 0);
    s = sample(s, [], 1, { missing: [{ id: "i", status: "s" }] });
    expect(parseClarity(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("newerClarity is true only for a higher number", () => {
    expect(newerClarity({ version: 2 })).toBe(true);
    expect(newerClarity({ version: 1 })).toBe(false);
    expect(newerClarity({})).toBe(false);
    expect(newerClarity({ version: "2" })).toBe(false);
  });

  const waitMs = (ms: number[], base = -1): ClarityState => ({
    ...emptyClarity(),
    waits: ms.map((m, i): Wait => ({ key: `k${i}`, repo: REPO, kind: "q", since: iso(base - 100), until: iso(base), ms: m * MIN, stamp: "" })),
  });

  it("halfMs and longest: one wait, odd, even (the lower middle one)", () => {
    expect(summarize(waitMs([7]), NOW)).toMatchObject({ count: 1, halfMs: 7 * MIN, longestMs: 7 * MIN });
    expect(summarize(waitMs([9, 1, 5]), NOW)).toMatchObject({ halfMs: 5 * MIN, longestMs: 9 * MIN });
    expect(summarize(waitMs([8, 1, 5, 2]), NOW)).toMatchObject({ halfMs: 2 * MIN, longestMs: 8 * MIN });
    const none = summarize(emptyClarity(), NOW);
    expect(none.count).toBe(0);
    expect(none.halfMs).toBeUndefined();
  });

  it("counts only the last 30 days, missedNow, and the newest 5 misses", () => {
    const s = waitMs([5]);
    s.waits.push({ key: "old", repo: REPO, kind: "q", since: ago(60), until: ago(40), ms: 99 * MIN, stamp: "" });
    s.missed = 7;
    s.misses = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, status: "s", since: iso(0), lastSeen: iso(0), ...(i < 6 ? { until: iso(1) } : {}) }));
    const sum = summarize(s, NOW);
    expect(sum).toMatchObject({ count: 1, longestMs: 5 * MIN, missed: 7, missedNow: 1 });
    expect(sum.misses.map((m) => m.id)).toEqual(["m6", "m5", "m4", "m3", "m2"]);
  });
});

// --- server ---

let home: string;
const savedHome = process.env.FACTORY_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "clarity-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const file = () => join(home, "clarity.json");
const c0 = cfg([issuesWatcher]);
const ids = (w: World) => candidatesFor(scenarioCtx(w), NOW).map(candidateId);
const handFailed = (id: string, days: number, over: Record<string, unknown> = {}) => run(id, { vars: {}, source: "ui", status: "failed", finishedAt: ago(days), startedAt: ago(days), ...over });
const releaseHold = hold(nextStep("release", { repo: REPO, title: "" }, { watched: true, pr: { number: 9, url: `https://github.com/${REPO}/pull/9` } }), { since: ago(1) });

describe("the sample", () => {
  it("writes clarity.json and leaves no temporary file", () => {
    sampleClarity(scenarioCtx(scenario("questions").world), NOW);
    expect(existsSync(file())).toBe(true);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a question opens a wait; after it is gone the wait is finished", () => {
    const s = scenario("questions");
    sampleClarity(scenarioCtx(s.world), NOW);
    expect(open(parseClarity(JSON.parse(readFileSync(file(), "utf8"))))).toHaveLength(1);
    const state = sampleClarity(scenarioCtx({ ...s.world, tracked: [track(c0, [], [])] }), at(5))!;
    expect(open(state)).toHaveLength(0);
    expect(state.waits[0]!.until).toBe(iso(5));
  });

  it("a broken file reads as empty and is replaced", () => {
    writeFileSync(file(), "{ nope");
    const state = sampleClarity(scenarioCtx(scenario("questions").world), NOW)!;
    expect(state.waits).toHaveLength(1);
    expect(() => JSON.parse(readFileSync(file(), "utf8"))).not.toThrow();
  });

  it("a file of a newer version is left alone, and the recorder says so once", () => {
    writeFileSync(file(), JSON.stringify({ version: 2, keep: "me" }));
    const before = readFileSync(file());
    const ctx = scenarioCtx(scenario("questions").world);
    expect(sampleClarity(ctx, NOW)).toBeUndefined();
    expect(readFileSync(file()).equals(before)).toBe(true);
    const log = vi.fn();
    const rec = new ClarityRecorder(ctx, { log });
    rec.check(NOW);
    rec.check(at(1));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/newer version/);
  });

  it("the recorder does not throw when the scheduler does, and logs one line", () => {
    const ctx = scenarioCtx({ config: c0, runs: [], tracked: [] });
    (ctx.scheduler as any).list = () => { throw new Error("disk gone"); };
    const log = vi.fn();
    expect(() => new ClarityRecorder(ctx, { log }).check(NOW)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("disk gone");
  });

  it("start(0) starts no timer and stop() twice is fine", () => {
    const rec = new ClarityRecorder(scenarioCtx({ config: c0, runs: [], tracked: [] }));
    rec.start(0);
    expect((rec as any).timer).toBeUndefined();
    rec.start(60_000);
    expect((rec as any).timer).toBeDefined();
    rec.stop();
    expect(() => rec.stop()).not.toThrow();
  });

  it("clarityFor gives the number waiting now and the oldest since", () => {
    const q = scenario("questions");
    const w: World = { ...q.world, tracked: [track(c0, [hold(q.record(), { since: ago(2) })], [{ issue: 42, title: "T" }])] };
    const ctx = scenarioCtx(w);
    const a = clarityFor(ctx, NOW);
    expect(a.waitingNow).toBe(turnFor(ctx, NOW).data.count);
    expect(a.waitingNow).toBe(1);
    expect(a.oldestSince).toBe(ago(2));
    expect(a.sampled).toBe(false);
  });
});

describe("the candidates", () => {
  it("come from the Board, a watcher's error, an issue-less release hold and runs started by hand", () => {
    expect(ids(scenario("questions").world)).toEqual([`${REPO}#42`]);
    expect(ids(scenario("watcher-error").world)).toEqual([`${REPO} error|a`]);
    expect(ids({ config: c0, runs: [], tracked: [track(c0, [releaseHold], [])] })).toEqual([`${REPO} release https://github.com/${REPO}/pull/9`]);
    expect(ids(scenario("approval-by-hand").world)).toEqual(["run r50"]);
    expect(ids({ config: c0, runs: [handFailed("h1", 1 / 24)], tracked: [] })).toEqual(["run h1"]);
  });

  it("leave out an eval run, an old failed run, a stale watcher while restarting, and a waiting watcher run before the watcher's first good check", () => {
    expect(ids({ config: c0, runs: [handFailed("e1", 1 / 24, { source: "eval smoke" })], tracked: [] })).toEqual([]);
    expect(ids({ config: c0, runs: [handFailed("h2", 2)], tracked: [] })).toEqual([]);
    const stale = { config: c0, runs: [], tracked: [track(c0, [], [], { lastTick: ago(5) })] };
    expect(ids(stale)).toHaveLength(1);
    expect(ids({ ...stale, restart: { why: "new_version", since: ago(0) } })).toEqual([]);
    const waiting = run("w1", { vars: { github_repo: REPO, issue: "9" }, source: "watcher a issues", status: "waiting", finishedAt: undefined, waiting: { stepId: "gate", message: "ok?", since: ago(1) } });
    expect(ids({ config: c0, runs: [waiting], tracked: [track(c0, [], [], { lastOk: undefined })] })).toEqual([]);
  });
});

describe("a deliberate omission is caught, the real Your turn is not", () => {
  const cases: [string, World, (key: string) => boolean][] = [
    ["a Board card", scenario("questions").world, () => true],
    ["a watcher's error", scenario("watcher-error").world, () => true],
    ["an issue-less release hold", { config: c0, runs: [], tracked: [track(c0, [releaseHold], [])] }, () => true],
    ["a waiting run started by hand", scenario("approval-by-hand").world, () => true],
    ["a failed run started by hand", { config: c0, runs: [handFailed("h1", 1 / 24)], tracked: [] }, () => true],
  ];
  it.each(cases)("%s", (_name, world) => {
    const ctx = scenarioCtx(world);
    const real = turnFor(ctx, NOW);
    expect(real.all.length).toBeGreaterThan(0);
    const cut = { all: [] as typeof real.all, data: { ...real.data, count: 0, groups: [], continuing: [] } };
    sampleClarity(ctx, NOW, cut);
    const state = sampleClarity(ctx, at(1), cut)!;
    expect(state.missed).toBe(1);
    expect(state.misses[0]!.id).toBe(candidatesFor(ctx, NOW).map(candidateId)[0]);
    rmSync(file());
    sampleClarity(ctx, NOW);
    expect(sampleClarity(ctx, at(1))!.missed).toBe(0);
  });
});

// --- Dashboard card ---

describe("Your turn in numbers", () => {
  let restoreDom: () => void;
  let ui: any;
  beforeAll(async () => {
    restoreDom = installFakeDom();
    ui = await import("../ui/dashboard.js" as string);
  });
  afterAll(() => restoreDom());

  const text = (el: FakeElement) => el.textContent;
  const base = { sampled: true, count: 0, dismissed: 0, missed: 0, missedNow: 0, misses: [], waitingNow: 0 };

  it("durationText at the boundaries, rounded and rounded up", () => {
    const d = ui.durationText;
    expect(d(0)).toBe("less than a minute");
    expect(d(59_999)).toBe("less than a minute");
    expect(d(60_000)).toBe("1 min");
    expect(d(90_000)).toBe("2 min");
    expect(d(80_000, true)).toBe("2 min");
    expect(d(61_000, false)).toBe("1 min");
    expect(d(61_000, true)).toBe("2 min");
    expect(d(59 * MIN)).toBe("59 min");
    expect(d(60 * MIN)).toBe("1 h");
    expect(d(130 * MIN)).toBe("2 h 10 min");
    expect(d(24 * 60 * MIN)).toBe("1 day");
    expect(d(3 * 24 * 60 * MIN)).toBe("3 days");
  });

  it("with no sample", () => {
    expect(text(ui.clarityCard({ ...base, sampled: false }))).toContain("No sample yet");
    expect(text(ui.clarityCard(null))).toContain("No sample yet");
  });

  it("with 0 missed, none waited, and with one wait", () => {
    const zero = text(ui.clarityCard(base));
    expect(zero).toContain("Your turn in numbers");
    expect(zero).toContain("No item has waited for you yet");
    expect(zero).toContain("without being on Your turn: 0.");
    expect(zero).not.toContain("should be 0");
    expect(text(ui.clarityCard({ ...base, count: 1, halfMs: 5 * MIN, longestMs: 5 * MIN }))).toContain("1 item waited for you, for 5 min.");
  });

  it("with several waits, rounded up, and under a minute", () => {
    expect(text(ui.clarityCard({ ...base, count: 3, halfMs: 61_000, longestMs: 3 * 3600_000 }))).toContain("Half waited 2 min or less.");
    expect(text(ui.clarityCard({ ...base, count: 3, halfMs: 20_000, longestMs: 20_000 }))).toContain("Half waited less than a minute.");
  });

  it("with dismissed waits", () => {
    expect(text(ui.clarityCard({ ...base, dismissed: 2 }))).toContain("2 dismissed items are not counted.");
    expect(text(ui.clarityCard({ ...base, dismissed: 1 }))).toContain("1 dismissed item is not counted.");
  });

  it("with misses: lists them, and says still missing", () => {
    const miss = { id: "acme/app#7", status: "waiting for you — questions" };
    const gone = text(ui.clarityCard({ ...base, missed: 1, misses: [miss] }));
    expect(gone).toContain("acme/app#7 — waiting for you — questions");
    expect(gone).not.toContain("still missing");
    expect(text(ui.clarityCard({ ...base, missed: 1, missedNow: 1, misses: [miss] }))).toContain("still missing");
  });

  describe("the Dashboard", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });
    const answers: Record<string, unknown> = {
      "/api/stats": { totals: { costUsd: 0, runs: 0, succeeded: 0, failed: 0 }, byDay: [], byFlow: [], byRepo: [], failingSteps: [], loops: [] },
      "/api/info": { spentToday: 0 }, "/api/evals": [], "/api/watchers": [], "/api/runs": [],
    };
    const fetchWith = (clarity: unknown) => {
      (globalThis as any).fetch = async (url: string) => {
        const body = url === "/api/clarity" ? clarity : answers[url];
        const ok = body !== undefined;
        return { ok, status: ok ? 200 : 500, statusText: "x", json: async () => body ?? { error: "no" } };
      };
    };

    it("shows the card", async () => {
      fetchWith({ ...base, count: 1, halfMs: 5 * MIN, longestMs: 5 * MIN });
      const main = new FakeElement("div");
      await ui.renderDashboard(main);
      expect(main.textContent).toContain("Your turn in numbers");
      expect(main.textContent).toContain("Dashboard");
    });

    it("still renders when /api/clarity fails", async () => {
      fetchWith(undefined);
      const main = new FakeElement("div");
      await ui.renderDashboard(main);
      expect(main.textContent).toContain("Dashboard");
      expect(main.textContent).not.toContain("Your turn in numbers");
    });
  });
});
