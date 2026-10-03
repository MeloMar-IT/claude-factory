import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/repos.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const KEY_METHOD = { id: "test-key", label: "Test key", help: ["One.", "Two."], fields: [{ key: "key", label: "Private key", secret: true, multiline: true }] };

type Answer = { status: number; error: string } | "throw";
let repos: any[];
let gets: number;
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let testResult: any;
/** A saved connection status; a failed one has a read check that failed and a skipped write check. */
const connection = (ok: boolean, over: object = {}) => ({
  at: new Date().toISOString(),
  ok,
  checks: ok
    ? [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }, { check: "push", ok: true, code: "ok", message: "Write access works. Nothing was pushed." }]
    : [{ check: "clone", ok: false, code: "bad-token", message: "The host did not accept the token." }, { check: "push", ok: false, skipped: true, code: "skipped", message: "Not checked." }],
  ...over,
});
let hold: { release: (a?: Answer) => void } | undefined;
let holdNext: boolean;
let heldGets: (() => void)[][]; // each entry holds one upcoming GET; the test fills it, then calls its functions to release
const realFetch = globalThis.fetch;
const realConfirm = (globalThis as any).confirm;
let nextId = 1;
let keyCount = 0;
/** A public key as the server shows it (built here, never a real one). */
const nextKey = () => `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${String(++keyCount).padStart(43, "k")}`;

beforeEach(() => {
  repos = [];
  gets = 0;
  sent = [];
  answers = [];
  testResult = connection(true);
  hold = undefined;
  holdNext = false;
  heldGets = [];
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  // dialogs a test left open must not react to the next test's Escape
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets++;
      const snapshot = [...repos];
      const wait = heldGets.shift();
      if (wait) await new Promise<void>((r) => wait.push(r));
      return reply(snapshot);
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method: init.method, url, body });
    let answer = answers.shift();
    if (holdNext) {
      holdNext = false;
      answer = await new Promise<Answer | undefined>((r) => (hold = { release: r }));
    }
    if (answer === "throw") throw new TypeError("fetch failed");
    if (answer) {
      // a failed removal that still dropped the record, as the server does when only the cleanup failed
      if (init.method === "DELETE" && answer.status === 500) repos = repos.filter((r) => `/api/repos/${r.id}` !== url);
      return reply({ error: answer.error }, answer.status);
    }
    if (init.method === "POST" && url.endsWith("/test")) return reply(testResult);
    if (init.method === "POST") {
      const rec = {
        id: `id${nextId++}`,
        url: body.url,
        method: body.method,
        ...(body.username ? { username: body.username } : {}),
        ...(body.method === "ssh-deploy-key" ? { publicKey: nextKey() } : {}),
      };
      repos.push(rec);
      return reply(rec, 201);
    }
    if (init.method === "PUT" && (body.newKey || body.method === "ssh-deploy-key")) {
      const at = repos.findIndex((r) => `/api/repos/${r.id}/auth` === url);
      repos[at] = { ...repos[at], ...(body.url ? { url: body.url } : {}), method: "ssh-deploy-key", publicKey: nextKey() };
      return reply(repos[at]);
    }
    if (init.method === "DELETE") repos = repos.filter((r) => `/api/repos/${r.id}` !== url);
    return reply({});
  };
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
const byClass = (el: FakeElement, cls: string) => walk(el).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const errLine = (el: FakeElement) => byClass(el, "status").filter((e) => e.attrs.class === "status bad");
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const pressEscape = () => (document as any).listeners.keydown.forEach((fn: any) => fn({ key: "Escape" }));
const rec = (over: object = {}) => ({ id: `r${nextId++}`, url: "https://github.com/o/a", method: "github-token", ...over });
const show = async (admin = false) => {
  await ui.renderRepos(main(), { admin });
};
const type = (name: string, value: string) => {
  field(root(), name)!.value = value;
};
const choose = (id: string) => {
  const s = field(root(), "method")!;
  s.value = id;
  s.fire("change");
};

