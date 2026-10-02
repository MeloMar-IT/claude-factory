import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/turn-act.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

let posted: any[];
let details: Record<string, unknown>;
let failPost: string | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  posted = [];
  failPost = undefined;
  details = {};
  (document as any).getElementById("modal-root").replaceChildren();
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const reply = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, statusText: "x", json: async () => body });
    if (init?.method === "POST") {
      posted.push(JSON.parse(init.body ?? "{}"));
      return failPost ? reply({ error: failPost }, false) : reply({ count: 0 });
    }
    return reply(details[decodeURIComponent(url.split("key=")[1] ?? "")] ?? { error: "no" }, url.includes("key=") && !!details[decodeURIComponent(url.split("key=")[1]!)]);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const item = (kind: any, key = "k1") => ({ key, repo: "o/a", what: "Five", next: nextStep(kind, { repo: "o/a", issue: 5, title: "Five", runId: "r1" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" }), unblocks: 0, dismissable: true, watcher: "w", acts: ["x"] });
const modalRoot = () => (document as any).getElementById("modal-root") as FakeElement;
const button = (root: FakeElement, text: string) => root.all("button").find((b) => b.textContent === text);
const click = (el: FakeElement | undefined) => { expect(el, "button").toBeDefined(); el!.listeners.click![0]!(); };
const onAct = (body: unknown) => api.actTurn(body);

const QUESTIONS = { stamp: "S1", digest: "DS1", acts: ["defaults", "answer"], text: "t", questions: [
  { n: 1, title: "Which account?", text: "Options a or b.", recommendation: "(a)" },
  { n: 2, title: "Where?", text: "Here or there." },
] };

async function open(it: any, label: string, detail: unknown) {
  details[it.key] = detail;
  const root = new FakeElement("div");
  root.append(...ui.actButtons(it, onAct));
  click(button(root, label));
  await flush();
  return modalRoot();
}

describe("actButtons", () => {
  it("shows the right button per kind", () => {
    const labels = (kind: string) => ui.actButtons(item(kind), onAct).map((b: FakeElement) => b.textContent);
    expect(labels("questions")).toEqual(["Show questions"]);
    expect(labels("planner_questions")).toEqual(["Show questions"]);
    expect(labels("approve_plan")).toEqual(["Show plan"]);
    expect(labels("approve_split")).toEqual(["Show split"]);
    expect(labels("approval")).toEqual(["Show request"]);
    expect(labels("failed")).toEqual(["Retry", "Retry with a hint…"]);
  });

  it("tells the error when the detail cannot be read, and opens nothing", async () => {
    const root = new FakeElement("div");
    root.append(...ui.actButtons(item("questions"), onAct));
    click(button(root, "Show questions"));
    await flush();
    expect(modalRoot().children).toHaveLength(0);
    expect((document as any).getElementById("toast").textContent).toBe("no");
  });

  it("Retry posts directly, without a stamp", async () => {
    const root = new FakeElement("div");
    root.append(...ui.actButtons(item("failed", "kf"), onAct));
    click(button(root, "Retry"));
    await flush();
    expect(posted).toEqual([{ key: "kf", action: "retry" }]);
    expect((document as any).getElementById("toast").textContent).toBe("Done — continuing");
  });
});

describe("questions", () => {
  it("lists title, body and recommendation", async () => {
    const m = await open(item("questions"), "Show questions", QUESTIONS);
    expect(m.textContent).toContain("Q1. Which account?");
    expect(m.textContent).toContain("Options a or b.");
    expect(m.textContent).toContain("Recommendation: (a)");
    expect(m.textContent).toContain("Q2. Where?");
  });

  it("accepts all recommendations as /defaults, and not for planner questions", async () => {
    const m = await open(item("questions"), "Show questions", QUESTIONS);
    click(button(m, "Accept all recommendations"));
    await flush();
    expect(posted).toEqual([{ key: "k1", action: "defaults", stamp: "S1", digest: "DS1" }]);
    expect(modalRoot().children).toHaveLength(0);
    const p = await open(item("planner_questions", "kp"), "Show questions", { stamp: "S2", acts: ["answer"], text: "free prose" });
    expect(button(p, "Accept all recommendations")).toBeUndefined();
    expect(p.textContent).toContain("free prose");
  });

  it("needs an answer for every question and never fills one in; Use recommendation does it visibly", async () => {
    const m = await open(item("questions"), "Show questions", QUESTIONS);
    click(button(m, "Answer…"));
    const boxes = m.all("textarea");
    expect(boxes).toHaveLength(2);
    click(button(m, "Post answers")); // all empty: nothing is posted
    await flush();
    expect(posted).toEqual([]);
    expect((document as any).getElementById("toast").textContent).toBe("Answer every question");
    boxes[1]!.value = "there";
    click(button(m, "Post answers")); // Q1 is still empty, although it has a recommendation
    await flush();
    expect(posted).toEqual([]);
    click(button(m, "Use recommendation"));
    expect(boxes[0]!.value).toBe("Go with the recommendation.");
    click(button(m, "Post answers"));
    await flush();
    expect(posted).toEqual([{ key: "k1", action: "answer", stamp: "S1", digest: "DS1", answers: [{ n: 1, text: "Go with the recommendation." }, { n: 2, text: "there" }] }]);
  });

  it("offers one box when no questions were parsed, and Back returns to the questions", async () => {
    const m = await open(item("planner_questions", "kp"), "Show questions", { stamp: "S2", digest: "DS2", acts: ["answer"], text: "free prose" });
    click(button(m, "Answer…"));
    expect(m.all("textarea")).toHaveLength(1);
    expect(m.textContent).toContain("Your answer");
    click(button(m, "Back"));
    expect(m.textContent).toContain("free prose");
    click(button(m, "Answer…"));
    m.all("textarea")[0]!.value = "Use Postgres";
    click(button(m, "Post answers"));
    await flush();
    expect(posted).toEqual([{ key: "kp", action: "answer", stamp: "S2", digest: "DS2", answers: [{ text: "Use Postgres" }] }]);
  });

  it("keeps the panel open and enables the buttons again when the call fails", async () => {
    const m = await open(item("questions"), "Show questions", QUESTIONS);
    failPost = "this changed meanwhile";
    const accept = button(m, "Accept all recommendations")!;
    click(accept);
    await flush();
    expect(accept.disabled).toBe(false);
    expect(modalRoot().children.length).toBeGreaterThan(0);
    expect((document as any).getElementById("toast").textContent).toBe("this changed meanwhile");
  });
});

describe("plans and splits", () => {
  const plan = { stamp: "S3", digest: "DS3", acts: ["approve", "reject"], text: "the plan", proposal: { risk: 80, reason: "touches login", gate: "the risk score is above 75", text: "the plan" } };

  it("shows risk, reason and gate for a plan, and the split risk without a reason", async () => {
    const m = await open(item("approve_plan", "kq"), "Show plan", plan);
    expect(m.textContent).toContain("Risk: 80/100 — touches login");
    expect(m.textContent).toContain("You decide: the risk score is above 75");
    expect(m.textContent).toContain("the plan");
    const s = await open(item("approve_split", "ks"), "Show split", { stamp: "S4", acts: ["approve", "reject"], text: "x", proposal: { risk: 70, split: true, gate: "above 50", text: "parts" } });
    expect(s.textContent).toContain("Split risk: 70/100");
    expect(s.textContent).not.toContain("—");
    expect(s.textContent).toContain("You decide: above 50");
  });

  it("approves with notes and the stamp, and rejects only with a reason", async () => {
    const m = await open(item("approve_plan", "kq"), "Show plan", plan);
    m.all("textarea")[0]!.value = " ship it ";
    click(button(m, "Approve"));
    await flush();
    expect(posted).toEqual([{ key: "kq", action: "approve", stamp: "S3", digest: "DS3", text: "ship it" }]);
    const r = await open(item("approve_plan", "kq"), "Show plan", plan);
    click(button(r, "Reject"));
    await flush();
    expect(posted).toHaveLength(1);
    expect((document as any).getElementById("toast").textContent).toBe("Say what to change");
    r.all("textarea")[0]!.value = "use another approach";
    click(button(r, "Reject"));
    await flush();
    expect(posted[1]).toEqual({ key: "kq", action: "reject", stamp: "S3", digest: "DS3", text: "use another approach" });
  });
});

describe("retry with a hint", () => {
  it("posts the hint with the stamp of the item", async () => {
    const m = await open(item("failed", "kf"), "Retry with a hint…", { stamp: "S5", acts: ["retry", "retry_hint"], text: "boom" });
    click(button(m, "Retry"));
    await flush();
    expect(posted).toEqual([]);
    m.all("textarea")[0]!.value = "try the other file";
    click(button(m, "Retry"));
    await flush();
    expect(posted).toEqual([{ key: "kf", action: "retry_hint", text: "try the other file", stamp: "S5" }]);
  });
});
