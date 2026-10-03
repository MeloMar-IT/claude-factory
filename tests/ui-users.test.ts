import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/users.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const TOKEN = "Ab3_".repeat(10) + "xyz"; // 43 characters
const ORIGIN = "https://foundry.example";
const LINK = `${ORIGIN}/#/set-password/${TOKEN}`;
const ADMIN_ONLY = "this is the only admin that is not blocked; make another admin first";

type Answer = { status: number; error: string; after?: boolean } | "throw";
let users: any[];
let gets: number;
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let holdNext: boolean;
let held: { release: () => void } | undefined;
let heldGets: (() => void)[][];
let clipboard: any;
let page: any;
const realFetch = globalThis.fetch;

const user = (over: object = {}) => ({
  id: "u1", name: "Ann", email: "ann@example.com", role: "user", status: "active", created: "2026-01-01T00:00:00.000Z",
  lastSignIn: new Date().toISOString(), runs: 2, hasPassword: true, ...over,
});

beforeEach(() => {
  users = [user({ id: "me", name: "Root", email: "root@example.com", role: "admin", runs: 0 }), user()];
  gets = 0;
  sent = [];
  answers = [];
  holdNext = false;
  held = undefined;
  heldGets = [];
  clipboard = { writeText: vi.fn(async () => {}) };
  page = { origin: () => ORIGIN, clipboard: () => clipboard, reload: vi.fn() };
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).getElementById("main").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets++;
      const snapshot = users.map((u) => ({ ...u }));
      const wait = heldGets.shift();
      if (wait) await new Promise<void>((r) => wait.push(r));
      return reply(snapshot);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    const answer = answers.shift();
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((r) => (held = { release: r }));
    }
    if (answer === "throw") throw new TypeError("fetch failed");
    const id = url.split("/")[3] ?? "";
    const target = users.find((u) => u.id === id);
    const apply = () => {
      if (init.method === "PUT" && target) Object.assign(target, body);
      if (url.endsWith("/block") && target) target.status = "blocked";
      if (url.endsWith("/unblock") && target) target.status = "active";
      if (init.method === "DELETE") users = users.filter((u) => u.id !== id);
    };
    if (answer) {
      if (answer.after) apply();
      return reply({ error: answer.error }, answer.status);
    }
    apply();
    if (init.method === "POST" && url === "/api/users") {
      const created = user({ id: "new1", ...body, hasPassword: false, lastSignIn: null, runs: 0 });
      users.push(created);
      return reply({ user: created, token: TOKEN, expires: "2026-12-01T00:00:00.000Z" }, 201);
    }
    if (url.endsWith("/link")) return reply({ user: target, token: TOKEN, expires: "x" });
    if (url.endsWith("/block")) return reply({ user: target, cancelled: { queued: 1, running: 1, waiting: 1 } });
    if (init.method === "DELETE") return reply({ ok: true, credentials: 0, cancelled: 1 });
    return reply({ user: target });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const errLine = (el: FakeElement) => walk(el).filter((e) => e.attrs.class === "status bad");
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const pressEscape = () => (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
const rows = () => main().all("tr").filter((r) => r.all("td").length);
const rowOf = (name: string) => rows().find((r) => r.all("td")[0]!.textContent.startsWith(name))!;
const show = async () => {
  await ui.renderUsers(main(), { me: "me", page });
};
const open = async (name: string, label: string) => {
  press(button(rowOf(name), label));
  await flush();
};

describe("pure functions", () => {
  it("statusText", () => {
    expect(ui.statusText(user())).toBe("active");
    expect(ui.statusText(user({ status: "blocked" }))).toBe("blocked");
    expect(ui.statusText(user({ hasPassword: false }))).toBe("no password yet");
    expect(ui.statusText(user({ hasPassword: false, status: "blocked" }))).toBe("blocked");
  });
  it("lastSignInText", () => {
    expect(ui.lastSignInText({ lastSignIn: null })).toBe("never");
    expect(ui.lastSignInText({ lastSignIn: new Date().toISOString() })).toBe("just now");
  });
  it("actionsFor", () => {
    expect(ui.actionsFor(user())).toEqual(["edit", "block", "delete"]);
    expect(ui.actionsFor(user({ status: "blocked" }))).toEqual(["edit", "unblock", "delete"]);
    expect(ui.actionsFor(user({ hasPassword: false }))).toEqual(["edit", "link", "block", "delete"]);
    expect(ui.actionsFor(user({ hasPassword: false, status: "blocked" }))).toEqual(["edit", "link", "unblock", "delete"]);
  });
  it("blockedLinkText", () => {
    expect(ui.blockedLinkText(user())).toBe("");
    expect(ui.blockedLinkText(user({ status: "blocked" }))).toContain("Ann is blocked");
    expect(ui.blockedLinkText(user({ status: "blocked" }))).toContain("only after you unblock");
  });
  it("passwordLink gives the token back", async () => {
    const { linkToken } = await import("../ui/auth.js" as string);
    expect(ui.passwordLink(ORIGIN, TOKEN)).toBe(LINK);
    expect(linkToken(new URL(LINK).hash)).toBe(TOKEN);
  });
  it("userProblem and newUserBody", () => {
    expect(ui.userProblem({ name: " ", email: "a@b.c" })).toBe("Fill in the name.");
    expect(ui.userProblem({ name: "A", email: "" })).toBe("Fill in the e-mail.");
    expect(ui.userProblem({ name: "A", email: "a@b.c" })).toBe("");
    expect(ui.newUserBody({ name: " A ", email: " a@b.c ", role: "admin" })).toEqual({ name: "A", email: "a@b.c", role: "admin" });
    expect(ui.newUserBody({ name: "A", email: "a@b.c", role: "root" }).role).toBe("user");
  });
  it("userChanges", () => {
    const u = user();
    expect(ui.userChanges(u, { name: "Bea", email: "ann@example.com", role: "user" })).toEqual({ name: "Bea" });
    expect(ui.userChanges(u, { name: "Ann", email: "ANN@example.com", role: "user" })).toEqual({});
    expect(ui.userChanges(u, { name: "Ann", email: "b@example.com", role: "admin" })).toEqual({ email: "b@example.com", role: "admin" });
  });
  it("cancelledText", () => {
    expect(ui.cancelledText("Ann", 0)).toBe("Ann is blocked. No runs were cancelled.");
    expect(ui.cancelledText("Ann", 1)).toBe("Ann is blocked. 1 run was cancelled.");
    expect(ui.cancelledText("Ann", 4)).toBe("Ann is blocked. 4 runs were cancelled.");
  });
  it("cancelledTotal adds what the server counted", () => {
    expect(ui.cancelledTotal({ queued: 1, running: 2, waiting: 3 })).toBe(6);
    expect(ui.cancelledTotal({ queued: 1 })).toBe(1);
    expect(ui.cancelledTotal(undefined)).toBe(0);
  });
  it("copyText", async () => {
    const fake = { writeText: vi.fn(async () => {}) };
    expect(await ui.copyText(fake, "x")).toBe(true);
    expect(fake.writeText).toHaveBeenCalledWith("x");
    expect(await ui.copyText(undefined, "x")).toBe(false);
    expect(await ui.copyText({ writeText: async () => { throw new Error("no"); } }, "x")).toBe(false);
  });
});

describe("the list", () => {
  it("shows the columns and one row per account", async () => {
    users.push(user({ id: "u2", name: "Bob", status: "blocked", lastSignIn: null }), user({ id: "u3", name: "Cy", hasPassword: false, lastSignIn: null }));
    await show();
    expect(main().all("th").map((t) => t.textContent)).toEqual(["Name", "E-mail", "Role", "Status", "Last sign-in", "Runs", ""]);
    const cells = (n: string) => rowOf(n).all("td").map((t) => t.textContent);
    expect(cells("Root").slice(0, 4)).toEqual(["Root (you)", "root@example.com", "admin", "active"]);
    expect(cells("Ann")).toEqual(["Ann", "ann@example.com", "user", "active", "just now", "2", "EditBlockDelete "].map((x, i) => (i === 6 ? cells("Ann")[6]! : x)));
    expect(cells("Bob")[3]).toBe("blocked");
    expect(cells("Bob")[4]).toBe("never");
    expect(cells("Cy")[3]).toBe("no password yet");
    const labels = (n: string) => rowOf(n).all("button").map((b) => b.textContent);
    expect(labels("Ann")).toEqual(["Edit", "Block", "Delete"]);
    expect(labels("Bob")).toEqual(["Edit", "Unblock", "Delete"]);
    expect(labels("Cy")).toEqual(["Edit", "New link", "Block", "Delete"]);
    expect(main().all("input")).toHaveLength(0);
  });
});

describe("Add user", () => {
  it("asks for a name first", async () => {
    await show();
    press(button(main(), "+ Add user"));
    press(button(root(), "Add user"));
    expect(errLine(root())[0]!.textContent).toBe("Fill in the name.");
    expect(sent).toEqual([]);
  });

  it("shows the link once, reloads on Done and leaves no token behind", async () => {
    await show();
    press(button(main(), "+ Add user"));
    field(root(), "name")!.value = " Dee ";
    field(root(), "email")!.value = "dee@example.com";
    field(root(), "role")!.value = "admin";
    press(button(root(), "Add user"));
    press(button(root(), "Add user"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users", body: { name: "Dee", email: "dee@example.com", role: "admin" } }]);
    const link = field(root(), "link")!;
    expect(link.value).toBe(LINK);
    expect(link.attrs.readonly).toBeDefined();
    for (const t of ["works once", "7 days", "Send it to the user yourself"]) expect(root().textContent).toContain(t);
    expect(gets).toBe(1);
    press(button(root(), "Copy"));
    await flush();
    expect(clipboard.writeText).toHaveBeenCalledWith(LINK);
    expect(root().textContent).toContain("Copied.");
    press(button(root(), "Done"));
    await flush();
    expect(gets).toBe(2);
    expect(rowOf("Dee").all("td")[3]!.textContent).toBe("no password yet");
    for (const t of [main().textContent, toastText(), root().textContent]) expect(t).not.toContain(TOKEN);
  });

  it("says so when it cannot copy", async () => {
    clipboard = undefined;
    await show();
    press(button(main(), "+ Add user"));
    field(root(), "name")!.value = "Dee";
    field(root(), "email")!.value = "dee@example.com";
    press(button(root(), "Add user"));
    await flush();
    press(button(root(), "Copy"));
    await flush();
    expect(root().textContent).toContain("Could not copy");
  });

  it("toasts when the dialog was closed before the link came", async () => {
    await show();
    press(button(main(), "+ Add user"));
    field(root(), "name")!.value = "Dee";
    field(root(), "email")!.value = "dee@example.com";
    holdNext = true;
    press(button(root(), "Add user"));
    await flush();
    pressEscape();
    held!.release();
    await flush();
    expect(toastText()).toContain("The link was not shown");
    expect(toastText()).not.toContain(TOKEN);
    expect(rowOf("Dee")).toBeDefined();
  });
});

describe("New link", () => {
  const noPassword = () => users.push(user({ id: "u2", name: "Cy", hasPassword: false }));
  it("shows a fresh link", async () => {
    noPassword();
    await show();
    await open("Cy", "New link");
    expect(root().textContent).toContain("earlier link stops working");
    expect(root().textContent).not.toContain("unblock");
    press(button(root(), "New link"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users/u2/link", body: {} }]);
    expect(field(root(), "link")!.value).toBe(LINK);
    expect(root().textContent).toContain("works once");
    expect(root().textContent).not.toContain("unblock");
  });
  it("tells that a blocked account needs an unblock first", async () => {
    users.push(user({ id: "u2", name: "Cy", hasPassword: false, status: "blocked" }));
    await show();
    await open("Cy", "New link");
    expect(root().textContent).toContain("only after you unblock");
    press(button(root(), "New link"));
    await flush();
    expect(root().textContent).toContain("only after you unblock");
    expect(sent).toHaveLength(1);
  });
  it("shows a refusal", async () => {
    noPassword();
    await show();
    await open("Cy", "New link");
    answers.push({ status: 409, error: "this account has a password already" });
    press(button(root(), "New link"));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe("this account has a password already");
  });
});

describe("Edit", () => {
  it("sends only what changed and shows it", async () => {
    await show();
    await open("Ann", "Edit");
    expect(field(root(), "name")!.value).toBe("Ann");
    expect(field(root(), "role")!.value).toBe("user");
    field(root(), "name")!.value = "Bea";
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: "/api/users/u1", body: { name: "Bea" } }]);
    expect(root().children).toHaveLength(0);
    expect(gets).toBe(2);
    expect(rowOf("Bea").all("td")[1]!.textContent).toBe("ann@example.com");
    expect(toastText()).toBe("Saved");
    expect(page.reload).not.toHaveBeenCalled();
  });
  it("sends nothing when nothing changed", async () => {
    await show();
    await open("Ann", "Edit");
    press(button(root(), "Save"));
    await flush();
    expect(sent).toEqual([]);
    expect(root().children).toHaveLength(0);
  });
  it("reloads the page after a change to your own account", async () => {
    await show();
    await open("Root", "Edit");
    field(root(), "name")!.value = "Boss";
    press(button(root(), "Save"));
    await flush();
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(gets).toBe(1);
  });
});

describe("Block and Unblock", () => {
  it("says what happens and sends the choice", async () => {
    for (const checked of [false, true]) {
      users = [user({ id: "me", name: "Root", role: "admin" }), user()];
      await show();
      await open("Ann", "Block");
      for (const t of ["signed out", "queued runs are cancelled", "Running runs finish", "Also stop all their work now"]) expect(root().textContent).toContain(t);
      expect(root().textContent).not.toContain("signed out at once");
      (field(root(), "stopWork") as any).checked = checked;
      press(button(root(), "Block"));
      await flush();
      expect(sent.at(-1)).toEqual({ method: "POST", url: "/api/users/u1/block", body: { stopWork: checked } });
      expect(root().children).toHaveLength(0);
      expect(main().textContent).toContain(ui.cancelledText("Ann", 3));
      expect(rowOf("Ann").all("td")[3]!.textContent).toBe("blocked");
      expect(button(rowOf("Ann"), "Unblock")).toBeDefined();
    }
  });
  it("signs you out when you block yourself", async () => {
    await show();
    await open("Root", "Block");
    expect(root().textContent).toContain("signed out at once");
    press(button(root(), "Block"));
    await flush();
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(gets).toBe(1);
    expect(main().textContent).not.toContain("cancelled");
  });
  it("keeps the dialog on a 500 after the change, and reads the list when it closes", async () => {
    await show();
    await open("Ann", "Block");
    const before = main().textContent;
    answers.push({ status: 500, error: "the account list is not working; see the server log", after: true });
    press(button(root(), "Block"));
    await flush();
    expect(errLine(root())[0]!.textContent).toContain("not working");
    expect(button(root(), "Block")!.disabled).toBe(false);
    expect(gets).toBe(1);
    expect(main().textContent).toBe(before);
    pressEscape();
    await flush();
    expect(gets).toBe(2);
    expect(rowOf("Ann").all("td")[3]!.textContent).toBe("blocked");
    expect(button(rowOf("Ann"), "Unblock")).toBeDefined();
    expect(main().textContent).not.toContain("cancelled");
  });
  it("unblocks", async () => {
    users[1]!.status = "blocked";
    await show();
    expect(button(rowOf("Ann"), "Block")).toBeUndefined();
    await open("Ann", "Unblock");
    expect(root().textContent).toContain("not restarted");
    press(button(root(), "Unblock"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/users/u1/unblock", body: {} }]);
    expect(rowOf("Ann").all("td")[3]!.textContent).toBe("active");
    expect(button(rowOf("Ann"), "Block")).toBeDefined();
    expect(button(rowOf("Ann"), "Unblock")).toBeUndefined();
    expect(toastText()).toBe("Ann is unblocked");
  });
});

describe("Delete", () => {
  it("names the account and asks first", async () => {
    await show();
    await open("Ann", "Delete");
    for (const t of ["Ann", "ann@example.com", "stored credentials", "wiped", "runs are kept"]) expect(root().textContent).toContain(t);
    pressEscape();
    await flush();
    expect(sent).toEqual([]);
  });
  it("deletes", async () => {
    await show();
    await open("Ann", "Delete");
    press(button(root(), "Delete"));
    await flush();
    expect(sent).toEqual([{ method: "DELETE", url: "/api/users/u1", body: undefined }]);
    expect(rows().map((r) => r.all("td")[0]!.textContent)).toEqual(["Root (you)"]);
    expect(toastText()).toBe("Ann was deleted");
  });
  it("reloads the page when you delete yourself", async () => {
    await show();
    await open("Root", "Delete");
    press(button(root(), "Delete"));
    await flush();
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(gets).toBe(1);
  });
  it("shows a 500 that came after the delete, and reloads on close", async () => {
    await show();
    await open("Ann", "Delete");
    answers.push({ status: 500, error: "the account was deleted, but an old key is left", after: true });
    press(button(root(), "Delete"));
    await flush();
    expect(errLine(root())[0]!.textContent).toContain("the account was deleted, but");
    pressEscape();
    await flush();
    expect(rows()).toHaveLength(1);
  });
});

describe("refusals", () => {
  const cases: [string, string, Answer, (name: string) => Promise<void>][] = [
    ["Add: e-mail taken", "Add user", { status: 409, error: "an account with that e-mail exists already" }, async () => {
      press(button(main(), "+ Add user"));
      field(root(), "name")!.value = "Dee";
      field(root(), "email")!.value = "ann@example.com";
    }],
    ["Add: bad e-mail", "Add user", { status: 400, error: "that is not a valid e-mail address" }, async () => {
      press(button(main(), "+ Add user"));
      field(root(), "name")!.value = "Dee";
      field(root(), "email")!.value = "nope";
    }],
    ["Edit: last admin", "Save", { status: 409, error: ADMIN_ONLY }, async () => {
      await open("Root", "Edit");
      field(root(), "role")!.value = "user";
    }],
    ["Block: last admin", "Block", { status: 409, error: ADMIN_ONLY }, () => open("Root", "Block")],
    ["Delete: last admin", "Delete", { status: 409, error: ADMIN_ONLY }, () => open("Root", "Delete")],
    ["Unblock: gone", "Unblock", { status: 404, error: "no such account" }, async () => {
      users[1]!.status = "blocked";
      await ui.renderUsers(main(), { me: "me", page });
      gets = 1;
      await open("Ann", "Unblock");
    }],
    ["Edit: network", "Save", "throw", async () => {
      await open("Ann", "Edit");
      field(root(), "name")!.value = "Bea";
    }],
  ];
  it.each(cases)("%s", async (_n, label, answer, setup) => {
    await show();
    await setup(label);
    const before = main().textContent;
    const g = gets;
    answers.push(answer);
    press(button(root(), label));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe(answer === "throw" ? "Could not reach the server." : answer.error);
    expect(button(root(), label)!.disabled).toBe(false);
    expect(gets).toBe(g);
    expect(main().textContent).toBe(before);
  });
});

describe("a dialog closed while the call runs", () => {
  it("reloads after a late success and toasts a late failure", async () => {
    await show();
    await open("Ann", "Block");
    holdNext = true;
    press(button(root(), "Block"));
    await flush();
    pressEscape();
    held!.release();
    await flush();
    expect(rowOf("Ann").all("td")[3]!.textContent).toBe("blocked");

    await open("Ann", "Unblock");
    answers.push({ status: 404, error: "no such account" });
    holdNext = true;
    press(button(root(), "Unblock"));
    await flush();
    pressEscape();
    held!.release();
    await flush();
    expect(toastText()).toBe("no such account");
  });
});

describe("late answers", () => {
  it("draws nothing when the page was left", async () => {
    (globalThis as any).location = { hash: "#/runs" };
    await show();
    expect(main().textContent).toBe("");
  });
  it("the cleanup drops a load that is on its way", async () => {
    const wait: (() => void)[] = [];
    heldGets.push(wait);
    const load = ui.renderUsers(main(), { me: "me", page });
    await flush();
    const stop = await ui.renderUsers(main(), { me: "me", page }); // a newer load that has finished
    stop();
    main().replaceChildren();
    wait.forEach((r) => r());
    await load;
    expect(main().textContent).toBe("");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");
  it("is wired into the page", () => {
    expect(read("index.html")).toContain('href="#/users" data-nav="users">Users<');
    expect(read("app.js")).toContain('from "./users.js"');
    expect(read("app.js")).toContain('section === "users"');
    expect(read("style.css")).toContain('.role-user .top nav a:not([data-nav="runs"]):not([data-nav="repos"])');
  });
  it("the api calls hit the right routes", async () => {
    await api.users();
    await api.addUser({ name: "A" });
    await api.saveUser("a b", { name: "B" });
    await api.blockUser("u1", true);
    await api.unblockUser("u1");
    await api.userLink("u1");
    await api.deleteUser("u1");
    expect(gets).toBe(1);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/users", "PUT /api/users/a%20b", "POST /api/users/u1/block", "POST /api/users/u1/unblock", "POST /api/users/u1/link", "DELETE /api/users/u1",
    ]);
    expect(sent[2]!.body).toEqual({ stopWork: true });
  });
});