describe("pure functions", () => {
  it("lists the methods", () => {
    expect(ui.METHODS.map((m: any) => m.id)).toEqual(["github-token", "https-token", "ssh-deploy-key", "none"]);
    for (const m of ui.METHODS) {
      expect(m.label).toBeTruthy();
      expect(Array.isArray(m.help)).toBe(true);
      expect(Array.isArray(m.fields)).toBe(true);
    }
    expect(ui.methodsFor(false).map((m: any) => m.id)).not.toContain("none");
    expect(ui.methodsFor(true)).toHaveLength(4);
    const help = ui.METHODS[0].help.join(" ");
    for (const w of ["Contents", "Issues", "Pull requests", '"Read and write"']) expect(help).toContain(w);
    expect(ui.METHODS.find((m: any) => m.id === "none").help.join(" ")).not.toContain("GitHub");
    const deploy = ui.METHODS.find((m: any) => m.id === "ssh-deploy-key");
    expect(deploy.help.join(" ")).toContain("deploy key with write access");
    expect(deploy.fields).toEqual([]);
  });

  it("methodLabel and connectionStatus", () => {
    expect(ui.methodLabel({ method: "github-token" }, false)).toBe(ui.METHODS[0].label);
    const https = ui.methodLabel({ method: "https-token", username: "ann" }, false);
    expect(https).toContain("HTTPS user name + token");
    expect(https).toContain("ann");
    expect(ui.methodLabel({ method: "none" }, false)).toBe("Needs authentication");
    expect(ui.methodLabel({ method: "none" }, true)).toBe("The server's own access");
    expect(ui.methodLabel({ method: "ssh-key" }, false)).toBe("ssh-key");
    expect(ui.connectionStatus({})).toBe("Not tested yet");
    expect(ui.connectionStatus({ connection: connection(true) })).toBe("Connected");
    expect(ui.connectionStatus({ connection: connection(false) })).toBe("Failed");
  });

  it("connectionLines: a failed test shows every check, a good one only the skipped ones", () => {
    expect(ui.connectionLines({})).toEqual([]);
    expect(ui.connectionLines({ connection: connection(false) })).toEqual([
      { ok: false, text: "Read: The host did not accept the token." },
      { ok: false, text: "Write: Not checked." },
    ]);
    expect(ui.connectionLines({ connection: connection(true) })).toEqual([]);
    const api = { check: "github-api", ok: true, skipped: true, code: "deploy-key", message: "Issues and pull requests are not checked." };
    const good = connection(true);
    good.checks.push(api as any);
    expect(ui.connectionLines({ connection: good })).toEqual([{ ok: true, text: "GitHub API: Issues and pull requests are not checked." }]);
  });

  it("repoProblem", () => {
    const ok = { url: "https://x/y", method: "github-token", values: { token: "t" } };
    expect(ui.repoProblem({ ...ok, url: " " })).toBe("Fill in the repository URL.");
    expect(ui.repoProblem({ ...ok, url: "", needUrl: false })).toBe("");
    expect(ui.repoProblem({ ...ok, method: "https-token" })).toBe("Fill in the user name.");
    expect(ui.repoProblem({ ...ok, values: {} })).toBe("Fill in the token.");
    expect(ui.repoProblem({ ...ok, values: {}, needSecret: false })).toBe("");
    expect(ui.repoProblem({ url: "u", method: "none" })).toBe("");
    expect(ui.repoProblem(ok)).toBe("");
    expect(ui.repoProblem({ url: "u", method: "test-key", values: {}, methods: [KEY_METHOD] })).toBe("Fill in the private key.");
  });

  it("repoBody", () => {
    expect(ui.repoBody({ url: " u ", method: "github-token", values: { username: "x", token: "t" } })).toEqual({ url: "u", method: "github-token", token: "t" });
    expect(ui.repoBody({ url: "u", method: "https-token", values: { username: " ann ", token: " t " } })).toEqual({ url: "u", method: "https-token", username: "ann", token: "t" });
    expect(ui.repoBody({ method: "https-token", withUrl: false, values: { username: "ann", token: "" } })).toEqual({ method: "https-token", username: "ann" });
    expect(ui.repoBody({ url: "u", method: "none", values: { token: "t" } })).toEqual({ url: "u", method: "none" });
    expect(ui.repoBody({ url: "u", method: "none", withUrl: false })).toEqual({ method: "none" });
    expect(ui.repoBody({ url: "u", method: "test-key", values: { key: "\nline one\nline two\n" }, methods: [KEY_METHOD] }).key).toBe("line one\nline two");
  });

  it("plainError", () => {
    expect(ui.plainError(new TypeError("x"))).toBe("Could not reach the server.");
    expect(ui.plainError(new Error('"github-token" works only for a repository on github.com'))).toMatch(/^GitHub fine-grained personal access token works only/);
    expect(ui.plainError(new Error("that repository belongs to another account"))).toBe("that repository belongs to another account");
  });
});

