import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

type Answer = { status: number; error: string } | "throw";
let sessions: any[];
let repos: string[];
let sent: { method: string; url: string; body: any }[];
let gets: string[];
let answers: Answer[];
let hold: { release: (a?: Answer) => void } | undefined;
let holdNext: boolean;
const realFetch = globalThis.fetch;
const realConfirm = (globalThis as any).confirm;
let confirmAnswer = true;

const session = (over: object = {}) => ({
  id: "s1",
  repo: "acme/app",
  repoAvailable: true,
  title: "My idea",
  idea: "Line one\nLine two",
  state: "exploring",
  drafts: [],
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }],
  created: new Date().toISOString(),
  updated: new Date().toISOString(),
  mine: true,
  ...over,
});
const dropped = (over: object = {}) => session({ state: "dropped", droppedAt: new Date().toISOString(), removedOn: new Date(Date.now() + 30 * 864e5).toISOString(), ...over });

beforeEach(async () => {
  sessions = [];
  repos = ["acme/app"];
  sent = [];
  gets = [];
  answers = [];
  hold = undefined;
  holdNext = false;
  confirmAnswer = true;
  (globalThis as any).location = { hash: "#/refinement" };
  (globalThis as any).confirm = () => confirmAnswer;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets.push(url);
      if (url === "/api/refinement") return reply({ sessions: [...sessions], repos });
      const found = sessions.find((s) => `/api/refinement/${s.id}` === url);
      return found ? reply(found) : reply({ error: "no such refinement session" }, 404);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    let answer = answers.shift();
    if (holdNext) {
      holdNext = false;
      answer = await new Promise<Answer | undefined>((r) => (hold = { release: r }));
    }
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer) return reply({ error: answer.error }, answer.status);
    if (url === "/api/refinement") return reply(session({ id: "new1", title: body.title ?? "T" }), 201);
    return reply(session());
  };
  await ui.renderRefinement(main(), {});
  press(button(main(), "Open sessions"));
  await flush();
  sent = [];
  gets = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).confirm = realConfirm;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const bad = (el: FakeElement) => walk(el).filter((e) => e.attrs.class === "status bad").map((e) => e.textContent);
const showList = async (admin = false) => void (await ui.renderRefinement(main(), { admin }));
const showPage = async (id = "s1", admin = false) => {
  (globalThis as any).location.hash = `#/refinement/${id}`;
  await ui.renderRefinement(main(), { admin, id });
};
const buttonsOf = () => walk(main()).filter((e) => e.tag === "button" && e.attrs.class?.includes("small")).map((e) => e.textContent);

describe("pure functions", () => {
  it("has the five states", () => {
    expect(Object.keys(ui.STATE_LABELS)).toEqual(["exploring", "drafting", "ready", "published", "dropped"]);
  });
  it("sessionProblem and sessionBody", () => {
    expect(ui.sessionProblem({ repo: "", idea: "x" })).toBe("Choose a repository.");
    expect(ui.sessionProblem({ repo: "a/b", idea: "  " })).toBe("Describe your idea.");
    expect(ui.sessionProblem({ repo: "a/b", idea: "x" })).toBe("");
    expect(ui.sessionBody({ repo: "a/b", idea: "x", title: "  " })).toEqual({ repo: "a/b", idea: "x" });
    expect(ui.sessionBody({ repo: "a/b", idea: "x", title: " T " })).toEqual({ repo: "a/b", idea: "x", title: "T" });
  });
  it("logText and errorText", () => {
    expect(ui.logText({ what: "created", who: "Ann" })).toBe("Ann started the session");
    expect(ui.logText({ what: "renamed", who: "Ann", detail: "New" })).toBe('Ann renamed it to "New"');
    expect(ui.logText({ what: "dropped", who: "an administrator" })).toBe("an administrator dropped the session");
    expect(ui.logText({ what: "restored", who: "Ann" })).toBe("Ann restored the session");
    expect(ui.errorText(new TypeError("x"))).toBe("Could not reach the server.");
    expect(ui.errorText(new Error("sentence"))).toBe("sentence");
    expect(ui.errorText({})).toBe("Something went wrong.");
  });
});

