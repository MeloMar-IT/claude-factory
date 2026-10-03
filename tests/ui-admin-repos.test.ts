import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let api: any;
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin-repos.js" as string);
  api = (await import("../ui/api.js" as string)).api;
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

type Answer = { status: number; error: string };
let repos: any[];
let sent: { method: string; url: string; body: any }[];
let answers: Answer[];
let heldGets: (() => void)[][];
const realFetch = globalThis.fetch;
let nextId = 1;

beforeEach(() => {
  repos = [];
  sent = [];
  answers = [];
  heldGets = [];
  delete (globalThis as any).location;
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = [];
  (document as any).getElementById("toast").textContent = "";
  const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      const snapshot = [...repos];
      const wait = heldGets.shift();
      if (wait) await new Promise<void>((r) => wait.push(r));
      return reply(snapshot);
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.shift();
    return answer ? reply({ error: answer.error }, answer.status) : reply({});
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
const byClass = (el: FakeElement, cls: string) => walk(el).filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const field = (el: FakeElement, name: string) => walk(el).find((e) => e.attrs.name === name);
const button = (el: FakeElement, text: string) => walk(el).find((e) => e.tag === "button" && e.textContent === text);
const press = (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
};
const rec = (over: object = {}) => ({
  id: `r${nextId++}`,
  url: "https://github.com/o/a",
  method: "github-token",
  settings: {},
  account: { name: "Ann", email: "ann@example.com", role: "user", status: "active" },
  ...over,
});
const show = () => ui.renderAllRepos(main());
const errText = (el: FakeElement) => byClass(el, "status").filter((e) => e.attrs.class === "status bad").map((e) => e.textContent).join("");

describe("pure functions", () => {
  it("settingsBody sends every setting, trimmed", () => {
    expect(ui.settingsBody({ testCommand: " npm test ", docs: " a.md \n\n b.md\n", protectedBranches: "release/*\n", mainBranch: " main", developBranch: "" })).toEqual({
      testCommand: "npm test",
      docs: ["a.md", "b.md"],
      protectedBranches: ["release/*"],
      mainBranch: "main",
      developBranch: "",
    });
    expect(ui.settingsBody()).toEqual({ testCommand: "", docs: [], protectedBranches: [], mainBranch: "", developBranch: "" });
  });

  it("ownerText and sortRepos", () => {
    expect(ui.ownerText(rec())).toBe("Ann (ann@example.com)");
    expect(ui.ownerText({ account: null })).toBe("Unknown account");
    expect(ui.ownerText({})).toBe("Unknown account");
    const bob = rec({ url: "z", account: { name: "Bob", email: "bob@example.com", role: "user", status: "active" } });
    const a2 = rec({ url: "b" });
    const a1 = rec({ url: "a" });
    expect(ui.sortRepos([bob, a2, a1]).map((r: any) => r.url)).toEqual(["a", "b", "z"]);
  });
});

describe("the page", () => {
  it("lists URL, owner, method label and connection status, with Settings and Transfer on every row", async () => {
    repos = [rec(), rec({ url: "https://github.com/o/b", method: "none" })];
    await show();
    const text = main().textContent;
    for (const t of ["https://github.com/o/a", "Ann (ann@example.com)", "GitHub fine-grained personal access token", "Not tested yet", "Needs authentication", "Repositories", "The repositories of all accounts"]) {
      expect(text).toContain(t);
    }
    const rows = walk(main()).filter((e) => e.tag === "tr").slice(1);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(walk(r).filter((e) => e.tag === "button").map((e) => e.textContent)).toEqual(["Settings", "Transfer"]);
  });

  it("reads none as the server's own access for an admin's repository", async () => {
    repos = [rec({ method: "none", account: { name: "Root", email: "root@example.com", role: "admin", status: "active" } })];
    await show();
    expect(main().textContent).toContain("The server's own access");
    expect(main().textContent).not.toContain("Needs authentication");
  });

  it("shows an unknown account and a blocked owner", async () => {
    repos = [rec({ account: null }), rec({ account: { name: "Bob", email: "bob@example.com", role: "user", status: "blocked" } })];
    await show();
    expect(main().textContent).toContain("Unknown account");
    expect(byClass(main(), "pill").map((e) => e.textContent)).toContain("blocked");
  });

  it("shows the empty list text", async () => {
    await show();
    expect(main().textContent).toContain("No repositories yet.");
  });
});

describe("settings dialog", () => {
  const S = { testCommand: "npm test", docs: ["a.md", "b.md"], protectedBranches: ["release/*"], mainBranch: "main", developBranch: "develop" };
  const open = async (r = rec({ settings: S })) => {
    repos = [r];
    await show();
    press(button(main(), "Settings"));
    await flush();
    return r;
  };

  it("is prefilled and explains the pattern", async () => {
    await open();
    expect(field(root(), "testCommand")!.value).toBe("npm test");
    expect(field(root(), "docs")!.value).toBe("a.md\nb.md");
    expect(field(root(), "protectedBranches")!.value).toBe("release/*");
    expect(field(root(), "mainBranch")!.value).toBe("main");
    expect(field(root(), "developBranch")!.value).toBe("develop");
    expect(root().textContent).toContain("? one character");
    expect(root().textContent).toContain("Runs do not use these settings yet.");
  });

  it("saves with the exact body, shows the toast, closes and reloads", async () => {
    const r = await open();
    field(root(), "docs")!.value = "x.md";
    press(button(root(), "Save"));
    await flush();
    await flush();
    expect(sent).toEqual([{ method: "PUT", url: `/api/admin/repos/${r.id}/settings`, body: { ...S, docs: ["x.md"] } }]);
    expect(toastText()).toBe("Settings saved");
    expect(root().children).toHaveLength(0);
  });

  it("shows a 400 in the dialog and enables the button again", async () => {
    await open();
    answers.push({ status: 400, error: "mainBranch must be a valid git branch name" });
    press(button(root(), "Save"));
    await flush();
    expect(errText(root())).toContain("mainBranch must be a valid git branch name");
    expect(button(root(), "Save")!.disabled).toBeFalsy();
    expect(root().children).not.toHaveLength(0);
  });
});

describe("transfer dialog", () => {
  const open = async (r = rec()) => {
    repos = [r];
    await show();
    press(button(main(), "Transfer"));
    await flush();
    return r;
  };

  it("asks for the e-mail and sends nothing when it is empty", async () => {
    await open();
    press(button(root(), "Transfer"));
    await flush();
    expect(errText(root())).toBe("Fill in the e-mail of the new owner.");
    expect(sent).toEqual([]);
    expect(root().textContent).toContain("Owner now: Ann (ann@example.com)");
  });

  it("sends the e-mail, shows the toast and reloads", async () => {
    const r = await open();
    field(root(), "email")!.value = " bob@example.com ";
    press(button(root(), "Transfer"));
    await flush();
    await flush();
    expect(sent).toEqual([{ method: "POST", url: `/api/admin/repos/${r.id}/transfer`, body: { email: "bob@example.com" } }]);
    expect(toastText()).toBe("Repository transferred");
    expect(root().children).toHaveLength(0);
  });

  it("explains the token wipe for a token method only", async () => {
    await open();
    expect(root().textContent).toContain("The stored token is deleted.");
    expect(root().textContent).toContain("If the new owner is an admin, the repository uses the server's own access until then.");
    root().replaceChildren();
    await open(rec({ method: "none" }));
    expect(root().textContent).not.toContain("The stored token is deleted.");
    expect(root().textContent).not.toContain("stays with it");
  });

  it("shows a refusal (400, 409) in the dialog", async () => {
    await open();
    field(root(), "email")!.value = "x@example.com";
    for (const [status, error] of [[400, "that account has 50 repositories already"], [409, "that account is blocked"]] as const) {
      answers.push({ status, error });
      press(button(root(), "Transfer"));
      await flush();
      expect(errText(root())).toBe(error);
      expect(button(root(), "Transfer")!.disabled).toBeFalsy();
    }
  });
});

describe("late answers", () => {
  it("draws nothing after the person left the page", async () => {
    (globalThis as any).location = { hash: "#/all-repos" };
    const gate: (() => void)[] = [];
    heldGets.push(gate);
    const loading = ui.renderAllRepos(main());
    await flush();
    (globalThis as any).location = { hash: "#/runs" };
    main().textContent = "Runs page";
    gate.forEach((r) => r());
    await loading;
    expect(main().textContent).toBe("Runs page");
  });

  it("draws only the newest of overlapping loads", async () => {
    (globalThis as any).location = { hash: "#/all-repos" };
    repos = [rec()];
    const older: (() => void)[] = [];
    heldGets.push(older);
    const first = ui.renderAllRepos(main());
    await flush();
    repos = [];
    const second = ui.renderAllRepos(main());
    await flush();
    older.forEach((f) => f());
    await Promise.all([first, second]);
    expect(main().textContent).toContain("No repositories yet.");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8");

  it("links the page and imports it", () => {
    expect(read("index.html")).toContain('<a href="#/all-repos" data-nav="all-repos">Repositories</a>');
    const app = read("app.js");
    expect(app).toContain('from "./admin-repos.js"');
    expect(app).toContain('section === "all-repos"');
  });

  it("uses the right routes", async () => {
    const seen: string[] = [];
    (globalThis as any).fetch = async (url: string, init: any) => {
      seen.push(`${init.method} ${url}`);
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await api.allRepos();
    await api.setRepoSettings("a b", {});
    await api.transferRepo("a b", "x@y.io");
    expect(seen).toEqual(["GET /api/admin/repos", "PUT /api/admin/repos/a%20b/settings", "POST /api/admin/repos/a%20b/transfer"]);
  });

  it("never gives the page to a user", () => {
    expect(auth.userHash("#/all-repos")).toBe("#/runs");
    const replaced: string[] = [];
    expect(auth.allowedHash(false, "#/all-repos", (to: string) => replaced.push(to))).toBe("#/runs");
    expect(replaced).toEqual(["#/runs"]);
    expect(auth.allowedHash(true, "#/all-repos", () => {})).toBe("#/all-repos");
  });
});
