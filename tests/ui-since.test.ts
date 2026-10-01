import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let turn: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/since.js" as string);
  turn = await import("../ui/turn.js" as string);
});
afterAll(() => restore());

interface Call { url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
let winListeners: Record<string, ((e?: unknown) => void)[]>;
const realFetch = globalThis.fetch;

const T0 = new Date("2026-10-01T12:00:00Z");
const MIN = 60_000;
const OLD = new Date(T0.getTime() - 60 * MIN).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  calls = [];
  winListeners = {};
  (document as any).visibilityState = "visible";
  for (const k of Object.keys((document as any).listeners)) delete (document as any).listeners[k];
  (globalThis as any).addEventListener = (t: string, f: (e?: unknown) => void) => (winListeners[t] ??= []).push(f);
  (globalThis as any).removeEventListener = (t: string, f: unknown) => { winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f); };
  (globalThis as any).fetch = (url: string) =>
    new Promise((resolve) => {
      calls.push({ url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const mem = (initial?: unknown) => {
  const s: any = { data: initial === undefined ? undefined : JSON.stringify(initial), getItem: () => s.data ?? null, setItem: (_k: string, v: string) => { s.data = v; } };
  return s;
};
const saved = (s: any) => JSON.parse(s.data ?? "{}");
const entry = (over: Record<string, unknown> = {}) => ({ repo: "o/a", issue: 5, title: "Five", where: { label: "Run", url: "#/runs/r1" }, at: "2026-10-01T11:00:00Z", ...over });
const answer = (over: Record<string, unknown> = {}) => ({
  since: OLD, now: T0.toISOString(), total: 1, complete: true, notes: [],
  groups: [{ id: "done", label: "1 story done", count: 1, items: [entry()] }], ...over,
});
const empty = (complete = true) => answer({ total: 0, complete, groups: [] });
const click = (el: FakeElement) => el.listeners.click![0]!();
const shownAfterBreak = () => ({ seen: OLD });

describe("visit", () => {
  it("makes no summary on a first visit, a short gap or a bad time", () => {
    expect(ui.visit({}, T0)).toEqual({ state: { seen: T0.toISOString() }, from: null });
    const gap = (min: number) => ui.visit({ seen: new Date(T0.getTime() - min * MIN).toISOString() }, T0);
    expect(gap(29).from).toBeNull();
    const thirty = gap(30);
    expect(thirty.from).toBe(new Date(T0.getTime() - 30 * MIN).toISOString());
    expect(thirty.state).toEqual({ seen: T0.toISOString(), from: thirty.from });
    expect(ui.visit({ seen: "garbage" }, T0).from).toBeNull();
    expect(ui.visit({ seen: new Date(T0.getTime() + 5 * MIN).toISOString() }, T0).from).toBeNull();
  });

  it("keeps a pending from across a short gap", () => {
    const state = { seen: new Date(T0.getTime() - MIN).toISOString(), from: OLD };
    expect(ui.visit(state, T0)).toEqual({ state: { seen: T0.toISOString(), from: OLD }, from: OLD });
  });
});

describe("readState and writeState", () => {
  it("never throw", () => {
    const bad = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
    expect(ui.readState(bad)).toEqual({});
    expect(() => ui.writeState({ seen: "x" }, bad)).not.toThrow();
    expect(ui.readState({ getItem: () => "{nope" })).toEqual({});
    expect(ui.readState({ getItem: () => "[1]" })).toEqual({});
    expect(ui.readState(undefined)).toEqual({});
    const s = mem();
    ui.writeState({ seen: "a" }, s);
    expect(ui.readState(s)).toEqual({ seen: "a" });
  });
});

describe("timeText", () => {
  it("shows the time today, the day otherwise", () => {
    const now = new Date(2026, 9, 1, 15, 0);
    expect(turn.timeText(new Date(2026, 9, 1, 14, 5).toISOString(), now)).toBe("14:05");
    expect(turn.timeText(new Date(2026, 8, 28, 14, 5).toISOString(), now)).toBe("28 Sep, 14:05");
    expect(turn.timeText("x", now)).toBe("");
    expect(turn.sinceText(new Date(2026, 9, 1, 14, 5).toISOString(), now)).toBe("since 14:05");
  });
});

describe("sinceView", () => {
  const view = (d: unknown, onDismiss = vi.fn()) => {
    const root = new FakeElement("div");
    root.append(ui.sinceView(d, { onDismiss }));
    return { root, onDismiss };
  };

  it("shows labels, issue and run links, more, notes and Dismiss", () => {
    const d = answer({
      notes: ["<b>not html</b>"],
      groups: [
        { id: "done", label: "3 stories done", count: 3, items: [entry()] },
        { id: "waiting", label: "1 newly waiting for you", count: 1, items: [entry({ issue: undefined, where: { label: "Open", url: "https://github.com/o/a/pull/1" } })] },
      ],
    });
    const { root, onDismiss } = view(d);
    expect(root.textContent).toContain("Since you last looked");
    expect(root.textContent).toContain("3 stories done");
    expect(root.textContent).toContain("+2 more");
    expect(root.textContent).toContain("<b>not html</b>");
    const links = root.all("a");
    const issue = links.find((a) => a.textContent === "#5")!;
    expect(issue.attrs).toMatchObject({ href: "https://github.com/o/a/issues/5", target: "_blank" });
    const run = links.find((a) => a.attrs.href === "#/runs/r1")!;
    expect(run.attrs.target).toBeUndefined();
    expect(links.find((a) => a.attrs.href === "#/your-turn")).toBeDefined();
    expect(links.find((a) => a.attrs.href === "https://github.com/o/a/pull/1")!.attrs.target).toBe("_blank");
    click(root.all("button")[0]!);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("does not link a javascript: url", () => {
    const { root } = view(answer({ groups: [{ id: "done", label: "x", count: 1, items: [entry({ repo: "bad repo", where: { label: "Evil", url: "javascript:alert(1)" } })] }] }));
    expect(root.all("a")).toEqual([]);
    expect(root.textContent).toContain("Evil");
  });
});

describe("startSince", () => {
  const start = (store: any, el = new FakeElement("div")) => {
    el.hidden = true;
    const stop = ui.startSince(el, { store });
    return { el, stop };
  };

  it("shows the strip after a break and keeps from until Dismiss", async () => {
    const store = mem(shownAfterBreak());
    const { el } = start(store);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/api/since?since=${encodeURIComponent(OLD)}`);
    expect(saved(store).from).toBe(OLD);
    calls[0]!.answer(answer());
    await flush();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain("1 story done");
    click(el.all("button")[0]!);
    expect(el.hidden).toBe(true);
    expect(saved(store)).toEqual({ seen: T0.toISOString() });
  });

  it("does not ask on a first visit", () => {
    const { el } = start(mem());
    expect(calls).toHaveLength(0);
    expect(el.hidden).toBe(true);
  });

  it("hides and drops from when nothing changed", async () => {
    const store = mem(shownAfterBreak());
    const { el } = start(store);
    calls[0]!.answer(empty());
    await flush();
    expect(el.hidden).toBe(true);
    expect(saved(store).from).toBeUndefined();
  });

  it("keeps from when an empty answer is incomplete, asks again after 5 minutes and then shows", async () => {
    const store = mem(shownAfterBreak());
    const { el } = start(store);
    calls[0]!.answer(empty(false));
    await flush();
    expect(el.hidden).toBe(true);
    expect(saved(store).from).toBe(OLD);
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(calls).toHaveLength(2);
    calls[1]!.answer(answer());
    await flush();
    expect(el.hidden).toBe(false);
  });

  it("shows an incomplete answer that has entries, with its note", async () => {
    const { el } = start(mem(shownAfterBreak()));
    calls[0]!.answer(answer({ complete: false, notes: ["Releases of o/a could not be read from GitHub right now."] }));
    await flush();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain("could not be read");
  });

  it("leaves the strip hidden and from stored when the request fails", async () => {
    const store = mem(shownAfterBreak());
    const { el } = start(store);
    calls[0]!.answer({ error: "x" }, false);
    await flush();
    expect(el.hidden).toBe(true);
    expect(saved(store).from).toBe(OLD);
  });

  it("ignores a late answer after Dismiss", async () => {
    const store = mem(shownAfterBreak());
    const { el } = start(store);
    const other = new FakeElement("div");
    other.hidden = true;
    // Dismiss through a second strip of the same store, as a tab would
    const b = ui.startSince(other, { store });
    expect(b).toBeTypeOf("function");
    calls[0]!.answer(answer());
    await flush();
    click(el.all("button")[0]!);
    calls[1]!.answer(answer());
    await flush();
    expect(saved(store).from).toBeUndefined();
    expect(other.hidden).toBe(true);
  });

  it("moves seen only while the tab is visible", async () => {
    const store = mem({ seen: T0.toISOString() });
    start(store);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved(store).seen).toBe(new Date(T0.getTime() + 30_000).toISOString());
    (document as any).visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(5 * 30_000);
    expect(saved(store).seen).toBe(new Date(T0.getTime() + 30_000).toISOString());
  });

  it("finds a break while the tab stays visible (the clock jumps)", async () => {
    const store = mem({ seen: T0.toISOString() });
    start(store);
    vi.setSystemTime(new Date(T0.getTime() + 31 * MIN));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(encodeURIComponent(T0.toISOString()));
  });

  it("asks again when the tab becomes visible after a break", async () => {
    const store = mem({ seen: T0.toISOString() });
    start(store);
    (document as any).visibilityState = "hidden";
    vi.setSystemTime(new Date(T0.getTime() + 40 * MIN));
    (document as any).visibilityState = "visible";
    for (const f of (document as any).listeners.visibilitychange ?? []) f();
    expect(calls).toHaveLength(1);
    for (const f of (document as any).listeners.visibilitychange ?? []) f();
    expect(calls).toHaveLength(2);
  });

  it("stop removes the timer and the listeners", () => {
    const { stop } = start(mem({ seen: T0.toISOString() }));
    expect((document as any).listeners.visibilitychange).toHaveLength(1);
    stop();
    expect((document as any).listeners.visibilitychange).toHaveLength(0);
    expect(winListeners.storage).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("two tabs with one store", () => {
  const tabs = () => {
    const store = mem(shownAfterBreak());
    const a = new FakeElement("div");
    const b = new FakeElement("div");
    a.hidden = b.hidden = true;
    ui.startSince(a, { store });
    ui.startSince(b, { store });
    return { store, a, b };
  };

  it("both show after a break", async () => {
    const { a, b } = tabs();
    calls.forEach((c) => c.answer(answer()));
    await flush();
    expect([a.hidden, b.hidden]).toEqual([false, false]);
  });

  it("Dismiss in one tab leaves no from, even after the other's heartbeat", async () => {
    const { store, a, b } = tabs();
    calls.forEach((c) => c.answer(answer()));
    await flush();
    click(a.all("button")[0]!);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saved(store).from).toBeUndefined();
    expect(b.hidden).toBe(true);
  });

  it("a storage event hides the strip of the other tab", async () => {
    const { store, a, b } = tabs();
    calls.forEach((c) => c.answer(answer()));
    await flush();
    store.data = JSON.stringify({ seen: T0.toISOString() });
    winListeners.storage!.forEach((f) => f({ key: "scf.since" }));
    expect([a.hidden, b.hidden]).toEqual([true, true]);
  });

  it("an answer that reaches a tab after the other's Dismiss does not show", async () => {
    const { a, b } = tabs();
    calls[0]!.answer(answer());
    await flush();
    click(a.all("button")[0]!);
    calls[1]!.answer(answer());
    await flush();
    expect(b.hidden).toBe(true);
  });
});