describe("the page", () => {
  it("lists the repositories without per-repository settings", async () => {
    repos = [rec(), rec({ url: "https://git.example.com/a/b", method: "https-token", username: "ann" })];
    await show();
    const text = main().textContent;
    expect(text).toContain("https://github.com/o/a");
    expect(text).toContain("https://git.example.com/a/b");
    expect(text).toContain(ui.METHODS[0].label);
    expect(text).toContain("ann");
    expect(text.split("Not tested yet")).toHaveLength(3);
    const rowButtons = walk(main()).filter((e) => e.tag === "button").map((b) => b.textContent);
    expect(rowButtons.filter((t) => t !== "+ Add repository")).toEqual(["Test connection", "Change authentication", "Remove", "Test connection", "Change authentication", "Remove"]);
    for (const tag of ["input", "select", "textarea"]) expect(main().all(tag)).toEqual([]);
    expect(errLine(main())).toEqual([]);
  });

  it("shows the connection status: the pill, the time and the messages", async () => {
    repos = [rec({ connection: connection(true) }), rec({ connection: connection(false) }), rec()];
    await show();
    const cells = walk(main()).filter((e) => e.tag === "td" && e.textContent.includes("Connected") || e.textContent.includes("Failed") || e.textContent === "Not tested yet");
    expect(cells.length).toBeGreaterThan(0);
    const pills = byClass(main(), "pill");
    expect(pills.map((p) => p.textContent)).toEqual(["Connected", "Failed", "Not tested yet"]);
    expect(pills.map((p) => p.attrs.class)).toEqual(["pill ok", "pill fail", "pill"]);
    expect(byClass(main(), "muted").filter((e) => e.textContent.startsWith("tested ")).map((e) => e.textContent)).toEqual(["tested just now", "tested just now"]);
    expect(byClass(main(), "muted").find((e) => e.textContent.startsWith("tested "))!.attrs.title).toBeTruthy();
    expect(byClass(main(), "status").map((e) => [e.attrs.class, e.textContent])).toEqual([
      ["status bad", "Read: The host did not accept the token."],
      ["status bad", "Write: Not checked."],
    ]);
  });

  describe("test connection", () => {
    it("sends the call, disables the button while it runs, then reloads and toasts", async () => {
      const r = rec();
      repos = [r];
      await show();
      holdNext = true;
      const btn = button(main(), "Test connection")!;
      press(btn);
      await flush();
      expect(sent).toEqual([{ method: "POST", url: `/api/repos/${r.id}/test`, body: {} }]);
      expect(btn.disabled).toBe(true);
      expect(btn.textContent).toBe("Testing…");
      repos = [{ ...r, connection: connection(true) }];
      hold!.release();
      await flush();
      expect(toastText()).toBe("Connection works");
      expect(gets).toBe(2);
      expect(byClass(main(), "pill")[0]!.textContent).toBe("Connected");
    });

    it("toasts a failed test as an error", async () => {
      repos = [rec()];
      await show();
      testResult = connection(false);
      press(button(main(), "Test connection"));
      await flush();
      expect(toastText()).toBe("Connection failed");
      expect(gets).toBe(2);
    });

    it("toasts a 409 and a network failure", async () => {
      repos = [rec()];
      await show();
      answers.push({ status: 409, error: "a test of this repository is running already; wait for it to finish" });
      press(button(main(), "Test connection"));
      await flush();
      expect(toastText()).toBe("a test of this repository is running already; wait for it to finish");
      expect(gets).toBe(2);
      answers.push("throw");
      press(button(main(), "Test connection"));
      await flush();
      expect(toastText()).toBe("Could not reach the server.");
      expect(button(main(), "Test connection")!.disabled).toBeFalsy();
    });

    it("api.testRepo posts to the escaped address", async () => {
      await api.testRepo("a b");
      expect(sent).toEqual([{ method: "POST", url: "/api/repos/a%20b/test", body: {} }]);
    });
  });

  it("shows an empty list", async () => {
    await show();
    expect(main().textContent).toContain("No repositories yet.");
    expect(button(main(), "+ Add repository")).toBeDefined();
  });

  it("adds a repository as a user", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    expect(field(root(), "url")).toBeDefined();
    expect(field(root(), "method")!.all("option")).toHaveLength(3);
    const token = field(root(), "token")!;
    expect(token.attrs.type).toBe("password");
    expect(token.value).toBe("");
    const help = byClass(root(), "field").find((e) => e.all("small").length > 0)!;
    expect(help.all("small")).toHaveLength(2);
    expect(help.textContent).toContain("Pull requests");
    choose("https-token");
    expect(field(root(), "username")).toBeDefined();
    expect(field(root(), "token")!.attrs.type).toBe("password");
    type("url", "https://git.example.com/a/b");
    type("username", "ann");
    type("token", TOKEN);
    press(button(root(), "Add repository"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/repos", body: { url: "https://git.example.com/a/b", method: "https-token", username: "ann", token: TOKEN } }]);
    expect(root().children).toEqual([]);
    expect(gets).toBe(2);
    expect(main().textContent).toContain("https://git.example.com/a/b");
    expect(main().textContent).not.toContain(TOKEN);
  });

  it("adds a repository as an admin with the server's own access", async () => {
    await show(true);
    press(button(main(), "+ Add repository"));
    expect(field(root(), "method")!.all("option")).toHaveLength(4);
    choose("none");
    expect(root().all("input").map((i) => i.attrs.name)).toEqual(["url"]);
    type("url", "https://github.com/o/a");
    press(button(root(), "Add repository"));
    await flush();
    expect(sent[0]!.body).toEqual({ url: "https://github.com/o/a", method: "none" });
  });

  it("supports a method with a multi-line secret", async () => {
    await show();
    const done = ui.repoDialog({ admin: false, methods: [KEY_METHOD] });
    const ta = field(root(), "key")!;
    expect(ta.tag).toBe("textarea");
    expect(ta.value).toBe("");
    expect(root().all("input").map((i) => i.attrs.name)).toEqual(["url"]);
    type("url", "https://github.com/o/a");
    press(button(root(), "Add repository"));
    expect(errLine(root())[0]!.textContent).toBe("Fill in the private key.");
    expect(sent).toEqual([]);
    ta.value = "a\nb\n";
    press(button(root(), "Add repository"));
    await done;
    expect(sent[0]!.body).toEqual({ url: "https://github.com/o/a", method: "test-key", key: "a\nb" });
  });

  it("checks an empty URL before sending", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    type("token", TOKEN);
    press(button(root(), "Add repository"));
    expect(errLine(root())[0]!.textContent).toBe("Fill in the repository URL.");
    expect(sent).toEqual([]);
  });

  it("spaces the dialog like the other dialogs", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    expect(field(root(), "url")!.parent!.parent!.style).toMatchObject({ display: "grid", gap: "12px" });
    expect(field(root(), "token")!.parent!.parent!.style).toMatchObject({ display: "grid", gap: "12px" });
  });

  it.each([
    [400, "not a repository address: nope"],
    [409, "that repository belongs to another account"],
    [409, "you have that repository already"],
    [400, "at most 50 repositories"],
  ])("shows a server error %i in the dialog", async (status, error) => {
    await show();
    press(button(main(), "+ Add repository"));
    type("url", "https://github.com/o/a");
    type("token", TOKEN);
    answers.push({ status, error });
    const btn = button(root(), "Add repository")!;
    press(btn);
    await flush();
    expect(errLine(root())[0]!.textContent).toBe(error);
    expect(root().children.length).toBe(1);
    expect(btn.disabled).toBe(false);
  });

  it("explains a network failure", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    type("url", "https://github.com/o/a");
    type("token", TOKEN);
    answers.push("throw");
    press(button(root(), "Add repository"));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe("Could not reach the server.");
  });

  describe("change authentication", () => {
    const open = async (r: any, admin = false) => {
      repos = [r];
      await show(admin);
      press(button(main(), "Change authentication"));
    };
    const https = () => rec({ url: "https://git.example.com/a/b", method: "https-token", username: "ann" });

    it("prefills and sends only what changed", async () => {
      const r = https();
      await open(r);
      expect(field(root(), "url")).toBeUndefined();
      expect(root().textContent).toContain(r.url);
      expect(field(root(), "method")!.value).toBe("https-token");
      expect(field(root(), "username")!.value).toBe("ann");
      expect(field(root(), "token")!.value).toBe("");
      type("username", "ann2");
      press(button(root(), "Save"));
      await flush();
      expect(sent).toEqual([{ method: "PUT", url: `/api/repos/${r.id}/auth`, body: { method: "https-token", username: "ann2" } }]);
      expect(root().children).toEqual([]);
    });

    it("needs a token for a new method", async () => {
      await open(https());
      choose("github-token");
      press(button(root(), "Save"));
      expect(errLine(root())[0]!.textContent).toBe("Fill in the token.");
      expect(sent).toEqual([]);
      type("token", TOKEN);
      press(button(root(), "Save"));
      await flush();
      expect(sent[0]!.body).toEqual({ method: "github-token", token: TOKEN });
    });

    it("sends nothing when nothing changed", async () => {
      await open(https());
      press(button(root(), "Save"));
      await flush();
      expect(sent).toEqual([]);
      expect(root().children).toEqual([]);
    });

    it("keeps the dialog on a failed save and lets the person try again", async () => {
      await open(https());
      type("username", "ann2");
      const msg = "the repository was changed, but an old key is still in the Keychain";
      answers.push({ status: 500, error: msg });
      const btn = button(root(), "Save")!;
      press(btn);
      await flush();
      expect(errLine(root())[0]!.textContent).toBe(msg);
      expect(btn.disabled).toBe(false);
      press(btn);
      await flush();
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    });

    it("starts a user's record without a method on GitHub", async () => {
      await open(rec({ method: "none" }));
      expect(field(root(), "method")!.value).toBe("github-token");
      press(button(root(), "Save"));
      expect(errLine(root())[0]!.textContent).toBe("Fill in the token.");
    });

    it("never shows the token again", async () => {
      await show();
      press(button(main(), "+ Add repository"));
      type("url", "https://github.com/o/a");
      type("token", TOKEN);
      press(button(root(), "Add repository"));
      await flush();
      expect(main().textContent).not.toContain(TOKEN);
      press(button(main(), "Change authentication"));
      expect(root().textContent).not.toContain(TOKEN);
      expect(walk(root()).some((e) => e.value === TOKEN)).toBe(false);
    });
  });

  describe("closed while saving", () => {
    const start = async () => {
      await show();
      press(button(main(), "+ Add repository"));
      type("url", "https://github.com/o/a");
      type("token", TOKEN);
      holdNext = true;
      press(button(root(), "Add repository"));
      await flush();
    };

    it("sends nothing twice while the dialog is open", async () => {
      await start();
      press(button(root(), "Add repository"));
      await flush();
      expect(sent).toHaveLength(1);
      hold!.release();
      await flush();
    });

    it("keeps a newer dialog and reports the result as a toast", async () => {
      await start();
      pressEscape();
      expect(root().children).toEqual([]);
      expect(gets).toBe(1);
      const marker = new FakeElement("div");
      root().append(marker);
      hold!.release();
      await flush();
      expect(root().children).toContain(marker);
      expect(toastText()).toBe("Repository added");
      expect(gets).toBe(2);
      expect(main().textContent).toContain("https://github.com/o/a");
    });

    it("reports a failure as a toast", async () => {
      await start();
      pressEscape();
      const marker = new FakeElement("div");
      root().append(marker);
      hold!.release({ status: 409, error: "that repository belongs to another account" });
      await flush();
      expect(root().children).toContain(marker);
      expect(toastText()).toBe("that repository belongs to another account");
      expect(gets).toBe(2);
    });
  });

  describe("remove", () => {
    it("asks first", async () => {
      repos = [rec()];
      await show();
      (globalThis as any).confirm = () => false;
      press(button(main(), "Remove"));
      await flush();
      expect(sent).toEqual([]);
    });

    it("removes after a confirmation and disables the button meanwhile", async () => {
      const r = rec();
      repos = [r];
      await show();
      let asked = "";
      (globalThis as any).confirm = (m: string) => ((asked = m), true);
      holdNext = true;
      const btn = button(main(), "Remove")!;
      press(btn);
      await flush();
      expect(asked).toContain(r.url);
      expect(btn.disabled).toBe(true);
      expect(sent).toEqual([{ method: "DELETE", url: `/api/repos/${r.id}`, body: undefined }]);
      hold!.release();
      await flush();
      expect(toastText()).toBe("Repository removed");
      expect(gets).toBe(2);
      expect(main().textContent).not.toContain(r.url);
      expect(errLine(main())).toEqual([]);
    });

    it("shows a failed removal above the list without a retry", async () => {
      repos = [rec()];
      await show();
      (globalThis as any).confirm = () => true;
      answers.push({ status: 404, error: "no such repository" });
      press(button(main(), "Remove"));
      await flush();
      expect(errLine(main())[0]!.textContent).toBe("no such repository");
      expect(button(main(), "Try again")).toBeUndefined();
      expect(gets).toBe(2);
    });

    describe("cleanup retry", () => {
      const msg = "the repository was removed, but an old key is still in the Keychain";
      const first = async () => {
        const r = rec();
        repos = [r];
        await show();
        (globalThis as any).confirm = () => true;
        answers.push({ status: 500, error: msg });
        press(button(main(), "Remove"));
        await flush();
        expect(main().textContent).not.toContain(r.url);
        expect(errLine(main())[0]!.textContent).toContain(msg);
        return r;
      };

      it("a 404 on the repeat means the cleanup is done", async () => {
        const r = await first();
        answers.push({ status: 404, error: "no such repository" });
        press(button(main(), "Try again"));
        await flush();
        expect(sent[1]).toEqual({ method: "DELETE", url: `/api/repos/${r.id}`, body: undefined });
        expect(errLine(main())).toEqual([]);
        expect(toastText()).toBe("Repository removed");
      });

      it("a second 500 keeps the line and the button", async () => {
        await first();
        answers.push({ status: 500, error: msg });
        press(button(main(), "Try again"));
        await flush();
        expect(errLine(main())).toHaveLength(1);
        expect(button(main(), "Try again")).toBeDefined();
      });

      it("a 200 on the repeat clears the line", async () => {
        await first();
        press(button(main(), "Try again"));
        await flush();
        expect(errLine(main())).toEqual([]);
        expect(button(main(), "Try again")).toBeUndefined();
      });
    });
  });
});

