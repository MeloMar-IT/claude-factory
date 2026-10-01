import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/health.js" as string);
});
afterAll(() => restore());

interface Call { method: string; url: string; answer: (body: unknown, ok?: boolean) => void }
let calls: Call[];
let winListeners: Record<string, ((e?: unknown) => void)[]>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  winListeners = {};
  (globalThis as any).addEventListener = (t: string, f: (e?: unknown) => void) => (winListeners[t] ??= []).push(f);
  (globalThis as any).removeEventListener = (t: string, f: unknown) => { winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f); };
  (globalThis as any).fetch = (url: string, init?: { method?: string }) =>
    new Promise((resolve) => {
      calls.push({ method: init?.method ?? "GET", url, answer: (body, ok = true) => resolve({ ok, status: ok ? 200 : 500, statusText: "x", json: async () => body }) });
    });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
  delete (globalThis as any).confirm;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const good = { ok: true, summary: "All good", problems: [], repos: [] };
const closed = nextStep("closed_elsewhere", { repo: "o/a", issue: 4, title: "Four", runId: "r1" }, { issueUrl: "https://github.com/o/a/issues/4" });
const limit = nextStep("usage_limit", {}, { limitAgent: "codex", reason: "usage limit reached — resets 11:52" });
const bad = { ok: false, summary: "2 problems", problems: [limit, closed], repos: [{ repo: "o/a", lastOk: "2026-10-01T10:00:00Z" }, { repo: "o/b" }] };
const el = () => new FakeElement("div");

describe("renderHealth", () => {
  it("says All good", () => {
    const e = el();
    ui.renderHealth(e, good);
    expect(e.textContent).toBe("All good");
    expect(e.attrs.class).toBe("health ok");
    expect(e.hidden).toBe(false);
    expect(e.all("ul")).toHaveLength(0);
    expect(e.all("button")).toHaveLength(0);
  });

  it("lists each problem with its action, reason and link", () => {
    const e = el();
    ui.renderHealth(e, bad);
    expect(e.attrs.class).toBe("health bad");
    expect(e.textContent).toContain("2 problems");
    const items = e.all("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(limit.action);
    expect(items[0]!.textContent).toContain("The Codex usage limit is reached");
    expect(items[0]!.textContent).toContain("Continues: 11:52");
    expect(items[0]!.all("a")[0]!.attrs.href).toBe("#/runs");
  });

  it("has one Cancel run button, only for a closed issue, and it calls onCancel", () => {
    const e = el();
    const onCancel = vi.fn();
    ui.renderHealth(e, bad, { onCancel });
    const buttons = e.all("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Cancel run");
    expect(e.all("li")[1]!.all("button")).toHaveLength(1);
    buttons[0]!.click();
    expect(onCancel).toHaveBeenCalledWith("r1");
  });

  it("shows the last successful check of each repository, also when all is good", () => {
    for (const h of [bad, { ...good, repos: bad.repos }]) {
      const e = el();
      ui.renderHealth(e, h);
      expect(e.textContent).toContain("o/a");
      expect(e.textContent).toContain("last successful check");
      expect(e.textContent).toContain("o/b · no successful check yet");
      expect(e.all("details")).toHaveLength(0);
    }
  });

  it("says when the server does not answer", () => {
    const e = el();
    ui.renderHealth(e, null);
    expect(e.textContent).toBe("The Foundry server does not answer. Check that it is still running.");
    expect(e.attrs.class).toBe("health bad");
  });
});

describe("loadHealth", () => {
  it("draws a good answer, and the no-answer text when the request fails", async () => {
    const e = el();
    const p = ui.loadHealth(e);
    calls[0]!.answer(good);
    await p;
    expect(e.textContent).toBe("All good");
    const q = ui.loadHealth(e);
    calls[1]!.answer({}, false);
    await q;
    expect(e.textContent).toContain("does not answer");
  });

  it("the newer of two requests wins", async () => {
    const e = el();
    const a = ui.loadHealth(e);
    const b = ui.loadHealth(e);
    calls[1]!.answer(good);
    await b;
    calls[0]!.answer(bad);
    await a;
    expect(e.textContent).toBe("All good");
  });

  it("cancels the run after a confirm, then asks again; without a confirm it posts nothing", async () => {
    const e = el();
    const p = ui.loadHealth(e);
    calls[0]!.answer(bad);
    await p;
    (globalThis as any).confirm = () => false;
    e.all("button")[0]!.click();
    await flush();
    expect(calls).toHaveLength(1);
    (globalThis as any).confirm = () => true;
    e.all("button")[0]!.click();
    await flush();
    expect(calls[1]).toMatchObject({ method: "POST", url: "/api/runs/r1/cancel" });
    calls[1]!.answer({});
    await flush();
    expect(calls[2]).toMatchObject({ url: "/api/health" });
  });
});

describe("startHealth", () => {
  it("loads at once, on a page change and every 30 seconds, until stopped", async () => {
    const stop = ui.startHealth(el());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/health");
    winListeners.hashchange![0]!();
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
    stop();
    expect(winListeners.hashchange).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
  });
});
