import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let admin: any;
beforeAll(async () => {
  restore = installFakeDom();
  admin = await import("../ui/admin.js" as string);
});
afterAll(() => restore());

const NOW = new Date(2026, 9, 1, 14, 30, 0);
const iso = (h: number, m: number) => new Date(2026, 9, 1, h, m, 0).toISOString();
const realFetch = globalThis.fetch;
let sent: { method: string; url: string }[];
let state: any;
let stateFails: boolean;

beforeEach(() => {
  sent = [];
  state = { state: "on", reportTo: true };
  stateFails = false;
  (globalThis as any).fetch = async (url: string, init: { method: string }) => {
    sent.push({ method: init.method, url });
    const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
    if (url === "/api/watchers") {
      return reply([
        { id: "mon", source: "monitor", enabled: true, every: "1h", state: { name: "active" }, status: { id: "mon", lastActions: [], notes: ["a note"] } },
        { id: "w", source: "issues", enabled: true, github_repo: "o/a", flow: "issue-gitflow", label: "x", every: "5m", max_per_tick: 1, state: { name: "active" }, status: { id: "w", lastActions: [] } },
      ]);
    }
    if (url === "/api/flows") return reply([]);
    if (url === "/api/monitor") return stateFails ? reply({ error: "no" }, 500) : reply(state);
    if (url === "/api/monitor/off") return reply({ ...state, state: "off", since: iso(14, 5) });
    if (url === "/api/monitor/on") return reply({ ...state, state: "on" });
    return reply({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any).confirm;
});

const cards = (main: FakeElement) => main.all("div").filter((d) => d.attrs.class === "card");
const buttonOf = (c: FakeElement) => c.all("button").find((b) => /Switch bug stories/.test(b.textContent));
const draw = async () => {
  const main = new FakeElement("div");
  await admin.renderWatchers(main);
  return main;
};

describe("storiesLine", () => {
  it("says on, and when no repository is set", () => {
    expect(admin.storiesLine({ state: "on", reportTo: true }, NOW)).toBe("Bug stories: on");
    expect(admin.storiesLine({ state: "on", reportTo: false }, NOW)).toBe("Bug stories: on (no repository is set: monitor.report_to)");
  });
  it("says off since, quiet until, and stopped", () => {
    expect(admin.storiesLine({ state: "off", since: iso(14, 5) }, NOW)).toMatch(/^Bug stories: off since .*14|2:05/);
    expect(admin.storiesLine({ state: "quiet", until: iso(14, 45) }, NOW)).toMatch(/^Bug stories: quiet until .* after the restart$/);
    expect(admin.storiesLine({ state: "unreadable" }, NOW)).toBe("Bug stories: stopped. The state file monitor-guard.json cannot be read.");
  });
  it("adds the day when the time is on another day, and the reset sentence", () => {
    const other = new Date(2026, 9, 3, 9, 0, 0).toISOString();
    expect(admin.storiesLine({ state: "off", since: other }, NOW)).toMatch(/off since .*(Oct|10).*3/);
    const l = admin.storiesLine({ state: "on", reset: iso(14, 0) }, NOW);
    expect(l).toContain("it was kept as monitor-guard.json.broken and started fresh.");
  });
});

describe("the monitor's card", () => {
  it("only the monitor's card has the line and the button", async () => {
    const main = await draw();
    const [mon, other] = cards(main);
    expect(mon!.textContent).toContain("Bug stories: on");
    expect(buttonOf(mon!)!.textContent).toBe("Switch bug stories off");
    expect(other!.textContent).not.toContain("Bug stories");
    expect(buttonOf(other!)).toBeUndefined();
    expect(mon!.textContent.indexOf("Bug stories: on")).toBeLessThan(mon!.textContent.indexOf("a note"));
  });

  it("a click sends the call and draws the page again", async () => {
    const main = await draw();
    sent = [];
    buttonOf(cards(main)[0]!)!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/off" });
    expect(sent.some((s) => s.url === "/api/watchers")).toBe(true);
  });

  it("from off the button switches on", async () => {
    state = { state: "off", since: iso(14, 5) };
    const main = await draw();
    const b = buttonOf(cards(main)[0]!)!;
    expect(b.textContent).toBe("Switch bug stories on");
    sent = [];
    b.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]!.url).toBe("/api/monitor/on");
  });

  it("from unreadable, a refused confirm sends nothing", async () => {
    state = { state: "unreadable" };
    (globalThis as any).confirm = () => false;
    const main = await draw();
    sent = [];
    buttonOf(cards(main)[0]!)!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    (globalThis as any).confirm = () => true;
    buttonOf(cards(main)[0]!)!.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]!.url).toBe("/api/monitor/on");
  });

  it("a failing GET /api/monitor still draws the page, without the row", async () => {
    stateFails = true;
    const main = await draw();
    expect(cards(main)).toHaveLength(2);
    expect(main.textContent).not.toContain("Bug stories");
  });
});
