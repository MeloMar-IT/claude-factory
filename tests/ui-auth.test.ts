import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let apiMod: any;
let auth: any;

beforeAll(async () => {
  restore = installFakeDom();
  apiMod = await import("../ui/api.js" as string);
  auth = await import("../ui/auth.js" as string);
});

let reload: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url: url as string, method: init.method as string, headers: init.headers as Record<string, string> }));

beforeEach(() => {
  reload = vi.fn();
  vi.stubGlobal("location", { reload });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  apiMod.setCsrf("");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => restore());

const reply = (status: number, body: unknown) =>
  fetchMock.mockImplementation(async () => ({ ok: status < 400, status, statusText: "x", json: async () => body }));

describe("req() in ui/api.js", () => {
  it("sends the CSRF token on calls that are not a GET, and only then", async () => {
    apiMod.setCsrf("tok");
    await apiMod.api.info();
    await apiMod.api.saveConfig({});
    await apiMod.api.signOut();
    const [get, put, del] = sent();
    expect(get!.headers["x-csrf-token"]).toBeUndefined();
    expect(put).toMatchObject({ method: "PUT", headers: { "x-csrf-token": "tok" } });
    expect(del).toMatchObject({ method: "DELETE", url: "/api/session", headers: { "x-csrf-token": "tok" } });
  });

  it("sends no token before one is set", async () => {
    await apiMod.api.saveConfig({});
    expect(sent()[0]!.headers["x-csrf-token"]).toBeUndefined();
  });

  it("reloads the page on a 401, but not for /api/session", async () => {
    reply(401, { error: "sign in first" });
    await expect(apiMod.api.info()).rejects.toThrow("sign in first");
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();
    reply(401, { error: "wrong e-mail or password" });
    await expect(apiMod.api.signIn("a@example.com", "x")).rejects.toThrow("wrong e-mail or password");
    await expect(apiMod.api.session()).rejects.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it("has the sign-in calls", async () => {
    await apiMod.api.session();
    await apiMod.api.signIn("a@example.com", "pw");
    await apiMod.api.setup("Ann", "a@example.com", "pw");
    await apiMod.api.setPassword("tok", "pw");
    expect(sent().map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/session", "POST /api/session", "POST /api/setup", "POST /api/set-password"]);
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toEqual({ token: "tok", password: "pw" });
  });
});

const NEW_ADMIN = { name: " Ann ", email: " ann@example.com ", password: "long-enough-password", repeat: "long-enough-password" };

describe("the sign-in decisions", () => {
  it("picks the form", () => {
    expect(auth.formKind({ user: { name: "Ann" }, setupNeeded: false })).toBeNull();
    expect(auth.formKind({ user: null, setupNeeded: true })).toBe("setup");
    expect(auth.formKind({ user: null, setupNeeded: false })).toBe("signin");
  });

  it("names what is wrong with the input", () => {
    expect(auth.formProblem("signin", { email: "", password: "x" })).toBe("Fill in your e-mail and password.");
    expect(auth.formProblem("signin", { email: "a@example.com", password: "" })).toBe("Fill in your e-mail and password.");
    expect(auth.formProblem("signin", { email: "a@example.com", password: "x" })).toBe("");
    expect(auth.formProblem("setup", { ...NEW_ADMIN, name: " " })).toBe("Fill in your name and e-mail.");
    expect(auth.formProblem("setup", { ...NEW_ADMIN, password: "short", repeat: "short" })).toBe("The password must be at least 10 characters.");
    expect(auth.formProblem("setup", { ...NEW_ADMIN, repeat: "other-password-1" })).toBe("The two passwords are not the same.");
    expect(auth.formProblem("setup", NEW_ADMIN)).toBe("");
  });

  it("turns errors into text", () => {
    expect(auth.errorText(new TypeError("Failed to fetch"))).toBe("Could not reach the server.");
    expect(auth.errorText(new Error("wrong e-mail or password"))).toBe("wrong e-mail or password");
  });

  const fakeApi = (over: Record<string, unknown> = {}) => ({
    session: vi.fn(),
    signIn: vi.fn(async () => ({})),
    signOut: vi.fn(async () => ({})),
    setup: vi.fn(async () => ({})),
    setPassword: vi.fn(async () => ({})),
    ...over,
  });

  it("calls no API method while the input has a problem", async () => {
    const a = fakeApi();
    expect(await auth.submitForm(a, "setup", { ...NEW_ADMIN, repeat: "different-password" })).toBe("The two passwords are not the same.");
    expect(await auth.submitForm(a, "setup", { ...NEW_ADMIN, password: "short", repeat: "short" })).toContain("at least 10");
    expect(await auth.submitForm(a, "signin", { email: "", password: "" })).toContain("Fill in");
    expect(a.setup).not.toHaveBeenCalled();
    expect(a.signIn).not.toHaveBeenCalled();
  });

  it("sends the form once", async () => {
    const a = fakeApi();
    expect(await auth.submitForm(a, "setup", NEW_ADMIN)).toBe("");
    expect(a.setup).toHaveBeenCalledExactlyOnceWith("Ann", "ann@example.com", "long-enough-password");
    expect(await auth.submitForm(a, "signin", { email: "ann@example.com ", password: "pw" })).toBe("");
    expect(a.signIn).toHaveBeenCalledExactlyOnceWith("ann@example.com", "pw");
  });

  it("reads a set-password link", () => {
    expect(auth.linkToken("#/set-password/abc-_1")).toBe("abc-_1");
    for (const hash of ["#/set-password/", "#/set-password/a/b", "#/runs", "", undefined, "#/set-password/a%20b", "#/set-password/a b", "#/set-password/a%"]) {
      expect(auth.linkToken(hash), String(hash)).toBeNull();
    }
    expect(auth.linkToken(auth.linkHash("tok-en_9"))).toBe("tok-en_9");
  });

  it("shows the password form for a link, with or without a session", () => {
    expect(auth.formKind({ user: { name: "Ann" } }, "#/set-password/x")).toBe("password");
    expect(auth.formKind({ user: null, setupNeeded: false }, "#/runs")).toBe("signin");
    expect(auth.formKind({ user: { name: "Ann" } })).toBeNull();
  });

  it("checks the new password", () => {
    expect(auth.formProblem("password", { password: "short", repeat: "short" })).toBe("The password must be at least 10 characters.");
    expect(auth.formProblem("password", { password: "long-enough-password", repeat: "other-password-1" })).toBe("The two passwords are not the same.");
    expect(auth.formProblem("password", { password: "long-enough-password", repeat: "long-enough-password" })).toBe("");
  });

  it("sends the set-password form once, and only without a problem", async () => {
    const a = fakeApi();
    const v = { token: "tok", password: "long-enough-password", repeat: "long-enough-password" };
    expect(await auth.submitForm(a, "password", { ...v, repeat: "x" })).toBe("The two passwords are not the same.");
    expect(a.setPassword).not.toHaveBeenCalled();
    expect(await auth.submitForm(a, "password", v)).toBe("");
    expect(a.setPassword).toHaveBeenCalledExactlyOnceWith("tok", "long-enough-password");
    const failing = fakeApi({ setPassword: async () => { throw new Error("this link is not valid any more; ask your admin for a new one"); } });
    expect(await auth.submitForm(failing, "password", v)).toBe("this link is not valid any more; ask your admin for a new one");
  });

  it("returns the text of a failed call", async () => {
    expect(await auth.submitForm(fakeApi({ signIn: async () => { throw new Error("wrong e-mail or password"); } }), "signin", { email: "a@example.com", password: "x" })).toBe("wrong e-mail or password");
    expect(await auth.submitForm(fakeApi({ signIn: async () => { throw new TypeError("fetch failed"); } }), "signin", { email: "a@example.com", password: "x" })).toBe("Could not reach the server.");
  });

  it("signOut reloads on success only", async () => {
    expect(await auth.signOut(fakeApi(), reload)).toBe("");
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();
    expect(await auth.signOut(fakeApi({ signOut: async () => { throw new Error("bad CSRF token"); } }), reload)).toBe("bad CSRF token");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("ensureSignedIn on the fake DOM", () => {
  const el = (id: string) => document.getElementById(id) as unknown as FakeElement;
  const withClass = (root: FakeElement, tag: string, cls: string) => root.all(tag).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
  const form = () => el("main").children.find((c): c is FakeElement => c instanceof FakeElement && c.tag === "form")!;
  const inputs = () => form().all("input");
  const fill = (values: string[]) => inputs().forEach((i, n) => (i.value = values[n]!));
  const submit = () => {
    const preventDefault = vi.fn();
    form().fire("submit", { preventDefault });
    return preventDefault;
  };
  const fakeApi = (session: unknown, over: Record<string, unknown> = {}) => ({
    session: vi.fn(async () => session),
    signIn: vi.fn(async () => ({})),
    signOut: vi.fn(async () => ({})),
    setup: vi.fn(async () => ({})),
    setPassword: vi.fn(async () => ({})),
    ...over,
  });
  const neverResolves = async (p: Promise<unknown>) => {
    let done = false;
    void p.then(() => (done = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
  };

  beforeEach(() => {
    restore();
    restore = installFakeDom();
  });

  const SESSION = { user: { id: "u1", name: "Ann", email: "ann@example.com", role: "admin" }, csrfToken: "csrf-1", setupNeeded: false };

  it("signed in: shows the name and a sign-out button, and sets the CSRF token", async () => {
    const a = fakeApi(SESSION);
    expect(await auth.ensureSignedIn(a, reload)).toEqual(SESSION.user);
    expect(el("user").hidden).toBe(false);
    expect(el("user").textContent).toContain("Ann");
    const buttons = el("user").all("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Sign out"]);
    expect((document.body as unknown as FakeElement).classList.contains("signed-out")).toBe(false);
    await apiMod.api.saveConfig({});
    expect(sent()[0]!.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("the sign-out button signs out and reloads", async () => {
    const a = fakeApi(SESSION);
    await auth.ensureSignedIn(a, reload);
    el("user").all("button")[0]!.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(a.signOut).toHaveBeenCalledTimes(1);
  });

  it("a failed sign-out shows the text and does not reload", async () => {
    const a = fakeApi(SESSION, { signOut: vi.fn(async () => { throw new Error("bad CSRF token"); }) });
    await auth.ensureSignedIn(a, reload);
    el("user").all("button")[0]!.click();
    await vi.waitFor(() => expect(el("toast").textContent).toBe("bad CSRF token"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("signed out: shows the sign-in form and waits", async () => {
    const a = fakeApi({ user: null, setupNeeded: false });
    const p = auth.ensureSignedIn(a, reload);
    await vi.waitFor(() => expect(form()).toBeDefined());
    expect((document.body as unknown as FakeElement).classList.contains("signed-out")).toBe(true);
    expect(form().all("h2")[0]!.textContent).toBe("Sign in");
    expect(inputs().map((i) => i.attrs.autocomplete)).toEqual(["username", "current-password"]);
    await neverResolves(p);

    fill(["ann@example.com", "pw"]);
    const preventDefault = submit();
    expect(preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(a.signIn).toHaveBeenCalledExactlyOnceWith("ann@example.com", "pw");
  });

  it("a failed sign-in shows the message and enables the button again", async () => {
    const a = fakeApi({ user: null, setupNeeded: false }, { signIn: vi.fn(async () => { throw new Error("wrong e-mail or password"); }) });
    void auth.ensureSignedIn(a, reload);
    await vi.waitFor(() => expect(form()).toBeDefined());
    fill(["ann@example.com", "bad"]);
    const button = form().all("button")[0]!;
    submit();
    expect(button.disabled).toBe(true);
    const line = () => withClass(form(), "p", "bad")[0]!;
    await vi.waitFor(() => expect(line().textContent).toBe("wrong e-mail or password"));
    expect(button.disabled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("setup: asks for the admin account and checks the passwords first", async () => {
    const a = fakeApi({ user: null, setupNeeded: true });
    void auth.ensureSignedIn(a, reload);
    await vi.waitFor(() => expect(form()).toBeDefined());
    expect(form().all("h2")[0]!.textContent).toBe("Create the admin account");
    expect(inputs()).toHaveLength(4);
    expect(inputs().map((i) => i.attrs.autocomplete)).toEqual(["name", "username", "new-password", "new-password"]);

    fill(["Ann", "ann@example.com", "long-enough-password", "another-password-1"]);
    submit();
    await vi.waitFor(() => expect(withClass(form(), "p", "bad")[0]!.textContent).toBe("The two passwords are not the same."));
    expect(a.setup).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();

    fill(["Ann", "ann@example.com", "long-enough-password", "long-enough-password"]);
    submit();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(a.setup).toHaveBeenCalledExactlyOnceWith("Ann", "ann@example.com", "long-enough-password");
  });

  describe("a set-password link", () => {
    const GOOD = "long-enough-password";
    const fakePage = (hash: string) => {
      const page = { current: hash, watcher: undefined as undefined | (() => void), onCalls: 0 } as { current: string; watcher?: () => void; onCalls: number };
      return Object.assign(page, {
        hash: () => page.current,
        clearHash: vi.fn(() => void (page.current = "")),
        onHashChange: vi.fn((fn: () => void) => {
          page.onCalls++;
          page.watcher = fn;
        }),
      });
    };
    const open = async (over: Record<string, unknown> = {}, hash = "#/set-password/tok-1") => {
      const a = fakeApi({ user: null, setupNeeded: false }, over);
      const page = fakePage(hash);
      const p = auth.ensureSignedIn(a, reload, page);
      await vi.waitFor(() => expect(form()).toBeDefined());
      return { a, page, p };
    };
    const line = () => withClass(form(), "p", "bad")[0]!;

    it("shows the form without asking for a session, and waits", async () => {
      const { a, p } = await open();
      expect(a.session).not.toHaveBeenCalled();
      expect((document.body as unknown as FakeElement).classList.contains("signed-out")).toBe(true);
      expect(form().all("h2")[0]!.textContent).toBe("Choose your password");
      expect(inputs().map((i) => i.attrs.autocomplete)).toEqual(["new-password", "new-password"]);
      await neverResolves(p);
    });

    it("does not send two different passwords", async () => {
      const { a } = await open();
      fill([GOOD, "another-password-1"]);
      submit();
      await vi.waitFor(() => expect(line().textContent).toBe("The two passwords are not the same."));
      expect(a.setPassword).not.toHaveBeenCalled();
    });

    it("on success cleans the address bar and shows the sign-in form with a note, without a reload", async () => {
      const { a, page } = await open();
      fill([GOOD, GOOD]);
      submit();
      await vi.waitFor(() => expect(form().all("h2")[0]!.textContent).toBe("Sign in"));
      expect(a.setPassword).toHaveBeenCalledExactlyOnceWith("tok-1", GOOD);
      expect(page.clearHash).toHaveBeenCalledTimes(1);
      expect(form().all("p").some((p) => p.textContent.includes("Your password is set"))).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      fill(["ann@example.com", GOOD]);
      submit();
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(a.signIn).toHaveBeenCalledExactlyOnceWith("ann@example.com", GOOD);
    });

    it("on a failed call shows the text, enables the button and keeps the address", async () => {
      const { page } = await open({ setPassword: vi.fn(async () => { throw new Error("this link is not valid any more; ask your admin for a new one"); }) });
      fill([GOOD, GOOD]);
      const button = form().all("button")[0]!;
      submit();
      expect(button.disabled).toBe(true);
      await vi.waitFor(() => expect(line().textContent).toContain("not valid any more"));
      expect(button.disabled).toBe(false);
      expect(page.clearHash).not.toHaveBeenCalled();
    });

    it("the link form reloads on any hash change, until the password is set", async () => {
      const { page } = await open();
      expect(page.onCalls).toBe(1);
      for (const hash of ["#/runs", "", "#/set-password/other"]) {
        reload.mockClear();
        page.current = hash;
        page.watcher!();
        expect(reload, hash).toHaveBeenCalledTimes(1);
      }
      fill([GOOD, GOOD]);
      submit();
      await vi.waitFor(() => expect(form().all("h2")[0]!.textContent).toBe("Sign in"));
      expect(page.onCalls).toBe(1);
      reload.mockClear();
      page.current = "#/runs";
      page.watcher!();
      expect(reload).not.toHaveBeenCalled();
      expect(form().all("p").some((p) => p.textContent.includes("Your password is set"))).toBe(true);
      page.current = "#/set-password/other";
      page.watcher!();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("the sign-in form reloads only when the hash is a link", async () => {
      const a = fakeApi({ user: null, setupNeeded: false });
      const page = fakePage("");
      void auth.ensureSignedIn(a, reload, page);
      await vi.waitFor(() => expect(form()).toBeDefined());
      page.current = "#/runs";
      page.watcher!();
      expect(reload).not.toHaveBeenCalled();
      page.current = "#/set-password/tok-2";
      page.watcher!();
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });

  it("shows an error block when the session cannot be read", async () => {
    const a = fakeApi(null, { session: vi.fn(async () => { throw new Error("sign-in is not working; see the server log"); }) });
    const p = auth.ensureSignedIn(a, reload);
    await vi.waitFor(() => expect(withClass(el("main"), "div", "errors")).toHaveLength(1));
    expect(withClass(el("main"), "div", "errors")[0]!.textContent).toBe("sign-in is not working; see the server log");
    await neverResolves(p);
  });
});

describe("the page", () => {
  it("app.js signs in before it reads the info", () => {
    const app = readFileSync("ui/app.js", "utf8");
    const at = app.indexOf("await ensureSignedIn();");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(app.indexOf("S.info = await api.info();"));
  });

  it("app.js loads the page again for a set-password link before it picks a page", () => {
    const app = readFileSync("ui/app.js", "utf8");
    const route = app.slice(app.indexOf("async function route()"));
    const at = route.indexOf("if (linkToken(location.hash)) return location.reload();");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(route.indexOf("allowedHash("));
  });

  it("index.html has the place for the user name", () => {
    expect(readFileSync("ui/index.html", "utf8")).toContain('id="user"');
  });

  it("app.js starts the admin parts only inside startAdmin, and style.css hides the rest for a user", () => {
    const app = readFileSync("ui/app.js", "utf8");
    const start = app.indexOf("async function startAdmin()");
    expect(start).toBeGreaterThan(0);
    for (const text of ["startHealth(healthEl)", "S.info = await api.info();", "startBadge()", "startSince("]) {
      expect(app.split(text).length - 1, text).toBe(1);
      expect(app.indexOf(text), text).toBeGreaterThan(start);
    }
    expect(readFileSync("ui/style.css", "utf8")).toContain(".role-user");
  });
});

describe("roles in the page", () => {
  beforeEach(() => {
    restore();
    restore = installFakeDom();
  });
  const bodyHas = () => (document.body as unknown as FakeElement).classList.contains("role-user");

  it("isAdmin is true for the role admin only", () => {
    expect(auth.isAdmin({ role: "admin" })).toBe(true);
    expect(auth.isAdmin({ role: "user" })).toBe(false);
    expect(auth.isAdmin(undefined)).toBe(false);
  });

  it("userHash keeps the Runs pages and My repositories and sends everything else to the list", () => {
    expect(auth.userHash("#/repos")).toBe("#/repos");
    expect(auth.userHash("#/repos/x")).toBe("#/runs");
    expect(auth.userHash("#/reposx")).toBe("#/runs");
    expect(auth.userHash("#/runs")).toBe("#/runs");
    expect(auth.userHash("#/runs/abc")).toBe("#/runs/abc");
    expect(auth.userHash("#/runs/abc/x")).toBe("#/runs");
    expect(auth.userHash("#/settings")).toBe("#/runs");
    expect(auth.userHash("")).toBe("#/runs");
  });

  it("allowedHash replaces a page a user may not open, and leaves the rest", () => {
    const replace = vi.fn();
    expect(auth.allowedHash(false, "#/settings", replace)).toBe("#/runs");
    expect(replace).toHaveBeenCalledWith("#/runs");
    replace.mockClear();
    expect(auth.allowedHash(false, "#/runs/abc", replace)).toBe("#/runs/abc");
    expect(auth.allowedHash(true, "#/settings", replace)).toBe("#/settings");
    expect(auth.allowedHash(false, "#/repos", replace)).toBe("#/repos");
    expect(replace).not.toHaveBeenCalled();
  });

  it("startApp gives a user only the route, and an admin the whole start-up", async () => {
    const user = { startAdmin: vi.fn(), route: vi.fn() };
    await auth.startApp({ role: "user" }, user);
    expect(user.startAdmin).not.toHaveBeenCalled();
    expect(user.route).toHaveBeenCalledTimes(1);
    expect(bodyHas()).toBe(true);
    restore();
    restore = installFakeDom();
    const admin = { startAdmin: vi.fn(), route: vi.fn() };
    await auth.startApp({ role: "admin" }, admin);
    expect(admin.startAdmin).toHaveBeenCalledTimes(1);
    expect(admin.route).not.toHaveBeenCalled();
    expect(bodyHas()).toBe(false);
  });
});
