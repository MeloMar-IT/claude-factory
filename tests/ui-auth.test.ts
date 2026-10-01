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
    expect(sent().map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/session", "POST /api/session", "POST /api/setup"]);
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

  it("index.html has the place for the user name", () => {
    expect(readFileSync("ui/index.html", "utf8")).toContain('id="user"');
  });
});