describe("late answers", () => {
  it("does not draw over another page after the person left", async () => {
    (globalThis as any).location = { hash: "#/repos" };
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    const loading = ui.renderRepos(main(), { admin: false });
    await flush();
    (globalThis as any).location = { hash: "#/runs" };
    main().textContent = "Runs page";
    gate.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("Runs page");
  });

  it.each(["#/repos/x", "#/%72epos/x"])("draws the list on a longer address %s", async (hash) => {
    (globalThis as any).location = { hash };
    repos = [rec()];
    main().textContent = "old page";
    await show(true);
    expect(main().textContent).toContain("https://github.com/o/a");
    expect(main().textContent).not.toContain("old page");
  });

  it("drops the answer of a load that a cleanup has cancelled", async () => {
    (globalThis as any).location = { hash: "#/repos" };
    await show();
    const cleanup = await ui.renderRepos(main(), { admin: false });
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    const loading = ui.renderRepos(main(), { admin: false });
    await flush();
    cleanup();
    main().textContent = "other";
    gate.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("other");
  });

  it("draws only the newest of overlapping loads", async () => {
    (globalThis as any).location = { hash: "#/repos" };
    const r = rec();
    repos = [r];
    const older: (() => void)[] = [];
    heldGets.push(older); // the older load sees the repository
    const first = ui.renderRepos(main(), { admin: false });
    await flush();
    repos = [];
    const second = ui.renderRepos(main(), { admin: false });
    await flush();
    expect(main().textContent).toContain("No repositories yet.");
    older.forEach((f) => f());
    await Promise.all([first, second]);
    expect(main().textContent).toContain("No repositories yet.");
    expect(main().textContent).not.toContain(r.url);
  });
});

