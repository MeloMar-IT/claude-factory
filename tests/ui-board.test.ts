import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/board.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).location;
});

const flush = () => vi.advanceTimersByTimeAsync(0);

const COLS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];
const TITLES = ["Your turn", "Waiting for another story", "Queued", "Planning", "Coding", "Reviewing", "Merging", "Done", "Failed"];

const card = (over: Record<string, unknown> = {}) => {
  const next = (over.next as any) ?? nextStep("dependency", { repo: "acme/app", issue: 89, title: "Eighty-nine", runId: "r89" }, { watched: true, blockers: [{ issue: 88 }] });
  return { key: "acme/app#89", issue: 89, title: "Eighty-nine", column: "waiting", next, runId: "r89", after: [88], chain: [88, 87], watcher: "w1", ...over };
};
const board = (cards: any[] = [card()], repo = "acme/app") => ({
  repos: [{ repo, columns: COLS.map((id, i) => ({ id, title: TITLES[i], cards: cards.filter((c) => c.column === id) })) }],
});
const handlers = () => ({ highlight: undefined as number | undefined, onChain: vi.fn(), onClear: vi.fn(), onLeave: vi.fn() });
const view = (d: unknown, wanted?: string, h = handlers()) => {
  const root = new FakeElement("div");
  root.append(...(ui.boardView(d, wanted, h) as unknown[]).filter(Boolean) as FakeElement[]);
  return root;
};
const find = (root: FakeElement, tag: string, cls: string): FakeElement[] => root.all(tag).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const cardEl = (root: FakeElement) => find(root, "div", "board-card");

describe("boardView", () => {
  it("shows the nine columns with counts and the card text", () => {
    const root = view(board());
    const heads = root.all("h3").map((e) => e.textContent);
    expect(heads).toEqual(TITLES.map((t) => (t === "Waiting for another story" ? `${t} 1` : `${t} 0`)));
    const text = cardEl(root)[0]!.textContent;
    for (const s of ["#89", "Eighty-nine", "after #88", "What is in the way of #89?"]) expect(text).toContain(s);
    expect(text).toContain(card().next.text);
  });

  it("marks a bug story as going first", () => {
    expect(cardEl(view(board([card({ goesFirst: true })])))[0]!.textContent).toContain("goes first");
    expect(cardEl(view(board()))[0]!.textContent).not.toContain("goes first");
  });

  it("shows the step line", () => {
    expect(cardEl(view(board([card({ step: "coding — step 12 of 29", column: "coding" })])))[0]!.textContent).toContain("coding — step 12 of 29");
  });

  it("links to GitHub only for a repository name", () => {
    const a = view(board()).all("a").filter((x) => x.attrs.href?.startsWith("https://github.com"));
    expect(a.map((x) => x.attrs.href)).toEqual(["https://github.com/acme/app/issues/89", "https://github.com/acme/app/issues/88"]);
    expect(a[0]!.attrs).toMatchObject({ target: "_blank", rel: "noopener" });
    const plain = view(board([card()], "/home/me/x"));
    expect(plain.all("a").filter((x) => x.attrs.href?.startsWith("https://github.com"))).toEqual([]);
    expect(plain.textContent).toContain("#89");
  });

  it("shows Today and This week headings in Done", () => {
    const d = (issue: number, group: string) => card({ issue, key: `k${issue}`, column: "done", group, after: [], chain: [], next: nextStep("done", { repo: "acme/app", issue, title: "x" }) });
    const subs = find(view(board([d(1, "Today"), d(2, "This week"), d(3, "This week")])), "div", "board-sub");
    expect(subs.map((s) => s.textContent)).toEqual(["Today", "This week"]);
  });

  it("shows tabs only with more than one repository", () => {
    const two = { repos: [...board().repos, { ...board().repos[0]!, repo: "acme/b" }] };
    const tabs = view(two, "acme/b").all("a").filter((a) => (a.attrs.class ?? "").includes("btn"));
    expect(tabs.map((t) => [t.attrs.href, t.attrs.class])).toEqual([["#/board/acme%2Fapp", "btn"], ["#/board/acme%2Fb", "btn primary"]]);
    expect(view(board()).all("a").filter((a) => (a.attrs.class ?? "").includes("btn"))).toEqual([]);
  });

  it("shows the empty text", () => {
    expect(view({ repos: [], empty: "No stories yet." }).textContent).toContain("No stories yet.");
  });

  it("falls back to the first repository", () => {
    expect(ui.pickRepo(board(), "nope").repo).toBe("acme/app");
    expect(ui.pickRepo({ repos: [] }, "x")).toBeUndefined();
  });
});

