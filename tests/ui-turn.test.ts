import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/turn.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  (document as any).title = "";
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const flush = () => vi.advanceTimersByTimeAsync(0);

const item = (over: Record<string, unknown> = {}, next = nextStep("questions", { repo: "o/a", issue: 5, title: "Five" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5", questions: 2 })) => ({
  key: `k${next.issue ?? ""}`, repo: "o/a", what: "Five", next, since: "2026-10-01T10:00:00Z", unblocks: 0, dismissable: true, watcher: "w1", ...over,
});
const data = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  count: items.length, groups: items.length ? [{ repo: "o/a", items }] : [], dismissed: 0, ...(items.length ? {} : { empty: "Nothing needs you." }), ...extra,
});
const handlers = () => ({ onDismiss: vi.fn(), onRestore: vi.fn(), onLeave: vi.fn() });
const view = (d: unknown, h = handlers()) => {
  const root = new FakeElement("div");
  root.append(...(ui.turnView(d, h) as unknown[]).filter(Boolean) as FakeElement[]);
  return root;
};
const click = (el: FakeElement) => el.listeners.click![0]!();
const link = (root: FakeElement) => root.all("a").find((a) => a.attrs.class?.includes("btn"));

describe("small helpers", () => {
  it("tabTitle and startHash", () => {
    expect(ui.tabTitle(0)).toBe("Spaghetti Code Foundry");
    expect(ui.tabTitle(3)).toBe("(3) Foundry");
    expect(ui.startHash("", 2)).toBe("#/your-turn");
    expect(ui.startHash("", 0)).toBeNull();
    expect(ui.startHash("#/runs/x", 2)).toBeNull();
  });

  it("showCount sets the badge and the tab title", () => {
    ui.showCount(3);
    const badge = document.getElementById("turn-badge") as unknown as FakeElement;
    expect(badge.textContent).toBe("3");
    expect(badge.hidden).toBe(false);
    expect(document.title).toBe("(3) Foundry");
    ui.showCount(0);
    expect(badge.hidden).toBe(true);
    expect(document.title).toBe("Spaghetti Code Foundry");
  });

  it("sinceText", () => {
    expect(ui.sinceText(undefined)).toBe("");
    expect(ui.sinceText("x")).toBe("");
    expect(ui.sinceText("2026-10-01T10:00:00Z")).toMatch(/^since /);
    const now = new Date(2026, 9, 1, 15, 0);
    expect(ui.sinceText(new Date(2026, 9, 1, 14, 5).toISOString(), now)).toBe("since 14:05");
    expect(ui.sinceText(new Date(2026, 8, 28, 14, 5).toISOString(), now)).toBe("since 28 Sep, 14:05");
  });
});

