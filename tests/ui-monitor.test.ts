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
let bodies: any[];
let muteFails: string | undefined;
let state: any;
let stateFails: boolean;

beforeEach(() => {
  sent = [];
  bodies = [];
  muteFails = undefined;
  state = { state: "on", reportTo: true };
  stateFails = false;
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    sent.push({ method: init.method, url });
    bodies.push(init.body ? JSON.parse(init.body) : undefined);
    if (url.startsWith("/api/monitor/mutes")) return muteFails ? { ok: false, status: 400, statusText: "x", json: async () => ({ error: muteFails }) } : { ok: true, status: 200, statusText: "x", json: async () => ({}) };
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
  it("says stopped by the circuit breaker, with the reason", () => {
    expect(admin.storiesLine({ state: "breaker", since: iso(14, 5), why: "7 new findings within 60 minutes" }, NOW)).toMatch(/^Bug stories: stopped by the circuit breaker since .* \(7 new findings within 60 minutes\)$/);
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

  it("from the circuit breaker the button switches on", async () => {
    state = { state: "breaker", since: iso(14, 5), why: "x" };
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

describe("the findings and mutes of the monitor's card", () => {
  let mod: any;
  beforeAll(async () => {
    mod = await import("../ui/monitor.js" as string);
  });
  const wait = () => new Promise((r) => setTimeout(r, 20));
  const finding = (i: number, over: any = {}) => ({
    id: String(i).padStart(16, "0"), detector: "restart-loop", summary: `sentence ${i}`, severity: "critical", firstSeen: iso(10, 0), lastSeen: iso(11, 0), count: 3, gone: false, ...over,
  });
  const withLists = (findings: any[], mutes: any[] = []) => {
    state = { state: "on", reportTo: true, findings, mutes, detectors: [{ name: "restart-loop", description: "d" }, { name: "slow-step", description: "d" }] };
  };
  const panel = (main: FakeElement) => main.all("summary").find((s) => s.textContent.startsWith("Findings"))!.parent!;
  const modalRoot = () => (globalThis as any).document.getElementById("modal-root") as FakeElement;
  const button = (el: FakeElement, text: string) => el.all("button").find((b) => b.textContent === text);
  const formReason = () => modalRoot().all("input")[0]!;

  it("a state without lists draws no panel", async () => {
    const main = await draw();
    expect(main.all("summary").some((s) => s.textContent.startsWith("Findings"))).toBe(false);
  });

  it("the summary counts findings and mutes, and a row shows its parts", async () => {
    withLists([finding(1, { story: { issue: 12, url: "https://github.com/o/a/issues/12", state: "open" } }), finding(2, { mute: { id: "m1", kind: "detector", reason: "noise" } })],
      [{ id: "m1", kind: "detector", detector: "restart-loop", reason: "noise", since: iso(9, 0), by: "u" }]);
    const p = panel(await draw());
    expect(p.all("summary")[0]!.textContent).toBe("Findings (2) · Mutes (1)");
    const row = p.all("tr").find((r) => r.textContent.includes("sentence 1"))!;
    expect(row.textContent).toContain("restart-loop");
    expect(row.textContent).toContain("critical");
    expect(row.all("a")[0]!.attrs.href).toBe("https://github.com/o/a/issues/12");
    expect(button(row, "Mute")).toBeDefined();
    const muted = p.all("tr").find((r) => r.textContent.includes("sentence 2"))!;
    expect(muted.textContent).toContain("muted");
    expect(button(muted, "Mute")).toBeUndefined();
    expect(button(p, "End mute")).toBeDefined();
  });

  it("an http: or javascript: story address is text, not a link", () => {
    for (const url of ["http://x/1", "javascript:alert(1)"]) {
      const cell = mod.storyCell({ issue: 5, url, state: "open" }) as FakeElement;
      expect(cell.all("a")).toHaveLength(0);
      expect(cell.textContent).toBe("#5");
    }
    expect(mod.storyCell({ issue: 5, url: "https://x/5", state: "not_planned" }).textContent).toBe("#5 (closed as not planned)");
    expect(mod.storyCell(undefined)).toBeNull();
  });

  it("with 150 findings it draws 100 rows and Show 50 more draws the rest", async () => {
    withLists(Array.from({ length: 150 }, (_, i) => finding(i + 1)));
    const p = panel(await draw());
    const rows = () => p.all("tr").length - 1;
    expect(p.all("summary")[0]!.textContent).toBe("Findings (150) · Mutes (0)");
    expect(rows()).toBe(100);
    button(p, "Show 50 more")!.click();
    expect(rows()).toBe(150);
    expect(button(p, "Show 50 more")).toBeUndefined();
  });

  it("says when there are no findings", async () => {
    withLists([]);
    expect(panel(await draw()).textContent).toContain("No findings.");
  });

  it("Mute with an empty reason shows the error and sends nothing", async () => {
    withLists([finding(1)]);
    const p = panel(await draw());
    sent = [];
    button(p, "Mute")!.click();
    button(modalRoot(), "Mute")!.click();
    await wait();
    expect(modalRoot().textContent).toContain("Give a reason.");
    expect(sent).toEqual([]);
  });

  it("a finding with a reason and 1 day sends the call; for good sends no hours", async () => {
    withLists([finding(1)]);
    const p = panel(await draw());
    button(p, "Mute")!.click();
    formReason().value = "  noise  ";
    modalRoot().all("select")[0]!.value = "24";
    sent = [];
    bodies = [];
    button(modalRoot(), "Mute")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "POST", url: "/api/monitor/mutes" });
    expect(bodies[0]).toEqual({ finding: "0000000000000001", reason: "noise", hours: 24 });
    expect(sent.some((s) => s.url === "/api/watchers")).toBe(true); // reloaded

    const again = panel(await draw());
    button(again, "Mute")!.click();
    formReason().value = "good";
    bodies = [];
    button(modalRoot(), "Mute")!.click();
    await wait();
    expect(bodies[0]).toEqual({ finding: "0000000000000001", reason: "good" });
  });

  it("Mute a detector sends the detector", async () => {
    withLists([]);
    const p = panel(await draw());
    button(p, "Mute a detector")!.click();
    formReason().value = "known";
    modalRoot().all("select")[0]!.value = "slow-step";
    bodies = [];
    button(modalRoot(), "Mute")!.click();
    await wait();
    expect(bodies[0]).toEqual({ detector: "slow-step", reason: "known" });
  });

  it("an API error shows in the form", async () => {
    withLists([finding(1)]);
    const p = panel(await draw());
    button(p, "Mute")!.click();
    formReason().value = "r";
    muteFails = "this finding is already muted; end that mute first";
    button(modalRoot(), "Mute")!.click();
    await wait();
    expect(modalRoot().textContent).toContain("already muted");
  });

  it("End mute sends the DELETE and reloads", async () => {
    withLists([], [{ id: "abcdef0123456789", kind: "detector", detector: "slow-step", reason: "r", since: iso(9, 0), by: "u" }]);
    const p = panel(await draw());
    sent = [];
    button(p, "End mute")!.click();
    await wait();
    expect(sent[0]).toEqual({ method: "DELETE", url: "/api/monitor/mutes/abcdef0123456789" });
    expect(sent.some((s) => s.url === "/api/watchers")).toBe(true);
  });

  it("muteBody and untilText", () => {
    expect(mod.muteBody({ detector: "d" }, "  r  ", "")).toEqual({ detector: "d", reason: "r" });
    expect(mod.muteBody({ finding: "f" }, "r", "24")).toEqual({ finding: "f", reason: "r", hours: 24 });
    expect(() => mod.muteBody({ detector: "d" }, "   ", "")).toThrow("Give a reason.");
    expect(() => mod.muteBody({ detector: "d" }, "x".repeat(201), "")).toThrow(/too long/);
    expect(mod.untilText(undefined)).toBe("for good");
    expect(mod.untilText(iso(9, 0))).toMatch(/^until /);
  });
});