describe("cards", () => {
  it("opens the run page on click and Enter", () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    const el = cardEl(view(board()))[0]!;
    expect(el.attrs).toMatchObject({ class: "board-card link", role: "link", tabindex: "0" });
    el.listeners.click![0]!();
    expect(loc.hash).toBe("#/runs/r89");
    loc.hash = "";
    el.listeners.keydown![0]!({ key: "a", target: el, currentTarget: el });
    expect(loc.hash).toBe("");
    el.listeners.keydown![0]!({ key: "Enter", target: el, currentTarget: el });
    expect(loc.hash).toBe("#/runs/r89");
  });

  it("does not open the run when Enter is pressed on a link or button inside the card", () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    const el = cardEl(view(board()))[0]!;
    const inner = [...el.all("a"), ...el.all("button")];
    expect(inner.length).toBeGreaterThan(1);
    for (const target of inner) el.listeners.keydown![0]!({ key: "Enter", target, currentTarget: el });
    expect(loc.hash).toBe("");
  });

  it("is not a link without a run", () => {
    const el = cardEl(view(board([card({ runId: undefined })])))[0]!;
    expect(el.attrs.class).toBe("board-card");
    expect(el.listeners.click).toBeUndefined();
  });

  it("stops a click on an inner link or button from opening the run, and tells the page when GitHub opens", () => {
    const h = handlers();
    const root = view(board(), undefined, h);
    const stop = vi.fn();
    const gh = root.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/88")!;
    gh.listeners.click![0]!({ stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    expect(h.onLeave).toHaveBeenCalledWith(expect.objectContaining({ issue: 89, watcher: "w1" }));
    const btn = root.all("button").find((b) => b.textContent === "What is in the way of #89?")!;
    btn.listeners.click![0]!({ stopPropagation: stop });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(h.onChain).toHaveBeenCalledWith(89);
  });

  it("leaves out the link to the card's own run page", () => {
    const own = nextStep("running", { repo: "acme/app", issue: 89, title: "x", runId: "r89" }, { watched: false });
    expect(own.where.url).toBe("#/runs/r89");
    const root = view(board([card({ next: own, column: "coding", after: [], chain: [] })]));
    expect(find(root, "a", "hold-link")).toEqual([]);
  });
});

describe("highlight", () => {
  it("marks the chain cards, dims the rest, lists chain issues that have no card, and clears", () => {
    const c88 = card({ issue: 88, key: "k88", after: [], chain: [], runId: "r88", column: "coding" });
    const other = card({ issue: 90, key: "k90", after: [], chain: [], runId: "r90" });
    const h = handlers();
    h.highlight = 89;
    const root = view(board([card({ chain: [88, 87] }), c88, other]), undefined, h);
    const byIssue = Object.fromEntries(cardEl(root).map((e) => [e.textContent.match(/#(\d+)/)![1], e.attrs.class]));
    expect(byIssue).toEqual({ 89: "board-card link chain", 88: "board-card link chain", 90: "board-card link dim" });
    const line = find(root, "div", "board-chain")[0]!;
    expect(line.textContent).toContain("In the way of #89:");
    expect(line.all("a").map((a) => a.attrs.href)).toEqual(["https://github.com/acme/app/issues/88", "https://github.com/acme/app/issues/87"]);
    line.all("button").find((b) => b.textContent === "Show all")!.listeners.click![0]!();
    expect(h.onClear).toHaveBeenCalled();
  });
});

describe("renderBoard", () => {
  const main = () => new FakeElement("main");

  it("returns a function at once and shows Loading…", () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    expect(typeof cleanup).toBe("function");
    expect(m.textContent).toContain("Loading…");
    cleanup();
  });

  it("asks again after 5 seconds and redraws only on change", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, "acme/app");
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("Eighty-nine");
    const first = m.children;
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board());
    await flush();
    expect(m.children).toBe(first); // unchanged: not drawn again
    cleanup();
  });

  it("never has two requests in flight: a slow server is asked again only after it answered", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);
    calls.shift()!.answer(board([card({ title: "Slow" })]));
    await flush();
    expect(m.textContent).toContain("Slow");
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(1);
    cleanup();
  });

  it("ignores an answer that arrives after cleanup, and asks no more", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    cleanup();
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("Loading…");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it("shows the error of the first request in the page, and keeps the board after a later one", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    calls.shift()!.answer({ error: "boom" }, false);
    await flush();
    expect(find(m, "div", "errors")[0]!.textContent).toBe("boom");
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("Eighty-nine");
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer({ error: "later" }, false);
    await flush();
    expect(m.textContent).toContain("Eighty-nine");
    cleanup();
  });

  it("highlights a chain, and drops the highlight when the card is gone", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    calls.shift()!.answer(board());
    await flush();
    m.all("button").find((b) => b.textContent === "What is in the way of #89?")!.listeners.click![0]!();
    expect(m.textContent).toContain("In the way of #89:");
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(board([]));
    await flush();
    expect(m.textContent).not.toContain("In the way of");
    cleanup();
  });

  it("checks the watcher and reloads when the user comes back from a GitHub link of a card with a watcher", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    calls.shift()!.answer(board());
    await flush();
    const vis = () => (document as any).listeners.visibilitychange![0]();
    vis(); // nothing remembered yet
    await flush();
    expect(calls).toHaveLength(0);
    m.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/89")!.listeners.click![0]!();
    (document as any).visibilityState = "visible";
    vis();
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/watchers/w1/tick" });
    calls[0]!.answer({});
    await flush();
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/board" });
    cleanup();
  });

  it("does not check a watcher for a card without one", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, undefined);
    calls.shift()!.answer(board([card({ watcher: undefined })]));
    await flush();
    m.all("a").find((a) => a.attrs.href === "https://github.com/acme/app/issues/89")!.listeners.click![0]!();
    (document as any).listeners.visibilitychange![0]();
    await flush();
    expect(calls).toHaveLength(0);
    cleanup();
  });

  it("falls back to the first repository for an unknown argument", async () => {
    const m = main();
    const cleanup = ui.renderBoard(m, "unknown/repo");
    calls.shift()!.answer(board());
    await flush();
    expect(m.textContent).toContain("acme/app");
    expect(m.textContent).toContain("Eighty-nine");
    cleanup();
  });
});