describe("turnView", () => {
  it("shows the repository, what, action, why, what waits for it and since", () => {
    const root = view(data([item({ unblocks: 3 }), item({ key: "k6", unblocks: 1, what: "Six" }, nextStep("approval", { repo: "o/a", issue: 6 }))]));
    const text = root.textContent;
    expect(root.all("h1")[0]!.textContent).toBe("Your turn");
    expect(root.all("h3")[0]!.textContent).toBe("o/a");
    expect(text).toContain("Five");
    expect(text).toContain("Answer 2 questions");
    expect(text).toContain("It has questions before it starts");
    expect(text).toContain("3 stories wait for this");
    expect(text).toContain("1 story waits for this");
    expect(text).toContain("since ");
  });

  it("the issue number link also counts as leaving", () => {
    const h = handlers();
    const a = view(data([item()]), h).all("a").find((x) => x.attrs.class === "mono")!;
    click(a);
    expect(h.onLeave).toHaveBeenCalledTimes(1);
  });

  it("opens GitHub in a new tab and the run page in the same tab; leaves out unsafe links", () => {
    const gh = nextStep("questions", { repo: "o/a", issue: 5 }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" });
    const h = handlers();
    const a = link(view(data([item()]), h))!;
    expect(a.attrs.target).toBe("_blank");
    expect(a.attrs.rel).toBe("noopener");
    click(a);
    expect(h.onLeave).toHaveBeenCalledTimes(1);
    expect(gh.where.url).toBe(a.attrs.href);
    const run = nextStep("approval", { repo: "o/a", runId: "x" });
    const same = link(view(data([item({}, run)])))!;
    expect(same.attrs.href).toBe("#/runs/x");
    expect(same.attrs.target).toBeUndefined();
    const bad = { ...run, where: { label: "Evil", url: "javascript:alert(1)" } };
    expect(link(view(data([item({}, bad)])))).toBeUndefined();
  });

  it("shows Dismiss only when dismissable", () => {
    const h = handlers();
    const root = view(data([item(), item({ key: "e", dismissable: false })]), h);
    const buttons = root.all("button").filter((b) => b.textContent === "Dismiss");
    expect(buttons).toHaveLength(1);
    click(buttons[0]!);
    expect(h.onDismiss).toHaveBeenCalledWith("k5");
  });

  it("shows the empty text and the dismissed line", () => {
    const h = handlers();
    const root = view(data([], { empty: "Nothing needs you. 4 stories are being built.", dismissed: 2 }), h);
    expect(root.textContent).toContain("Nothing needs you. 4 stories are being built.");
    expect(root.textContent).toContain("2 dismissed");
    click(root.all("button").find((b) => b.textContent === "Show again")!);
    expect(h.onRestore).toHaveBeenCalled();
  });
});

describe("startBadge", () => {
  it("returns the first count, sets the badge and asks again after 30 seconds", async () => {
    const p = ui.startBadge();
    await flush();
    calls[0]!.answer(data([item(), item({ key: "b" })]));
    expect(await p).toBe(2);
    expect(document.title).toBe("(2) Foundry");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
  });

  it("opens Your turn when the first item shows up later and no page was chosen", async () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    try {
      const p = ui.startBadge();
      await flush();
      calls[0]!.answer(data([]));
      expect(await p).toBe(0);
      await vi.advanceTimersByTimeAsync(30_000);
      calls[1]!.answer(data([item()]));
      await flush();
      expect(loc.hash).toBe("#/your-turn");
      // only once: the user moves on and a later poll does not pull them back
      loc.hash = "#/runs";
      await vi.advanceTimersByTimeAsync(30_000);
      calls[2]!.answer(data([item()]));
      await flush();
      expect(loc.hash).toBe("#/runs");
    } finally {
      delete (globalThis as any).location;
    }
  });

  it("does not open Your turn over a page the user chose", async () => {
    const loc = { hash: "#/runs" };
    (globalThis as any).location = loc;
    try {
      const p = ui.startBadge();
      await flush();
      calls[0]!.answer(data([]));
      await p;
      await vi.advanceTimersByTimeAsync(30_000);
      calls[1]!.answer(data([item()]));
      await flush();
      expect(loc.hash).toBe("#/runs");
    } finally {
      delete (globalThis as any).location;
    }
  });

  it("returns 0 when the request fails", async () => {
    const p = ui.startBadge();
    await flush();
    calls[0]!.answer({ error: "no" }, false);
    expect(await p).toBe(0);
  });
});

describe("renderYourTurn", () => {
  const open = async (first: unknown) => {
    const main = new FakeElement("main");
    const p = ui.renderYourTurn(main);
    await flush();
    calls.shift()!.answer(first);
    const cleanup = await p;
    return { main, cleanup };
  };

  it("asks again after 5 seconds and drops an item that is gone", async () => {
    const { main, cleanup } = await open(data([item(), item({ key: "b", what: "Other" })]));
    expect(main.textContent).toContain("Other");
    await vi.advanceTimersByTimeAsync(5000);
    calls.shift()!.answer(data([item()]));
    await flush();
    expect(main.textContent).not.toContain("Other");
    cleanup();
  });

  it("the newest answer wins over a slower poll", async () => {
    const { main, cleanup } = await open(data([item()]));
    await vi.advanceTimersByTimeAsync(5000);
    const poll = calls.shift()!;
    click(main.all("button").find((b) => b.textContent === "Dismiss")!);
    const dismiss = calls.shift()!;
    expect(dismiss.method).toBe("POST");
    dismiss.answer(data([]));
    await flush();
    poll.answer(data([item()]));
    await flush();
    expect(main.textContent).toContain("Nothing needs you.");
    expect(document.title).toBe("Spaghetti Code Foundry");
    cleanup();
  });

  it("stops after cleanup and ignores a late answer on the page", async () => {
    const { main, cleanup } = await open(data([item()]));
    await vi.advanceTimersByTimeAsync(5000);
    const late = calls.shift()!;
    cleanup();
    late.answer(data([]));
    await flush();
    expect(main.textContent).toContain("Five");
    expect(document.title).toBe("Spaghetti Code Foundry");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(0);
  });

  it("checks the watcher first when the user comes back from GitHub", async () => {
    const { main, cleanup } = await open(data([item()]));
    click(link(main)!);
    (document as any).visibilityState = "visible";
    (document as any).listeners.visibilitychange![0]();
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/watchers/w1/tick" });
    expect(calls).toHaveLength(1);
    calls[0]!.answer({});
    await flush();
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/your-turn" });
    cleanup();
  });
});
