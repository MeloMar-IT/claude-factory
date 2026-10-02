import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("lastOkText", () => {
  it("says when the last successful check was, or that there is none", async () => {
    const { lastOkText } = (await import("../ui/admin.js" as string)) as any;
    expect(lastOkText({ lastOk: new Date().toISOString() })).toMatch(/^ · last successful check /);
    expect(lastOkText({})).toBe(" · no successful check yet");
    expect(lastOkText(undefined)).toBe("");
  });
});

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

describe("notifyFrom (Settings)", () => {
  const base = { macos: true, slack: "", command: "", on: ["failed"], successes: false, throttle: "", quietFrom: "", quietTo: "", summaryAt: "" };
  let notifyFrom: (v: unknown) => any;
  beforeAll(async () => {
    notifyFrom = (await import("../ui/admin.js" as string)).notifyFrom;
  });

  it("builds quiet hours only from both times", () => {
    expect(notifyFrom({ ...base, quietFrom: "22:00", quietTo: "07:00" }).quiet_hours).toEqual({ from: "22:00", to: "07:00" });
    expect(notifyFrom({ ...base, quietFrom: "22:00" }).quiet_hours).toBeUndefined();
  });
  it("leaves out an empty summary time", () => {
    expect(notifyFrom(base).daily_summary_at).toBeUndefined();
    expect(notifyFrom({ ...base, summaryAt: "09:00" }).daily_summary_at).toBe("09:00");
  });
  it("defaults the throttle to 5 and keeps 0", () => {
    expect(notifyFrom(base).throttle_minutes).toBe(5);
    expect(notifyFrom({ ...base, throttle: "0" }).throttle_minutes).toBe(0);
  });
  it("passes the other values through", () => {
    expect(notifyFrom({ ...base, successes: true, slack: " https://h/x ", command: "say hi" })).toMatchObject({
      macos: true, successes: true, slack_webhook: "https://h/x", command: "say hi", on: ["failed"],
    });
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

describe("plain error text in the UI", () => {
  it("detailsRow shows the raw reason under Details", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    const row = runs.detailsRow({ reason: "x" }) as FakeElement[];
    expect(row[0]!.tag).toBe("dt");
    expect(row[0]!.textContent).toBe("Details");
    expect(row[1]!.textContent).toBe("x");
    expect(runs.detailsRow({})).toBeNull();
  });

  it("stepEntry keeps the raw error out of the summary and shows it under Details", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    const bad = runs.stepEntry("r", { id: "a", type: "shell", ok: false, visit: 1, durationMs: 5, error: "exit code 1" }, 0) as FakeElement;
    expect(bad.all("summary")[0]!.textContent).not.toContain("exit code 1");
    expect(bad.textContent).toContain("Details");
    expect(bad.textContent).toContain("exit code 1");
    const ok = runs.stepEntry("r", { id: "a", type: "shell", ok: true, visit: 1, durationMs: 5 }, 0) as FakeElement;
    expect(ok.textContent).not.toContain("Details");
  });

  it("the run page block and the watcher card show the plain text, action first", () => {
    const n = nextStep("failed", { runId: "r1" }, { reason: 'step "a" failed: exit code 1' });
    const t = ui.nextBlock(n).textContent as string;
    expect(t.indexOf(n.action)).toBeLessThan(t.indexOf(n.why));
    expect(t).toContain("The step a failed");
    expect(t).not.toContain('step "a" failed');
    expect(t).not.toContain("exit code");
    const w = nextStep("watcher_error", { repo: "o/r" }, { reason: "cannot access o/r with gh: x" });
    const c = ui.nextList([w]).textContent as string;
    expect(c.indexOf(w.action)).toBeLessThan(c.indexOf("The watcher for o/r can't reach GitHub"));
    expect(c).not.toContain("cannot access");
  });
});

describe("the \"?\" and the status names", () => {
  const text = (els: unknown[]) => (els.filter(Boolean) as FakeElement[]).map((e) => e.textContent).join(" ");
  const run = (over: Record<string, unknown> = {}) => ({ runId: "r9", flow: "f", status: "waiting", history: [], totalCostUsd: 0, startedAt: "2026-10-01T10:00:00Z", next: you(), ...over });
  let runs: any;
  let admin: any;
  beforeAll(async () => {
    runs = await import("../ui/runs.js" as string);
    admin = await import("../ui/admin.js" as string);
  });

  it("helpMark is a real button that opens and closes its note", () => {
    const m = ui.helpMark("One. Two.") as FakeElement;
    expect(m.attrs.class).toBe("help");
    const btn = m.all("button")[0]!;
    const note = m.children.find((c) => c instanceof FakeElement && c.attrs.class === "help-text") as FakeElement;
    expect(btn.attrs).toMatchObject({ type: "button", class: "help-mark", "aria-expanded": "false" });
    expect(btn.attrs["aria-label"]).toBeTruthy();
    expect(btn.textContent).toBe("?");
    expect(btn.attrs.tabindex).toBeUndefined();
    expect(btn.attrs.disabled).toBeUndefined();
    expect(note.attrs.role).toBe("note");
    expect(Object.keys(btn.listeners)).toEqual(["click"]);
    expect(Object.keys(m.listeners)).toEqual(["click"]);
    expect(Object.keys(note.listeners)).toEqual([]);
    expect(note.hidden).toBe(true);
    btn.click();
    expect(note.hidden).toBe(false);
    expect(btn.attrs["aria-expanded"]).toBe("true");
    btn.click();
    expect(note.hidden).toBe(true);
    expect(btn.attrs["aria-expanded"]).toBe("false");
    expect(ui.helpMark("")).toBeNull();
    expect(ui.helpMark(undefined)).toBeNull();
  });

  it("pressing the ? does not open the run, a normal cell does", () => {
    const loc = { hash: "" };
    (globalThis as any).location = loc;
    try {
      const row = runs.runRow(run()) as FakeElement;
      row.all("button")[0]!.click();
      expect(loc.hash).toBe("");
      const note = row.all("span").find((s) => s.attrs.class === "help-text")!;
      expect(note.hidden).toBe(false);
      note.click();
      expect(loc.hash).toBe("");
      row.all("td")[1]!.click();
      expect(loc.hash).toBe("#/runs/r9");
    } finally {
      delete (globalThis as any).location;
    }
  });

  it("a ? inside a clickable parent does not reach the parent", () => {
    const spy: unknown[] = [];
    const root = (globalThis as any).document.createElement("div") as FakeElement;
    const list = ui.nextList([you()]) as FakeElement;
    root.addEventListener("click", () => spy.push(1));
    root.append(list);
    list.all("button")[0]!.click();
    expect(spy).toEqual([]);
    list.all("li")[0]!.click();
    expect(spy).toHaveLength(1);
  });

  it("nextStatus shows the status and help of the record", () => {
    const n = { ...you(), status: "S from server", help: "One. Two." };
    const [pill, help] = ui.nextStatus(n) as FakeElement[];
    expect(pill!.textContent).toBe("S from server");
    expect(help!.all("span").find((s) => s.attrs.role === "note")!.textContent).toBe("One. Two.");
    expect(pill!.attrs.class).toContain("who-you");
    expect(pill!.attrs.class).toContain("kind-approval");
  });

  it("nextStatus uses the record's words for every kind and spins only while working", async () => {
    const { KINDS } = await import("../src/words.js");
    for (const kind of KINDS) {
      const n = nextStep(kind, { repo: "o/r", runId: "x" }, { blockers: [{ issue: 1, title: "t" }] as never });
      const [pill, help] = ui.nextStatus(n) as FakeElement[];
      expect(pill!.textContent).toBe(n.status);
      expect(help!.all("span").find((s) => s.attrs.role === "note")!.textContent).toBe(n.help);
      expect(pill!.all("span").length > 0).toBe(kind === "running");
    }
  });

  it("statusMark takes any object with status and help", () => {
    const [pill, help] = ui.statusMark({ status: "active", help: "A. B." }, "state-active");
    expect(pill.attrs.class).toBe("pill state-active");
    expect(help).not.toBeNull();
    expect(ui.statusMark({ status: "active" }, "state-active")[1]).toBeNull();
  });

  it("nextParts is flat, has the status and can leave it out", () => {
    const n = you();
    const parts = ui.nextParts(n) as unknown[];
    for (const p of parts) if (p) expect(p instanceof FakeElement).toBe(true);
    expect(text(parts)).toContain(n.status);
    expect(text(parts)).toContain(n.help);
    const bare = text(ui.nextParts(n, { status: false }));
    expect(bare).not.toContain(n.status);
    expect(bare).not.toContain(n.help);
    expect(ui.nextBlock(n).textContent).not.toContain(n.help);
    expect((ui.nextList([you(), found()]) as FakeElement).all("button")).toHaveLength(2);
  });

  it("runRow shows the plain status, not the run state", () => {
    const stopped = runs.runRow(run({ status: "stopped", next: nextStep("usage_limit", { repo: "o/r", runId: "r9" }) })) as FakeElement;
    const first = stopped.all("td")[0]!;
    expect(first.textContent).toContain("paused — usage limit");
    expect(first.textContent).not.toContain("stopped");
    expect(first.all("button")).toHaveLength(1);
    const waiting = runs.runRow(run()) as FakeElement;
    expect(waiting.textContent).toContain("waiting for you — approval");
    expect(waiting.textContent).not.toContain("waiting for approval");
    const none = runs.runRow(run({ next: undefined })) as FakeElement;
    expect(none.all("td")[0]!.textContent).toBe("");
  });

  it("queueRow shows the status with a ? and removes on request", () => {
    const calls: number[] = [];
    const p = { runId: "q1", kind: "run", next: nextStep("one_at_a_time", { repo: "o/r", runId: "q1" }) };
    const row = runs.queueRow(p, () => calls.push(1)) as FakeElement;
    expect(row.textContent).toContain("waiting for another run");
    const buttons = row.all("button");
    expect(buttons[0]!.textContent).toBe("?");
    buttons.find((b) => b.textContent === "Remove")!.click();
    expect(calls).toEqual([1]);
  });

  it("stepRow always says what the step is", async () => {
    const { STEP_TYPES } = await import("../ui/step-types.js" as string);
    const dd = (s: unknown) => (runs.stepRow(s) as FakeElement[])[1]!.textContent;
    const dt = (s: unknown) => (runs.stepRow(s) as FakeElement[])[0]!.textContent;
    const flowDef = (step: unknown) => ({ steps: [step] });
    const described = { status: "running", state: { next: "a" }, flowDef: flowDef({ id: "a", type: "shell", description: "Builds it" }) };
    expect(dt(described)).toBe("Current step");
    expect(dd(described)).toBe("a — Builds it");
    const failed = { status: "failed", state: { next: "b" }, flowDef: flowDef({ id: "b", type: "shell" }) };
    expect(dt(failed)).toBe("Resumes at step");
    expect(dd(failed)).toBe("b — Shell");
    for (const [type, v] of Object.entries(STEP_TYPES) as [string, { label: string }][]) {
      const out = dd({ status: "failed", state: { next: "c" }, flowDef: flowDef({ id: "c", type }) });
      expect(out.endsWith(v.label)).toBe(true);
      expect(out).toContain(" — ");
    }
    for (const s of [{ status: "failed", state: { next: "z" } }, { status: "failed", state: { next: "z" }, flowDef: flowDef({ id: "c", type: "shell" }) }]) {
      expect(dd(s)).toBe("z — what this step does is not saved with this run");
    }
    expect(runs.stepRow({ status: "succeeded", state: { next: "a" } })).toBeNull();
    expect(runs.stepRow({ status: "failed" })).toBeNull();
  });

  it("watcherStateMark takes its words from the state", () => {
    const w = { state: { name: "disabled", status: "disabled", help: "A. B." } };
    const [pill, help] = admin.watcherStateMark(w) as FakeElement[];
    expect(pill!.textContent).toBe("disabled");
    expect(pill!.attrs.class).toBe("pill state-disabled");
    expect(help!.textContent).toContain("A. B.");
    expect(admin.watcherStateMark({})).toBeNull();
  });

  it("watcherConfig drops what the API adds, so the config accepts it again", async () => {
    const { WatcherSchema } = await import("../src/config.js");
    const base = WatcherSchema.parse({ id: "w", github_repo: "o/r" });
    const item = { ...base, state: { name: "active", status: "active", help: "A. B." }, status: { id: "w", lastActions: [] } };
    expect(WatcherSchema.parse(admin.watcherConfig(item))).toEqual(base);
    expect(() => WatcherSchema.parse(item)).toThrow();
    expect(admin.watcherConfig()).toEqual({});
  });
});

describe("the Runs pages for a user", () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const RUN = { runId: "r1", flow: "walk", status: "succeeded", startedAt: new Date().toISOString(), history: [], totalCostUsd: 0, task: "do it", vars: {} };
  const QUEUE = { pending: [], active: [], concurrency: 2 };
  const answers: Record<string, unknown> = { "/api/runs": [RUN], "/api/queue": QUEUE };

  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    (globalThis as any).fetch = async (url: string) => {
      asked.push(url);
      return { ok: true, status: 200, statusText: "OK", json: async () => answers[url] ?? {} };
    };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    delete (globalThis as any).EventSource;
  });

  const connected = () => {
    const main = new FakeElement("div") as FakeElement & { isConnected: boolean };
    main.isConnected = true;
    return main;
  };

  it("the list of a user asks for the runs and the queue, never for the owners, also after the refresh timer", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    const main = connected();
    const stop = await runs.renderRunsList(main, { admin: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked.length).toBeGreaterThanOrEqual(3);
    expect(new Set(asked)).toEqual(new Set(["/api/runs", "/api/queue"]));
    expect(main.textContent).toContain("walk");
    expect(main.textContent).not.toContain("running ·");
    expect(main.textContent).not.toContain("Owner");
    stop();
  });

  it("a user sees how many runs are ahead of their queued run", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    expect(runs.aheadText(1)).toBe("1 run ahead of you");
    expect(runs.aheadText(2)).toBe("2 runs ahead of you");
    const pending = (ahead: number) => ({ runId: "q1", kind: "run", ahead });
    try {
      for (const [n, text] of [[2, "2 runs ahead of you"], [1, "1 run ahead of you"]] as const) {
        answers["/api/queue"] = { pending: [pending(n)], active: [], concurrency: 2 };
        const main = connected();
        (await runs.renderRunsList(main, { admin: false }))();
        expect(main.textContent).toContain(text);
      }
      answers["/api/queue"] = { pending: [pending(0)], active: [], concurrency: 2 };
      const main = connected();
      (await runs.renderRunsList(main, { admin: false }))();
      expect(main.textContent).toContain("q1");
      expect(main.textContent).not.toContain("ahead of you");
    } finally {
      answers["/api/queue"] = QUEUE;
    }
  });

  it("the list of an admin also asks for the queue and the owners, and shows the owner column", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    answers["/api/run-owners"] = [{ id: "u1", name: "Ann", runs: 3 }, { id: "u2", name: "Bob", runs: 1 }];
    answers["/api/runs"] = [{ ...RUN, ownerName: "Ann" }, { ...RUN, runId: "r2" }];
    answers["/api/runs?owner=u2"] = [RUN];
    try {
      const main = connected();
      const stop = await runs.renderRunsList(main);
      expect(new Set(asked)).toEqual(new Set(["/api/runs", "/api/queue", "/api/run-owners"]));
      expect(main.textContent).toContain("0/2 running");
      expect(main.all("th").map((th) => th.textContent)).toContain("Owner");
      const cells = main.all("tr").map((tr) => tr.all("td").map((td) => td.textContent)).filter((c) => c.length);
      expect(cells.map((c) => c[3])).toEqual(["Ann", "—"]);
      const select = main.all("select")[0]!;
      expect(select.all("option").map((o) => o.textContent)).toEqual(["All owners", "Ann (3)", "Bob (1)"]);
      asked.length = 0;
      select.fire("change", { target: { value: "u2" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toContain("/api/runs?owner=u2");
      stop();
    } finally {
      answers["/api/runs"] = [RUN];
      delete answers["/api/run-owners"];
      delete answers["/api/runs?owner=u2"];
    }
  });

  it("an admin's list with a filter and no runs says so", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    answers["/api/run-owners"] = [{ id: "u1", name: "Ann", runs: 0 }];
    answers["/api/runs?owner=u1"] = [];
    try {
      const main = connected();
      const stop = await runs.renderRunsList(main);
      main.all("select")[0]!.fire("change", { target: { value: "u1" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(main.textContent).toContain("No runs of this account.");
      stop();
    } finally {
      delete answers["/api/run-owners"];
      delete answers["/api/runs?owner=u1"];
    }
  });

  it("runRow has an owner cell only when asked for", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    expect(runs.runRow(RUN).all("td")).toHaveLength(6);
    expect(runs.runRow({ ...RUN, ownerName: "Ann" }, { owner: true }).all("td")).toHaveLength(7);
  });

  it("the watcher form leaves 'owner' out of the config when the field is empty", async () => {
    const { ownerSetting } = (await import("../ui/admin.js" as string)) as any;
    expect({ id: "w", owner: ownerSetting(" ann@example.com ") }).toEqual({ id: "w", owner: "ann@example.com" });
    expect(JSON.parse(JSON.stringify({ id: "w", owner: ownerSetting("  ") }))).toEqual({ id: "w" });
  });

  it("says 'No runs yet.' to a user without runs", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    answers["/api/runs"] = [];
    try {
      const main = connected();
      (await runs.renderRunsList(main, { admin: false }))();
      expect(main.textContent).toContain("No runs yet.");
      expect(main.textContent).not.toContain("Open a flow");
    } finally {
      answers["/api/runs"] = [RUN];
    }
  });

  const stubEventSource = () => {
    const opened: string[] = [];
    const handlers: Record<string, (e: { data: string }) => void> = {};
    (globalThis as any).EventSource = class {
      static CLOSED = 2;
      readyState = 1;
      constructor(url: string) { opened.push(url); }
      addEventListener(type: string, fn: (e: { data: string }) => void) { handlers[type] = fn; }
      close() {}
    };
    return { opened, handlers };
  };
  const flowLinks = (main: FakeElement) => main.all("a").filter((a) => (a.attrs.href ?? "").startsWith("#/flows/"));

  it("the run page of a user opens only the event stream and has no link to the flow", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    const { opened, handlers } = stubEventSource();
    const main = connected();
    const stop = runs.renderRunDetail(main, "r1", { admin: false });
    handlers.update!({ data: JSON.stringify({ summary: RUN }) });
    expect(opened).toEqual(["/api/runs/r1/events"]);
    expect(asked).toEqual([]);
    expect(main.textContent).toContain("walk");
    expect(flowLinks(main)).toHaveLength(0);
    stop();
  });

  it("the run page of an admin links to the flow", async () => {
    const runs = (await import("../ui/runs.js" as string)) as any;
    const { handlers } = stubEventSource();
    const main = connected();
    const stop = runs.renderRunDetail(main, "r1");
    handlers.update!({ data: JSON.stringify({ summary: RUN }) });
    expect(flowLinks(main)).toHaveLength(1);
    stop();
  });
});