describe("the SSH deploy key", () => {
  const SSH = "git@github.com:o/a.git";
  const deployRec = (over: object = {}): ReturnType<typeof rec> & { publicKey?: string } => rec({ url: SSH, method: "ssh-deploy-key", publicKey: nextKey(), ...over });
  const keyOf = (r: any) => byClass(main(), "field").flatMap((e) => e.all("code")).find((c) => c.textContent === r.publicKey);
  afterEach(() => vi.unstubAllGlobals());

  it("adds one as a user: the placeholder changes and the row shows the key and the hint", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    expect(field(root(), "url")!.attrs.placeholder).toBe("https://github.com/owner/name");
    choose("ssh-deploy-key");
    expect(field(root(), "url")!.attrs.placeholder).toBe("git@github.com:owner/name.git");
    expect(root().all("input").map((i) => i.attrs.name)).toEqual(["url"]);
    choose("github-token");
    expect(field(root(), "url")!.attrs.placeholder).toBe("https://github.com/owner/name");
    choose("ssh-deploy-key");
    type("url", SSH);
    press(button(root(), "Add repository"));
    await flush();
    expect(sent).toEqual([{ method: "POST", url: "/api/repos", body: { url: SSH, method: "ssh-deploy-key" } }]);
    expect(main().textContent).toContain(repos[0].publicKey);
    expect(main().textContent).toContain(ui.DEPLOY_KEY_HINT);
    expect(main().textContent).toContain("SSH deploy key");
  });

  it("copies the key", async () => {
    const r = deployRec();
    repos = [r];
    await show();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    press(button(main(), "Copy"));
    await flush();
    expect(writeText).toHaveBeenCalledWith(r.publicKey);
    expect(toastText()).toBe("Public key copied");
    vi.stubGlobal("navigator", {});
    press(button(main(), "Copy"));
    await flush();
    expect(toastText()).toBe("Could not copy. Select the key and copy it yourself.");
    expect(keyOf(r)!.style).toMatchObject({ userSelect: "all" });
  });

  it("generates a new key only after a confirmation, and shows it", async () => {
    const r = deployRec();
    repos = [r];
    await show();
    (globalThis as any).confirm = () => false;
    press(button(main(), "Generate a new key"));
    await flush();
    expect(sent).toEqual([]);
    let asked = "";
    (globalThis as any).confirm = (m: string) => ((asked = m), true);
    holdNext = true;
    const btn = button(main(), "Generate a new key")!;
    press(btn);
    await flush();
    expect(asked).toBe(`Generate a new key for ${SSH}? The old key stops working. Add the new public key as a deploy key and remove the old one.`);
    expect(btn.disabled).toBe(true);
    expect(sent).toEqual([{ method: "PUT", url: `/api/repos/${r.id}/auth`, body: { newKey: true } }]);
    hold!.release();
    await flush();
    expect(toastText()).toBe("New key generated");
    expect(main().textContent).toContain(repos[0].publicKey);
    expect(main().textContent).not.toContain(r.publicKey);
  });

  it("shows a failed new key above the list without a retry", async () => {
    repos = [deployRec()];
    await show();
    (globalThis as any).confirm = () => true;
    answers.push({ status: 500, error: "the SSH key could not be made; see the server log" });
    press(button(main(), "Generate a new key"));
    await flush();
    expect(errLine(main())[0]!.textContent).toBe("the SSH key could not be made; see the server log");
    expect(button(main(), "Try again")).toBeUndefined();
  });

  it("asks about the stored key when removing", async () => {
    repos = [deployRec(), rec()];
    await show();
    const asked: string[] = [];
    (globalThis as any).confirm = (m: string) => (asked.push(m), false);
    for (const b of walk(main()).filter((e) => e.tag === "button" && e.textContent === "Remove")) press(b);
    expect(asked[0]).toContain("Its stored key is deleted too.");
    expect(asked[1]).toContain("Its stored token is deleted too.");
  });

  it("a token row has no key block and no new-key button", async () => {
    repos = [rec()];
    await show();
    expect(button(main(), "Copy")).toBeUndefined();
    expect(button(main(), "Generate a new key")).toBeUndefined();
    expect(main().textContent).not.toContain("Public key");
  });

  describe("change authentication", () => {
    const open = async (r: any) => {
      repos = [r];
      await show();
      press(button(main(), "Change authentication"));
    };

    it("asks for the SSH address on an https record", async () => {
      const r = rec();
      await open(r);
      expect(field(root(), "url")).toBeUndefined();
      choose("ssh-deploy-key");
      const url = field(root(), "url")!;
      expect(url.attrs.class).toBe("mono");
      expect(url.value).toBe("");
      expect(root().textContent).toContain("SSH address");
      press(button(root(), "Save"));
      expect(errLine(root())[0]!.textContent).toBe("Fill in the repository URL.");
      expect(sent).toEqual([]);
      type("url", SSH);
      press(button(root(), "Save"));
      await flush();
      expect(sent).toEqual([{ method: "PUT", url: `/api/repos/${r.id}/auth`, body: { url: SSH, method: "ssh-deploy-key" } }]);
    });

    it("keeps what was typed in the address when the method changes back and forth", async () => {
      await open(rec());
      choose("ssh-deploy-key");
      type("url", SSH);
      choose("https-token");
      expect(field(root(), "url")).toBeUndefined();
      choose("ssh-deploy-key");
      expect(field(root(), "url")!.value).toBe(SSH);
    });

    it("asks for an https address when a deploy-key record changes to a token method", async () => {
      const r = deployRec();
      await open(r);
      expect(field(root(), "url")).toBeUndefined();
      choose("github-token");
      const url = field(root(), "url")!;
      expect(url.attrs.placeholder).toBe("https://github.com/owner/name");
      expect(root().textContent).toContain("HTTPS address");
      type("token", TOKEN);
      press(button(root(), "Save"));
      expect(errLine(root())[0]!.textContent).toBe("Fill in the repository URL.");
      type("url", "https://github.com/o/a");
      press(button(root(), "Save"));
      await flush();
      expect(sent).toEqual([{ method: "PUT", url: `/api/repos/${r.id}/auth`, body: { url: "https://github.com/o/a", method: "github-token", token: TOKEN } }]);
    });

    it("has no address input on an SSH record", async () => {
      const r = rec({ url: SSH, method: "none" });
      await open(r);
      choose("ssh-deploy-key");
      expect(field(root(), "url")).toBeUndefined();
      press(button(root(), "Save"));
      await flush();
      expect(sent).toEqual([{ method: "PUT", url: `/api/repos/${r.id}/auth`, body: { method: "ssh-deploy-key" } }]);
    });
  });

  it("shows the method name in a server error", async () => {
    await show();
    press(button(main(), "+ Add repository"));
    choose("ssh-deploy-key");
    type("url", "https://github.com/o/a");
    answers.push({ status: 400, error: '"ssh-deploy-key" works only with an SSH address' });
    press(button(root(), "Add repository"));
    await flush();
    expect(errLine(root())[0]!.textContent).toBe("SSH deploy key works only with an SSH address");
  });

  it("isSshUrl", () => {
    for (const u of ["git@github.com:o/a.git", "ssh://git@host/a/b", " SSH://host/a", "GIT@host:a/b"]) expect(ui.isSshUrl(u), u).toBe(true);
    for (const u of ["https://github.com/o/a", "o/a", "", undefined]) expect(ui.isSshUrl(u), String(u)).toBe(false);
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");
  it("links the page for every account", () => {
    expect(read("index.html")).toContain('href="#/repos" data-nav="repos">My repositories<');
    const app = read("app.js");
    expect(app).toContain('from "./repos.js"');
    expect(app).toContain('section === "repos"');
    expect(read("style.css")).toContain('.role-user .top nav a:not([data-nav="runs"]):not([data-nav="repos"])');
  });

  it("api calls use the right routes and errors carry the status", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return url === "/api/repos/conflict" ? { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "taken" }) } : { ok: true, status: 200, json: async () => ({}) };
    };
    await api.repos();
    await api.addRepo({});
    await api.setRepoAuth("a b", {});
    await api.removeRepo("x");
    expect(seen).toEqual(["GET /api/repos", "POST /api/repos", "PUT /api/repos/a%20b/auth", "DELETE /api/repos/x"]);
    const e = await api.removeRepo("conflict").catch((x: any) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("taken");
    expect(e.status).toBe(409);
  });
});