describe("the list", () => {
  it("shows four heads to a user and the owner to an admin", async () => {
    sessions = [session({ ownerName: "Ann", mine: false })];
    await showList();
    expect(walk(main()).filter((e) => e.tag === "th").map((e) => e.textContent)).toEqual(["Title", "Repository", "State", "Last change"]);
    await showList(true);
    expect(walk(main()).filter((e) => e.tag === "th").map((e) => e.textContent)).toContain("Owner");
    expect(main().textContent).toContain("Ann");
  });
  it("shows the empty text and keeps dropped sessions out of the open list", async () => {
    await showList();
    expect(main().textContent).toContain("No refinement sessions yet.");
    sessions = [dropped({ title: "Gone" })];
    await showList();
    expect(main().textContent).not.toContain("Gone");
  });
  it("shows dropped sessions with a Restore that does not open the row", async () => {
    sessions = [dropped({ title: "Gone" }), dropped({ id: "s2", title: "Theirs", mine: false })];
    await showList();
    press(button(main(), "Dropped"));
    await flush();
    expect(main().textContent).toContain("Gone");
    expect(main().textContent).toContain("removed on");
    expect(walk(main()).filter((e) => e.textContent === "Restore")).toHaveLength(1);
    press(button(main(), "Restore"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/restore", body: {} }]);
    expect((globalThis as any).location.hash).toBe("#/refinement");
    press(button(main(), "Open sessions"));
    await flush();
  });
  it("shows an error toast and loads again when a restore in the list fails", async () => {
    sessions = [dropped()];
    await showList();
    press(button(main(), "Dropped"));
    await flush();
    answers.push({ status: 500, error: "broken" });
    gets = [];
    press(button(main(), "Restore"));
    await flush();
    expect(toastText()).toBe("broken");
    expect(gets).toEqual(["/api/refinement"]);
    press(button(main(), "Open sessions"));
    await flush();
  });
  it("sends one request for two clicks on Restore", async () => {
    sessions = [dropped()];
    await showList();
    press(button(main(), "Dropped"));
    await flush();
    holdNext = true;
    const r = button(main(), "Restore");
    press(r);
    press(r);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
    press(button(main(), "Open sessions"));
    await flush();
  });
});

describe("new session", () => {
  const open = async () => {
    await showList();
    press(button(main(), "New session"));
  };
  it("offers the repositories of the answer", async () => {
    repos = ["a/one", "b/two"];
    await open();
    expect(walk(root()).filter((e) => e.tag === "option").map((e) => e.textContent)).toEqual(["a/one", "b/two"]);
  });
  it("needs an idea", async () => {
    await open();
    press(button(root(), "Start session"));
    await flush();
    expect(bad(root())).toEqual(["Describe your idea."]);
    expect(sent).toEqual([]);
  });
  it("sends repo and idea, and the title only when filled, then opens the session", async () => {
    await open();
    field(root(), "idea")!.value = "A rough idea";
    press(button(root(), "Start session"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement", body: { repo: "acme/app", idea: "A rough idea" } }]);
    expect((globalThis as any).location.hash).toBe("#/refinement/new1");
    await open();
    field(root(), "idea")!.value = "Idea";
    field(root(), "title")!.value = " Title ";
    press(button(root(), "Start session"));
    await flush();
    expect(sent[1]!.body).toEqual({ repo: "acme/app", idea: "Idea", title: "Title" });
  });
  it("keeps a server error in the dialog", async () => {
    await open();
    field(root(), "idea")!.value = "x";
    answers.push({ status: 403, error: "that is not one of your GitHub repositories" });
    const start = button(root(), "Start session")!;
    press(start);
    await flush();
    expect(bad(root())).toEqual(["that is not one of your GitHub repositories"]);
    expect(start.disabled).toBe(false);
  });
  it("sends one request for two clicks", async () => {
    await open();
    field(root(), "idea")!.value = "x";
    holdNext = true;
    const start = button(root(), "Start session");
    press(start);
    press(start);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
  it("still opens the new session when the dialog was closed while the request ran", async () => {
    await open();
    field(root(), "idea")!.value = "x";
    holdNext = true;
    press(button(root(), "Start session"));
    await flush();
    root().replaceChildren();
    (document as any).listeners.keydown.forEach((f: any) => f({ key: "Escape" }));
    await flush();
    hold!.release();
    await flush();
    expect((globalThis as any).location.hash).toBe("#/refinement/new1");
  });
  it("shows a hint and a link when there is no repository", async () => {
    repos = [];
    await open();
    expect(root().textContent).toContain("You need a GitHub repository first.");
    expect(walk(root()).some((e) => e.tag === "a" && e.attrs.href === "#/repos")).toBe(true);
    expect(field(root(), "idea")).toBeUndefined();
  });
});

describe("the session page", () => {
  it("shows the idea, state, drafts and log", async () => {
    sessions = [session()];
    await showPage();
    const text = main().textContent;
    expect(text).toContain("Line one\nLine two");
    expect(text).toContain("Exploring");
    expect(text).toContain("No story drafts yet.");
    expect(text).toContain("Ann started the session");
    expect(walk(main()).some((e) => e.tag === "a" && e.textContent === "← All sessions")).toBe(true);
  });
  it("follows the rules for the buttons", async () => {
    sessions = [session()];
    await showPage();
    expect(buttonsOf()).toEqual(["Rename", "Drop"]);
    sessions = [dropped()];
    await showPage();
    expect(buttonsOf()).toEqual(["Restore"]);
    sessions = [session({ mine: false, ownerName: "Ann" })];
    await showPage("s1", true);
    expect(buttonsOf()).toEqual(["Drop"]);
    sessions = [dropped({ mine: false, ownerName: "Ann" })];
    await showPage("s1", true);
    expect(buttonsOf()).toEqual([]);
  });
  it("shows a note when the repository is gone", async () => {
    sessions = [session({ repoAvailable: false })];
    await showPage();
    expect(main().textContent).toContain("not in My repositories any more");
  });
  it("renames", async () => {
    sessions = [session()];
    await showPage();
    press(button(main(), "Rename"));
    await flush();
    field(root(), "title")!.value = " New name ";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/refinement/s1", body: { title: "New name" } }]);
  });
  it("does not send a blank title and keeps the dialog on a conflict", async () => {
    sessions = [session()];
    await showPage();
    press(button(main(), "Rename"));
    await flush();
    field(root(), "title")!.value = "  ";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([]);
    field(root(), "title")!.value = "X";
    answers.push({ status: 409, error: "a dropped session cannot be renamed; restore it first" });
    const save = button(root(), "Save")!;
    press(save);
    await flush();
    expect(bad(root())).toEqual(["a dropped session cannot be renamed; restore it first"]);
    expect(save.disabled).toBe(false);
  });
  it("sends one request for two clicks on Save", async () => {
    sessions = [session()];
    await showPage();
    press(button(main(), "Rename"));
    await flush();
    field(root(), "title")!.value = "X";
    holdNext = true;
    const save = button(root(), "Save");
    press(save);
    press(save);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
  it("asks before it drops", async () => {
    sessions = [session()];
    await showPage();
    confirmAnswer = false;
    press(button(main(), "Drop"));
    await flush();
    expect(sent).toEqual([]);
    confirmAnswer = true;
    press(button(main(), "Drop"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/drop", body: {} }]);
  });
  it("shows an error toast, loads again and enables the button when a drop fails", async () => {
    sessions = [session()];
    await showPage();
    answers.push({ status: 409, error: "that session is dropped already" });
    gets = [];
    const drop = button(main(), "Drop")!;
    press(drop);
    await flush();
    expect(toastText()).toBe("that session is dropped already");
    expect(gets).toEqual(["/api/refinement/s1"]);
    expect(button(main(), "Drop")!.disabled).toBe(false);
  });
  it("sends one request for two clicks on Drop", async () => {
    sessions = [session()];
    await showPage();
    holdNext = true;
    const drop = button(main(), "Drop");
    press(drop);
    press(drop);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
  });
  it("restores, once for two clicks, and handles a missing session", async () => {
    sessions = [dropped()];
    await showPage();
    holdNext = true;
    const r = button(main(), "Restore");
    press(r);
    press(r);
    await flush();
    hold!.release();
    await flush();
    expect(sent).toHaveLength(1);
    await showPage();
    sessions = [];
    answers.push({ status: 404, error: "no such refinement session" });
    sessions = [dropped()];
    const again = button(main(), "Restore");
    sessions = [];
    press(again);
    await flush();
    expect(toastText()).toBe("no such refinement session");
    expect(main().textContent).toContain("← All sessions");
    expect(main().textContent).toContain("no such refinement session");
  });
  it("says it when the server cannot be reached", async () => {
    sessions = [session()];
    await showPage();
    answers.push("throw");
    press(button(main(), "Drop"));
    await flush();
    expect(toastText()).toBe("Could not reach the server.");
  });
  it("does not draw a load that finishes after the person left", async () => {
    sessions = [session()];
    (globalThis as any).location.hash = "#/refinement/s1";
    const pending = ui.renderRefinement(main(), { id: "s1" });
    (globalThis as any).location.hash = "#/runs";
    await pending;
    expect(main().textContent).not.toContain("Line one");
  });
  it("ignores a list request that fails after the person left", async () => {
    const before = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      await flush();
      throw new TypeError("fetch failed");
    };
    (globalThis as any).location.hash = "#/refinement";
    const pending = ui.renderRefinement(main(), {});
    (globalThis as any).location.hash = "#/runs";
    await expect(pending).resolves.toBeTypeOf("function");
    globalThis.fetch = before;
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");
  it("links the page", () => {
    expect(read("index.html")).toContain('href="#/refinement" data-nav="refinement">Refinement<');
    const app = read("app.js");
    expect(app).toContain('from "./refinement.js"');
    expect(app).toContain('section === "refinement"');
    expect(read("style.css")).toContain(':not([data-nav="refinement"])');
    expect(read("style.css")).toContain('.role-user .top nav a:not([data-nav="runs"]):not([data-nav="repos"])');
  });
  it("uses the right routes", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await api.refinement();
    await api.createRefinement({});
    await api.refinementSession("a b");
    await api.renameRefinement("x", { title: "t" });
    await api.dropRefinement("x");
    await api.restoreRefinement("x");
    expect(seen).toEqual([
      "GET /api/refinement",
      "POST /api/refinement",
      "GET /api/refinement/a%20b",
      "PUT /api/refinement/x",
      "POST /api/refinement/x/drop",
      "POST /api/refinement/x/restore",
    ]);
  });
});
