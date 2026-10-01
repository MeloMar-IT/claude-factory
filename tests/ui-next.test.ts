import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextStep, type NextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/next.js" as string);
});
afterAll(() => restore());

const you = () => nextStep("approval", { repo: "o/r", runId: "r1" }, { message: "ok?" });
const found = () => nextStep("queued", { repo: "o/r", runId: "r2" });
const wrong = () => nextStep("watcher_error", { repo: "o/r" }, { reason: "gh down" });
const dep = () => nextStep("dependency", { repo: "o/r", issue: 7, title: "Seven" }, { watched: true, blockers: [{ issue: 3, title: "Three" }] as never });
const q = () => nextStep("questions", { repo: "o/r", issue: 5, title: "Five" }, { watched: true, questions: 2 });
const watcher = (id: string, records: NextStep[], enabled = true) => ({ id, enabled, status: { id, lastActions: [], holds: records.map((next) => ({ reason: next.text, next })) } });

describe("ui/next.js helpers", () => {
  it("sorts You first and keeps the input", () => {
    const input = [found(), you(), wrong(), you()];
    const out = ui.sortNext(input) as NextStep[];
    expect(out.map((n) => n.who)).toEqual(["You", "You", "Something is wrong", "Foundry"]);
    expect(input.map((n) => n.who)).toEqual(["Foundry", "You", "Something is wrong", "You"]);
  });

  it("needsYou keeps runs whose next move is yours", () => {
    const runs = [{ id: 1, next: you() }, { id: 2, next: found() }, { id: 3 }];
    expect(ui.needsYou(runs).map((r: { id: number }) => r.id)).toEqual([1]);
  });

  it("watcherNext puts the error first and skips holds without a record", () => {
    const w = { status: { next: wrong(), holds: [{ next: q() }, { reason: "x" }] } };
    expect(ui.watcherNext(w).map((n: NextStep) => n.kind)).toEqual(["watcher_error", "questions"]);
    expect(ui.watcherNext({})).toEqual([]);
  });

  it("waitingGroups puts every You line first", () => {
    const a = watcher("a", [dep(), q()]);
    const b = watcher("b", [you()]);
    const { yours, rest } = ui.waitingGroups([a, b, watcher("c", [q()], false), watcher("d", [])]);
    expect(yours.map((g: any) => [g.w.id, g.records.map((n: NextStep) => n.kind)])).toEqual([["a", ["questions"]], ["b", ["approval"]]]);
    expect(rest.map((g: any) => [g.w.id, g.records.map((n: NextStep) => n.kind)])).toEqual([["a", ["dependency"]]]);
  });

  it("whereTarget only accepts https?:// and #/", () => {
    expect(ui.whereTarget({ url: "https://github.com/a/b/issues/1" })).toEqual({ href: "https://github.com/a/b/issues/1", external: true });
    expect(ui.whereTarget({ url: "#/runs/x" }).external).toBe(false);
    expect(ui.whereTarget({ url: "#/watchers" }).external).toBe(false);
    for (const url of ["javascript:alert(1)", "", undefined]) expect(ui.whereTarget({ url })).toBeUndefined();
    expect(ui.whereTarget(undefined)).toBeUndefined();
  });
});

