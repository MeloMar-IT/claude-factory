import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "../src/auth/audit.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/audit.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

type Answer = { status: number; error: string } | "throw";
let users: any[];
let entries: any[];
let more: boolean;
let gets: string[];
let answers: Answer[];
let heldGets: (() => void)[][];
const realFetch = globalThis.fetch;

const account = (id: string, name: string) => ({ type: "account", id, name });
const entry = (over: object = {}) => ({
  time: "2026-10-02T09:00:00.000Z", actor: account("u1", "Ann"), action: "sign-in", target: null, result: "ok", ...over,
});

beforeEach(() => {
  users = [
    { id: "u2", name: "Bob", email: "bob@example.com" },
    { id: "u1", name: "Ann", email: "ann@example.com" },
  ];
  entries = [entry(), entry({ action: "edit", target: { type: "text", text: "run-1" }, detail: "x -> y" })];
  more = false;
  gets = [];
  answers = [];
  heldGets = [];
  delete (globalThis as any).location;
  (document as any).getElementById("main").replaceChildren();
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string) => {
    gets.push(url);
    const wait = heldGets.shift();
    if (url === "/api/users") {
      if (wait) await new Promise<void>((r) => wait.push(r));
      return reply(users);
    }
    const answer = answers.shift();
    const action = new URL(url, "http://x").searchParams.get("action");
    const snapshot = entries.filter((e) => !action || e.action === action);
    if (wait) await new Promise<void>((r) => wait.push(r));
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer) return reply({ error: answer.error }, answer.status);
    return reply({ entries: snapshot, more });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (name: string) => walk(main()).find((e) => e.attrs.name === name)!;
const rows = () => main().all("tr").filter((r) => r.all("td").length);
const link = () => main().all("a").find((a) => a.textContent === "Export CSV");
const errors = () => walk(main()).filter((e) => e.attrs.class === "errors");
const show = async () => {
  const cleanup = ui.renderAudit(main());
  await flush();
  return cleanup;
};
const change = async (name: string, value: string) => {
  field(name).value = value;
  field(name).fire("change");
  await flush();
};
const enc = encodeURIComponent;

describe("pure functions", () => {
  it("ACTIONS matches the server", () => {
    expect([...ui.ACTIONS].sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(ui.ACTIONS).toEqual([...ui.ACTIONS].sort());
  });
  it("dayTime", () => {
    expect(ui.dayTime("2026-10-02")).toBe(new Date(2026, 9, 2).toISOString());
    expect(ui.dayTime("2026-10-02", true)).toBe(new Date(2026, 9, 2, 23, 59, 59, 999).toISOString());
    for (const bad of ["", undefined, "2026-10", "x"]) expect(ui.dayTime(bad)).toBe("");
  });
  it("dayTime refuses days that do not exist and keeps low and leap years", () => {
    for (const bad of ["2026-02-31", "2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "2026-01-00"]) expect(ui.dayTime(bad)).toBe("");
    expect(ui.dayTime("2028-02-29")).toBe(new Date(2028, 1, 29).toISOString());
    const low = new Date(2000, 0, 1);
    low.setFullYear(50, 5, 1);
    low.setHours(0, 0, 0, 0);
    expect(ui.dayTime("0050-06-01")).toBe(low.toISOString());
  });
  it("filterProblem", () => {
    expect(ui.filterProblem({ from: "", to: "" })).toBe("");
    expect(ui.filterProblem({ from: "2026-10-02", to: "" })).toBe("");
    expect(ui.filterProblem({ from: "", to: "2026-10-02" })).toBe("");
    expect(ui.filterProblem({ from: "2026-10-02", to: "2026-10-02" })).toBe("");
    expect(ui.filterProblem({ from: "2026-10-01", to: "2026-10-02" })).toBe("");
    expect(ui.filterProblem({ from: "2026-10-03", to: "2026-10-02" })).toBe("The From date is after the To date.");
  });
  it("auditFilters", () => {
    expect(ui.auditFilters({ user: "", action: "", from: "", to: "" })).toEqual({});
    expect(ui.auditFilters({ user: "u1", action: "edit", from: "2026-10-01", to: "2026-10-02" })).toEqual({
      user: "u1", action: "edit", from: ui.dayTime("2026-10-01"), to: ui.dayTime("2026-10-02", true),
    });
    expect(ui.auditFilters({ user: "", action: "edit", from: "", to: "" })).toEqual({ action: "edit" });
    expect(ui.auditFilters({ user: "", action: "", from: "2026-02-31", to: "" })).toEqual({});
  });
  it("userOptions", () => {
    expect(ui.userOptions(users)).toEqual([{ value: "u1", label: "Ann (ann@example.com)" }, { value: "u2", label: "Bob (bob@example.com)" }]);
  });
  it("actorText and targetText", () => {
    expect(ui.actorText({ type: "cli" })).toBe("command line");
    expect(ui.actorText({ type: "anonymous" })).toBe("not signed in");
    expect(ui.actorText(account("u1", "Ann"))).toBe("Ann");
    expect(ui.actorText(account("u9", "deleted user"))).toBe("deleted user");
    expect(ui.targetText(null)).toBe("");
    expect(ui.targetText(account("u1", "Ann"))).toBe("Ann");
    expect(ui.targetText({ type: "text", text: "run-1" })).toBe("run-1");
  });
  it("timeText and moreText", () => {
    expect(ui.timeText("2026-10-02T09:00:00.000Z")).toBe(new Date("2026-10-02T09:00:00.000Z").toLocaleString());
    expect(ui.moreText(500)).toContain("500");
    expect(ui.moreText(500)).toContain("There are more");
    expect(ui.moreText(500)).toContain("Export CSV");
  });
});

describe("the list", () => {
  it("shows the columns and the rows in the answer's order", async () => {
    entries = [
      entry({ target: { type: "text", text: "run-1" }, detail: "x -> y" }),
      entry({ actor: { type: "cli" }, action: "role" }),
      entry({ actor: { type: "anonymous" }, action: "sign-in", result: "failed" }),
      entry({ actor: account("u2", "Bob"), action: "block", target: account("u9", "deleted user") }),
    ];
    await show();
    expect(main().all("th").map((t) => t.textContent)).toEqual(["Time", "Who", "Action", "Target", "Result"]);
    const cells = rows().map((r) => r.all("td"));
    expect(cells.map((c) => c.map((t) => t.textContent))).toEqual([
      [ui.timeText("2026-10-02T09:00:00.000Z"), "Ann", "sign-in", "run-1x -> y", "ok"],
      [ui.timeText("2026-10-02T09:00:00.000Z"), "command line", "role", "—", "ok"],
      [ui.timeText("2026-10-02T09:00:00.000Z"), "not signed in", "sign-in", "—", "failed"],
      [ui.timeText("2026-10-02T09:00:00.000Z"), "Bob", "block", "deleted user", "ok"],
    ]);
    expect(cells[0]![0]!.attrs.title).toBe("2026-10-02T09:00:00.000Z");
    expect(cells[0]![1]!.attrs.title).toBe("u1");
    expect(cells[1]![1]!.attrs.title).toBeUndefined();
    expect(cells[3]![3]!.attrs.title).toBe("u9");
    expect(cells[0]![4]!.all("span")[0]!.attrs.class).toBe("pill ok");
    expect(cells[2]![4]!.all("span")[0]!.attrs.class).toBe("pill fail");
    expect(gets).toEqual(["/api/users", "/api/audit"]);
  });
});

describe("filters", () => {
  it("has the user and action choices", async () => {
    await show();
    expect(field("user").all("option").map((o) => o.textContent)).toEqual(["All users", "Ann (ann@example.com)", "Bob (bob@example.com)"]);
    expect(field("action").all("option")).toHaveLength(27);
    expect(field("action").all("option")[0]!.textContent).toBe("All actions");
  });
  it("reloads on every change without redrawing the bar", async () => {
    await show();
    const [user, action, from, to] = ["user", "action", "from", "to"].map(field);
    await change("user", "u1");
    await change("action", "sign-in");
    await change("from", "2026-10-01");
    await change("to", "2026-10-02");
    expect(gets).toHaveLength(6);
    expect(gets.filter((g) => g === "/api/users")).toHaveLength(1);
    expect(gets.at(-1)).toBe(`/api/audit?user=u1&action=sign-in&from=${enc(ui.dayTime("2026-10-01"))}&to=${enc(ui.dayTime("2026-10-02", true))}`);
    expect([field("user"), field("action"), field("from"), field("to")]).toEqual([user, action, from, to]);
    expect(rows()).toHaveLength(1);
  });
  it("drops the old rows while the new list loads", async () => {
    await show();
    expect(rows()).toHaveLength(2);
    heldGets.push([]);
    field("action").value = "sign-in";
    field("action").fire("change");
    await flush();
    expect(rows()).toHaveLength(0);
    expect(main().all("table")).toHaveLength(0);
    expect(walk(main()).some((e) => e.attrs.class === "spinner")).toBe(true);
  });
});

describe("export", () => {
  it("is a plain link that follows the filters", async () => {
    await show();
    expect(link()!.attrs.href).toBe("/api/audit/export");
    expect(link()!.attrs.download).toBe("audit.csv");
    expect(link()!.attrs.class).toBe("btn");
    await change("action", "edit");
    expect(link()!.attrs.href).toBe("/api/audit/export?action=edit");
    expect(gets.at(-1)).toBe("/api/audit?action=edit");
  });
});

describe("more, empty and errors", () => {
  it("says when there are more lines", async () => {
    more = true;
    await show();
    expect(main().textContent).toContain(ui.moreText(2));
  });
  it("does not say so otherwise", async () => {
    await show();
    expect(main().textContent).not.toContain("There are more");
  });
  it("says No entries and keeps the export", async () => {
    entries = [];
    await show();
    expect(main().textContent).toContain("No entries");
    expect(main().all("table")).toHaveLength(0);
    expect(link()).toBeDefined();
  });
  it("shows a server error, then recovers on a filter change", async () => {
    answers.push({ status: 500, error: "the audit log is not working; see the server log" });
    await show();
    expect(errors().map((e) => e.textContent)).toEqual(["the audit log is not working; see the server log"]);
    expect(main().all("table")).toHaveLength(0);
    expect(field("action")).toBeDefined();
    await change("action", "edit");
    expect(errors()).toHaveLength(0);
    expect(rows()).toHaveLength(1);
  });
  it("shows a network error", async () => {
    answers.push("throw");
    await show();
    expect(errors()[0]!.textContent).toBe("Could not reach the server.");
  });
  it("shows an error when the users cannot be read", async () => {
    const real = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init: unknown) =>
      url === "/api/users" ? { ok: false, status: 500, statusText: "x", json: async () => ({ error: "users broke" }) } : real(url, init);
    await show();
    expect(errors()[0]!.textContent).toBe("users broke");
    expect(field("action")).toBeDefined();
  });
});

describe("From after To", () => {
  it("sends nothing, shows the problem and no export, then recovers", async () => {
    await show();
    await change("to", "2026-10-01");
    const before = gets.length;
    await change("from", "2026-10-03");
    expect(gets).toHaveLength(before);
    expect(errors()[0]!.textContent).toBe("The From date is after the To date.");
    expect(link()).toBeUndefined();
    await change("from", "2026-10-01");
    expect(gets).toHaveLength(before + 1);
    expect(errors()).toHaveLength(0);
    expect(link()).toBeDefined();
  });
});

describe("late answers and cleanup", () => {
  it("draws the page at once and returns the cleanup at once", () => {
    heldGets.push([]);
    const cleanup = ui.renderAudit(main());
    expect(typeof cleanup).toBe("function");
    expect(field("action")).toBeDefined();
  });
  it("keeps the users when a filter changes before the users answer", async () => {
    const wait: (() => void)[] = [];
    heldGets.push(wait);
    ui.renderAudit(main());
    await flush();
    await change("action", "edit");
    wait.forEach((r) => r());
    await flush();
    expect(field("user").all("option")).toHaveLength(3);
    expect(rows().map((r) => r.all("td")[2]!.textContent)).toEqual(["edit"]);
  });
  it("draws nothing for the data when the page is not Audit", async () => {
    (globalThis as any).location = { hash: "#/runs" };
    await show();
    expect(rows()).toHaveLength(0);
    expect(gets).toEqual(["/api/users"]);
  });
  it("a cleanup called during the first request keeps the old render from drawing", async () => {
    const wait: (() => void)[] = [];
    heldGets.push(wait);
    const old = ui.renderAudit(main());
    await flush();
    old();
    const cleanup = ui.renderAudit(main());
    await flush();
    expect(rows()).toHaveLength(2);
    expect(typeof cleanup).toBe("function");
    wait.forEach((r) => r());
    await flush();
    expect(gets.filter((g) => g.startsWith("/api/audit"))).toHaveLength(1);
    expect(rows()).toHaveLength(2);
  });
  it("an older filter answer does not replace a newer one", async () => {
    await show();
    const wait: (() => void)[] = [];
    heldGets.push(wait);
    field("action").value = "edit";
    field("action").fire("change");
    await flush();
    await change("action", "sign-in");
    wait.forEach((r) => r());
    await flush();
    expect(rows().map((r) => r.all("td")[2]!.textContent)).toEqual(["sign-in"]);
  });
  it("leaving the page while a filter load is held changes nothing", async () => {
    await show();
    const wait: (() => void)[] = [];
    heldGets.push(wait);
    field("action").value = "edit";
    field("action").fire("change");
    await flush();
    (globalThis as any).location = { hash: "#/runs" };
    (document as any).getElementById("main").replaceChildren("other text");
    wait.forEach((r) => r());
    await flush();
    expect(main().textContent).toBe("other text");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");
  it("has the link, the route and the role rule", () => {
    expect(read("index.html")).toContain('<a href="#/audit" data-nav="audit">Audit</a>');
    expect(read("app.js")).toContain('from "./audit.js"');
    expect(read("app.js")).toContain('section === "audit"');
    expect(read("style.css")).toContain('.role-user .top nav a:not([data-nav="runs"]):not([data-nav="repos"]):not([data-nav="refinement"])');
  });
  it("api builds the queries", async () => {
    await api.audit({ user: "a b", action: "sign-in" });
    expect(gets.at(-1)).toBe("/api/audit?user=a%20b&action=sign-in");
    await api.audit();
    expect(gets.at(-1)).toBe("/api/audit");
    expect(api.auditExportUrl({ from: "2026-10-02T00:00:00.000Z" })).toBe("/api/audit/export?from=2026-10-02T00%3A00%3A00.000Z");
  });
});