describe("ui/next.js renderer", () => {
  const render = (els: unknown[]) => els.filter(Boolean) as FakeElement[];

  it("shows every field of the record", () => {
    const n = { ...dep(), until: "after #3" };
    const parts = render(ui.nextParts(n));
    const text = parts.map((p) => p.textContent).join(" ");
    for (const s of [n.who, "#7", "Seven", n.action, n.why, "Continues: after #3"]) expect(text).toContain(s);
    const link = parts.find((p) => p.tag === "a" && p.attrs.href === "https://github.com/o/r/issues/7")!;
    expect(link.attrs.target).toBe("_blank");
    expect(link.attrs.rel).toBe("noopener");
  });

  it("leaves out what the record does not have", () => {
    expect(render(ui.nextParts(you())).map((p) => p.textContent).join(" ")).not.toContain("Continues");
    const local = { ...dep(), repo: "/home/me/project" };
    expect(render(ui.nextParts(local)).some((p) => p.attrs.href?.includes("/issues/"))).toBe(false);
    const bare = render(ui.nextParts(dep(), { ref: false }));
    expect(bare.some((p) => p.attrs.href?.includes("/issues/"))).toBe(false);
    expect(bare.map((p) => p.textContent).join(" ")).not.toContain("Seven");
  });

  it("whereLink links GitHub in a new tab and the UI in the same tab", () => {
    const gh = ui.whereLink({ label: "Issue #1", url: "https://github.com/a/b/issues/1" }) as FakeElement;
    expect(gh.tag).toBe("a");
    expect(gh.attrs).toMatchObject({ href: "https://github.com/a/b/issues/1", target: "_blank", rel: "noopener", class: "hold-link" });
    expect(gh.textContent.endsWith(" ↗")).toBe(true);
    for (const url of ["#/runs/x", "#/watchers"]) {
      const l = ui.whereLink({ label: "Here", url }) as FakeElement;
      expect(l.tag).toBe("a");
      expect(l.attrs.href).toBe(url);
      expect(l.attrs.target).toBeUndefined();
    }
    const bad = ui.whereLink({ label: "Evil", url: "javascript:alert(1)" }) as FakeElement;
    expect(bad.tag).toBe("span");
    expect(bad.all("a")).toEqual([]);
    expect(bad.textContent).toBe("Evil");
  });

  it("nextList sorts You first", () => {
    const ul = ui.nextList([found(), you()]) as FakeElement;
    expect(ul.tag).toBe("ul");
    expect(ul.attrs.class).toBe("holds");
    const items = ul.all("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("You");
  });

  it("nextBlock shows the action and why", () => {
    const n = you();
    const b = ui.nextBlock(n) as FakeElement;
    expect(b.attrs.class).toContain("next-step");
    expect(b.attrs.class).toContain("who-you");
    for (const s of ["What happens next", n.action, n.why]) expect(b.textContent).toContain(s);
  });
});

describe("timing in the UI", () => {
  const timing = { step: 2, of: 3, stepId: "b", progress: "Step 2 of 3", estimate: "Estimate: about 20 min left (usually 25–40 min in total)", note: "Taking longer than usual" };
  const withTiming = (): NextStep => ({ ...nextStep("one_at_a_time", { repo: "o/r", runId: "r2" }, { blockingRun: "r1" }), until: "after that run (about 20 min left)", timing });

  it("timingParts has no wording of its own", () => {
    expect(ui.timingParts(you())).toEqual([]);
    const parts = ui.timingParts(withTiming()) as FakeElement[];
    expect(parts.map((p) => p.textContent)).toEqual([timing.progress, timing.estimate, timing.note]);
    expect(parts[2]!.attrs.class).toBe("slow-note");
  });

  it("nextParts shows them after Continues and before the link", () => {
    const text = (ui.nextParts(withTiming()) as (FakeElement | null)[]).filter(Boolean).map((p) => p!.textContent);
    const i = text.findIndex((t) => t.startsWith("Continues:"));
    expect(text.slice(i + 1, i + 4)).toEqual([timing.progress, timing.estimate, timing.note]);
    expect(text[i + 4]).toBe("Run page"); // the link follows
  });

  it("whenParts is empty without until and timing", () => {
    expect(ui.whenParts(found())).toEqual([]);
    expect(ui.whenParts(withTiming())).toHaveLength(4);
  });

  it("nextBlock shows them; a record without timing renders as before", () => {
    expect((ui.nextBlock(withTiming()) as FakeElement).textContent).toContain(timing.estimate);
    expect((ui.nextBlock(you()) as FakeElement).textContent).not.toContain("Step");
  });

  it("runRow and queueRow show until and timing", async () => {
    const runs = await import("../ui/runs.js" as string);
    const next = withTiming();
    const row = runs.runRow({ runId: "r2", flow: "f", status: "running", task: "t", history: [], startedAt: new Date().toISOString(), totalCostUsd: 0, next }) as FakeElement;
    for (const s of [next.text, "Continues: after that run (about 20 min left)", timing.progress, timing.estimate]) expect(row.textContent).toContain(s);
    expect(() => runs.runRow({ runId: "r3", flow: "f", status: "running", task: "t", history: [], startedAt: new Date().toISOString() })).not.toThrow();
    const q = runs.queueRow({ runId: "r2", kind: "run", next }, () => {}) as FakeElement;
    expect(q.textContent).toContain("Continues: after that run (about 20 min left)");
  });
});

describe("the changed UI modules", () => {
  it("load", async () => {
    const dashboard = await import("../ui/dashboard.js" as string);
    const admin = await import("../ui/admin.js" as string);
    const runs = await import("../ui/runs.js" as string);
    expect(typeof dashboard.renderDashboard).toBe("function");
    expect(typeof admin.renderWatchers).toBe("function");
    expect(typeof runs.renderRunsList).toBe("function");
    expect(typeof runs.renderRunDetail).toBe("function");
  });
});
