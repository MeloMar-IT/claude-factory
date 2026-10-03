import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { getUser, listUsers, setStatus, usersPath } from "../src/auth/users.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const PW = "test-password-12345";
const NEW_PW = "another-password-123";
const INTERNAL = "the account list is not working; see the server log";
const OLD_KEY = "an old key is still in the Keychain, so older copies of the data could be read; try again, or run scf credential rotate-key";

const WALKFLOW = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const SLOWFLOW = `name: slow
workspace: empty
one_per_repo: true
publish:
  enabled: true
steps:
  - {id: a, type: shell, run: "sleep 2"}
`;

const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return fn();
};

interface Srv {
  base: string;
  tmp: string;
  home: string;
  runsDir: string;
  logs: string[];
  ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  close: () => void;
}

describe("users API", () => {
  const open: Srv[] = [];
  const seen: string[] = [];
  afterAll(() => {
    for (const s of open) s.close();
  });

  async function boot(extra: Partial<ServerOptions> = {}): Promise<Srv> {
    const tmp = mkdtempSync(join(tmpdir(), "users-api-"));
    const home = join(tmp, "home");
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    process.env.FACTORY_HOME = home;
    const logs: string[] = [];
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({ repo, runsDir: join(tmp, "runs"), port, claudeBin, watchers: false, log: (m) => logs.push(m), accountSweepMs: 3_600_000, ...extra });
        const s: Srv = { tmp, home, runsDir: join(tmp, "runs"), logs, base: `http://127.0.0.1:${port}`, ctx: started.ctx, close: () => { started.close(); rmSync(tmp, { recursive: true, force: true }); } };
        open.push(s);
        return s;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      }
    }
  }

  /** Calls the API and keeps every answer text, to check later that nothing leaked. */
  const call = async (s: Srv, who: TestSession, method: string, path: string, body?: unknown) => {
    const r = await fetch(s.base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const keep = !(method === "POST" && (path === "/api/users" || path.endsWith("/link")) && r.status < 300);
    if (keep) seen.push(text);
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  const auditLines = () => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.action !== "sign-in") : []);

  async function world(extra: Partial<ServerOptions> = {}) {
    const s = await boot(extra);
    const admin = await signInAs(s.base);
    const ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    const bob = await signInAs(s.base, { name: "Bob", email: "bob@example.com", role: "user" });
    for (const [name, yaml] of [["walk", WALKFLOW], ["slow", SLOWFLOW]]) {
      expect((await call(s, admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
    }
    const start = async (who: TestSession, flow: string) => {
      const r = await call(s, who, "POST", "/api/runs", { flow, task: flow });
      expect(r.status).toBe(201);
      return r.json().runId as string;
    };
    const walk = async (who: TestSession) => {
      const id = await start(who, "walk");
      expect((await s.ctx.scheduler.wait(id))?.status).toBe("waiting");
      return id;
    };
    const cred = async (who: TestSession, name: string) => {
      const r = await call(s, who, "POST", "/api/credentials", { type: "token", name, secret: fakeToken(name.slice(0, 1).toUpperCase() + "q1") });
      expect(r.status).toBe(201);
      return r.json().id as string;
    };
    return { s, admin, ann, bob, start, walk, cred };
  }
  const runStatus = (s: Srv, id: string) => JSON.parse(readFileSync(join(s.runsDir, id, "run.json"), "utf8")).status;
  const zeros = { queued: 0, running: 0, waiting: 0 };

  it("lists accounts with nine keys and never a secret", async () => {
    const { s, admin, ann, walk } = await world();
    await walk(ann);
    const made = await call(s, admin, "POST", "/api/users", { name: "Cy", email: "cy@example.com", role: "user" });
    expect(made.status).toBe(201);
    await setStatus(ann.user.id, "blocked", { stopWork: true });
    const r = await call(s, admin, "GET", "/api/users");
    expect(r.status).toBe(200);
    const list = r.json() as Record<string, unknown>[];
    expect(list).toHaveLength(4);
    for (const u of list) expect(Object.keys(u).sort()).toEqual(["created", "email", "hasPassword", "id", "lastSignIn", "name", "role", "runs", "status"]);
    const by = (email: string) => list.find((u) => u.email === email)!;
    expect(by("cy@example.com")).toMatchObject({ hasPassword: false, lastSignIn: null, runs: 0 });
    expect(by("ann@example.com")).toMatchObject({ hasPassword: true, runs: 1, status: "blocked" });
    expect(by("ann@example.com").lastSignIn).not.toBeNull();
    expect(r.text).not.toMatch(/scrypt\$|passwordHash|passwordLink|stopWork/);
    expect(r.text).not.toContain(made.json().token);
  });

  it("creates an account without a password and answers with a one-time token", async () => {
    const { s, admin, ann } = await world();
    const r = await call(s, admin, "POST", "/api/users", { name: " Cy ", email: " CY@Example.com ", role: "admin" });
    expect(r.status).toBe(201);
    const { user, token } = r.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user).toMatchObject({ name: "Cy", email: "cy@example.com", role: "admin", status: "active", runs: 0, hasPassword: false });
    expect(readFileSync(usersPath(), "utf8")).not.toContain(token);
    expect(s.logs.join("\n")).not.toContain(token);
    expect(auditLines()).toEqual([expect.objectContaining({ action: "create", by: admin.user.id, userId: user.id })]);
    const set = await fetch(s.base + "/api/set-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: NEW_PW }) });
    expect(set.status).toBe(200);
    await signInAs(s.base, { email: "cy@example.com", password: NEW_PW, create: false });
    // errors
    const before = readFileSync(usersPath());
    const lines = auditLines().length;
    const bad: unknown[] = [{}, { name: "X", email: "x@example.com" }, { name: "X", email: "x@example.com", role: "boss" }, { name: "X", email: "x@example.com", role: null },
      { name: " ", email: "x@example.com", role: "user" }, { name: 5, email: "x@example.com", role: "user" }, { name: null, email: "x@example.com", role: "user" },
      { name: "X", email: "nope", role: "user" }, { name: "X", email: null, role: "user" }];
    for (const b of bad) expect((await call(s, admin, "POST", "/api/users", b)).status).toBe(400);
    expect(readFileSync(usersPath())).toEqual(before);
    expect(auditLines()).toHaveLength(lines);
    expect((await call(s, admin, "POST", "/api/users", { name: "D", email: "ANN@example.com", role: "user" })).status).toBe(409);
    const plain = await fetch(s.base + "/api/users", { method: "POST", headers: admin.headers("POST", { "content-type": "text/plain" }), body: "{}" });
    expect(plain.status).toBe(415);
    const noCsrf = await fetch(s.base + "/api/users", { method: "POST", headers: { cookie: admin.cookie, "content-type": "application/json" }, body: "{}" });
    expect(noCsrf.status).toBe(403);
    // a user may not
    const denied = await call(s, ann, "GET", "/api/users");
    expect(denied.status).toBe(403);
    expect(denied.json()).toEqual({ error: "not allowed for your role" });
  });

  it("edits an account and logs one line", async () => {
    const { s, admin, ann } = await world();
    const r = await call(s, admin, "PUT", `/api/users/${ann.user.id}`, { name: " Anna ", email: "ANNA@Example.com" });
    expect(r.status).toBe(200);
    expect(r.json().user).toMatchObject({ name: "Anna", email: "anna@example.com", role: "user" });
    expect(auditLines()).toEqual([expect.objectContaining({ action: "edit", by: admin.user.id, userId: ann.user.id })]);
    expect((await call(s, admin, "PUT", `/api/users/${ann.user.id}`, { role: "admin", name: "Z" })).status).toBe(200);
    expect(auditLines().at(-1)).toMatchObject({ action: "role", oldRole: "user", newRole: "admin" });
    expect(auditLines()).toHaveLength(2);
    expect((await call(s, admin, "PUT", `/api/users/${ann.user.id}`, {})).status).toBe(200);
    expect((await call(s, admin, "PUT", `/api/users/${ann.user.id}`, { name: "Z", role: "admin" })).status).toBe(200);
    expect(auditLines()).toHaveLength(2);
    const before = readFileSync(usersPath());
    const missing = await call(s, admin, "PUT", "/api/users/nope", {});
    expect(missing.status).toBe(404);
    expect(missing.json().error).toBe("no such account");
    expect((await call(s, admin, "PUT", `/api/users/${ann.user.id}`, { email: "bob@example.com" })).status).toBe(409);
    expect((await call(s, admin, "PUT", `/api/users/${admin.user.id}`, { role: "user" }))).toMatchObject({ status: 200 }); // Ann is a second admin now
    expect((await call(s, admin, "GET", "/api/users")).status).toBe(403);
    expect(before).not.toEqual(readFileSync(usersPath()));
  });

  it("refuses bad values for every field, and demoting the only admin", async () => {
    const { s, admin, ann } = await world();
    const before = readFileSync(usersPath());
    const text = { name: "the name must be 1 to 100 characters, without control characters", email: "that is not a valid e-mail address", role: "the role must be admin or user" };
    for (const field of ["name", "email", "role"] as const) {
      for (const v of [null, 5, true, ["x"], {}]) {
        const r = await call(s, admin, "PUT", `/api/users/${ann.user.id}`, { [field]: v });
        expect([field, v, r.status]).toEqual([field, v, 400]);
        expect(r.json().error).toBe(text[field]);
      }
    }
    expect((await call(s, admin, "PUT", `/api/users/${ann.user.id}`, { name: "New", role: null })).status).toBe(400);
    expect(getUser(ann.user.id)!.name).toBe("Ann");
    const last = await call(s, admin, "PUT", `/api/users/${admin.user.id}`, { role: "user" });
    expect(last.status).toBe(409);
    expect(last.json().error).toContain("make another admin first");
    expect(readFileSync(usersPath())).toEqual(before);
    expect(auditLines()).toHaveLength(0);
  });

  it("a plain block drops the queued job at once and leaves the running and waiting runs", async () => {
    const { s, admin, ann, walk, start } = await world();
    const waitingId = await walk(ann);
    const active = await start(ann, "slow");
    const queued = await start(ann, "slow");
    expect(await until(() => s.ctx.scheduler.isActive(active))).toBe(true);
    const r = await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, {});
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ cancelled: { queued: 1, running: 0, waiting: 0 }, user: { status: "blocked" } });
    expect(s.ctx.scheduler.isQueued(queued)).toBe(false);
    expect((await call(s, ann, "GET", "/api/runs")).status).toBe(401);
    await s.ctx.scheduler.wait(active);
    expect(runStatus(s, active)).toBe("succeeded");
    expect(runStatus(s, waitingId)).toBe("waiting");
    expect(s.logs).toContain(`account ${ann.user.id} blocked: cancelled 1 queued, 0 running, 0 waiting`);
    expect(auditLines()).toEqual([expect.objectContaining({ action: "block", stopWork: false, by: admin.user.id })]);
    // blocking again: zeros and no second line
    const again = await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, {});
    expect(again.json().cancelled).toEqual(zeros);
    expect(auditLines()).toHaveLength(1);
    expect(s.logs.join("\n")).not.toMatch(/ann@example\.com|Ann/);
  });

  it("block with stopWork cancels running and waiting runs and spares others", async () => {
    const { s, admin, ann, bob, walk, start } = await world();
    const bobs = await walk(bob);
    const waitingId = await walk(ann);
    const active = await start(ann, "slow");
    const queued = await start(ann, "slow");
    expect(await until(() => s.ctx.scheduler.isActive(active))).toBe(true);
    const r = await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, { stopWork: true });
    expect(r.json().cancelled).toEqual({ queued: 1, running: 1, waiting: 1 });
    expect(getUser(ann.user.id)!.stopWork).toBeUndefined();
    expect(s.ctx.scheduler.isQueued(queued)).toBe(false);
    await s.ctx.scheduler.wait(active);
    expect(runStatus(s, active)).toBe("cancelled");
    expect(runStatus(s, waitingId)).toBe("cancelled");
    expect(runStatus(s, bobs)).toBe("waiting");
    expect(auditLines()).toEqual([expect.objectContaining({ action: "block", stopWork: true })]);
  });

  it("refuses bad block input and blocking the only admin", async () => {
    const { s, admin, ann } = await world();
    for (const v of ["yes", 1, null]) expect((await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, { stopWork: v })).status).toBe(400);
    expect(getUser(ann.user.id)!.status).toBe("active");
    expect((await call(s, ann, "GET", "/api/flows")).status).toBe(200);
    expect((await call(s, admin, "POST", `/api/users/${admin.user.id}/block`, {})).status).toBe(409);
    expect((await call(s, admin, "POST", "/api/users/nope/block", {})).status).toBe(404);
    expect((await call(s, admin, "GET", "/api/users")).status).toBe(200);
    expect(auditLines()).toHaveLength(0);
    expect(s.logs.some((l) => l.includes("cancelled"))).toBe(false);
  });

  it("an admin blocking themselves with a second admin signs out", async () => {
    const { s, admin } = await world();
    const two = await call(s, admin, "POST", "/api/users", { name: "Two", email: "two@example.com", role: "admin" });
    await fetch(s.base + "/api/set-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: two.json().token, password: NEW_PW }) });
    const other = await signInAs(s.base, { email: "two@example.com", password: NEW_PW, create: false });
    expect((await call(s, admin, "POST", `/api/users/${admin.user.id}/block`, {})).status).toBe(200);
    const next = await call(s, admin, "GET", "/api/users");
    expect(next.status).toBe(401);
    expect(next.json().error).toBe("sign in first");
    expect((await call(s, other, "GET", "/api/users")).status).toBe(200);
  });

  it("unblocks, restarts nothing, and unblocking an active account writes no line", async () => {
    const { s, admin, ann, start } = await world();
    await start(ann, "slow");
    const queued = await start(ann, "slow");
    await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, {});
    const r = await call(s, admin, "POST", `/api/users/${ann.user.id}/unblock`, {});
    expect(r.status).toBe(200);
    expect(r.json().user.status).toBe("active");
    expect(auditLines().map((l) => l.action)).toEqual(["block", "unblock"]);
    expect(s.ctx.scheduler.isQueued(queued)).toBe(false);
    await signInAs(s.base, { email: "ann@example.com", create: false });
    expect((await call(s, admin, "POST", `/api/users/${ann.user.id}/unblock`, {})).status).toBe(200);
    expect(auditLines()).toHaveLength(2);
    expect((await call(s, admin, "POST", "/api/users/nope/unblock", {})).status).toBe(404);
  });

  it("gives a new link only to an account without a password", async () => {
    const { s, admin, ann } = await world();
    const made = (await call(s, admin, "POST", "/api/users", { name: "Cy", email: "cy@example.com", role: "user" })).json();
    const r = await call(s, admin, "POST", `/api/users/${made.user.id}/link`);
    expect(r.status).toBe(200);
    const set = (token: string) => fetch(s.base + "/api/set-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: NEW_PW }) });
    expect((await set(made.token)).status).toBe(400);
    expect((await set(r.json().token)).status).toBe(200);
    expect(auditLines().filter((l) => l.action === "link")).toEqual([expect.objectContaining({ by: admin.user.id, userId: made.user.id })]);
    const has = await call(s, admin, "POST", `/api/users/${ann.user.id}/link`);
    expect(has.status).toBe(409);
    expect(has.json().error).toBe("this account has a password already");
    expect((await call(s, admin, "POST", "/api/users/nope/link")).status).toBe(404);
  });

  it("deletes an account, drops its queued job at once and keeps its run.json", async () => {
    const { s, admin, ann, cred, start } = await world();
    await cred(ann, "ann-cred");
    const finished = await start(ann, "slow");
    await s.ctx.scheduler.wait(finished);
    const active = await start(ann, "slow");
    const queued = await start(ann, "slow");
    expect(await until(() => s.ctx.scheduler.isActive(active))).toBe(true);
    expect(s.ctx.scheduler.isQueued(queued)).toBe(true);
    const r = await call(s, admin, "DELETE", `/api/users/${ann.user.id}`);
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true, credentials: 1, cancelled: { queued: 1, running: 0, waiting: 0 } });
    expect(s.ctx.scheduler.isQueued(queued)).toBe(false);
    expect(listUsers().some((u) => u.id === ann.user.id)).toBe(false);
    expect((await call(s, ann, "GET", "/api/runs")).status).toBe(401);
    expect(existsSync(join(s.runsDir, finished, "run.json"))).toBe(true);
    expect(auditLines()).toEqual([expect.objectContaining({ action: "delete", by: admin.user.id, userId: ann.user.id })]);
    expect(s.logs.some((l) => l.startsWith(`account ${ann.user.id} deleted: cancelled `))).toBe(true);
    expect((await call(s, admin, "DELETE", `/api/users/${ann.user.id}`)).status).toBe(404);
    expect((await call(s, admin, "DELETE", `/api/users/${admin.user.id}`)).status).toBe(409);
  });

  it("answers 500 with the credentials sentence when an old key stays", async () => {
    const { s, admin, ann, cred } = await world();
    const mine = [await cred(admin, "one"), await cred(admin, "two")];
    await cred(ann, "ann-cred");
    kc.fail("delete");
    try {
      const account = await call(s, admin, "DELETE", `/api/users/${ann.user.id}`);
      const credential = await call(s, admin, "DELETE", `/api/credentials/${mine[0]}`);
      expect(account.status).toBe(500);
      expect(credential.status).toBe(500);
      const credText = credential.json().error as string;
      expect(credText.startsWith("the credential was removed, but ")).toBe(true);
      expect(credText).toBe(`the credential was removed, but ${OLD_KEY}`);
      expect(account.json().error).toBe(credText.replace("the credential was removed, but ", "the account was deleted, but "));
    } finally {
      kc.fail();
    }
    expect(listUsers().some((u) => u.id === ann.user.id)).toBe(false);
    expect(auditLines().filter((l) => l.action === "delete")).toHaveLength(1);
    expect(s.logs).toContain("users: 1 old key(s) still in the Keychain; run scf credential rotate-key");
  });

  it("answers a plain 500 when the store fails, without a path or value", async () => {
    const { s, admin, ann, cred } = await world();
    await cred(ann, "ann-cred");
    rmSync(auditPath(), { force: true });
    mkdirSync(auditPath());
    const before = readFileSync(usersPath());
    const calls: [string, string, unknown?][] = [
      ["POST", "/api/users", { name: "Cy", email: "cy@example.com", role: "user" }],
      ["PUT", `/api/users/${ann.user.id}`, { name: "Z" }],
      ["POST", `/api/users/${ann.user.id}/block`, {}],
      ["DELETE", `/api/users/${ann.user.id}`],
    ];
    const answers: string[] = [];
    for (const [m, p, b] of calls) {
      const r = await call(s, admin, m, p, b);
      expect([m, p, r.status, r.json().error]).toEqual([m, p, 500, INTERNAL]);
      answers.push(r.text);
    }
    expect(s.logs.filter((l) => l === "users: audit.jsonl cannot-write")).toHaveLength(4);
    expect(readFileSync(usersPath())).toEqual(before);
    expect((await call(s, ann, "GET", "/api/credentials")).json()).toHaveLength(1);
    expect(s.logs.join("\n") + answers.join("\n")).not.toContain(s.tmp);
  });

  it("a repos.json that is not JSON stops a delete before anything changes", async () => {
    const { s, admin, ann, cred } = await world();
    await cred(ann, "ann-cred");
    writeFileSync(join(s.home, "repos.json"), "nope");
    const r = await call(s, admin, "DELETE", `/api/users/${ann.user.id}`);
    expect(r.status).toBe(500);
    expect(r.json().error).toBe(INTERNAL);
    expect(s.logs).toContain("users: repos.json not-json");
    expect(getUser(ann.user.id)).toBeDefined();
    expect((await call(s, ann, "GET", "/api/credentials")).status).toBe(200);
  });

  it("a Keychain failure part-way keeps the account and the queued job; the same call finishes later", async () => {
    const { s, admin, ann, bob, cred, start } = await world();
    await cred(ann, "ann-cred");
    await cred(bob, "bob-cred");
    await start(ann, "slow");
    const queued = await start(ann, "slow");
    kc.fail("find");
    const r = await call(s, admin, "DELETE", `/api/users/${ann.user.id}`);
    kc.fail();
    expect(r.status).toBe(500);
    expect(r.json().error).toBe(INTERNAL);
    expect(s.logs).toContain("users: keychain failed");
    expect(getUser(ann.user.id)?.status).toBe("active");
    expect((await call(s, ann, "GET", "/api/runs")).status).toBe(401);
    expect(auditLines()).toHaveLength(0);
    expect(s.ctx.scheduler.isQueued(queued)).toBe(true);
    expect(s.logs.some((l) => l.includes("deleted: cancelled"))).toBe(false);
    const again = await call(s, admin, "DELETE", `/api/users/${ann.user.id}`);
    expect(again.status).toBe(200);
    expect(again.json().cancelled.queued).toBe(1);
    expect(auditLines().filter((l) => l.action === "delete")).toHaveLength(1);
  });

  it("a block that cannot write users.json signs the account out but changes nothing else", async () => {
    const { s, admin, ann, start } = await world();
    await start(ann, "slow");
    const queued = await start(ann, "slow");
    mkdirSync(usersPath() + ".tmp");
    const r = await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, {});
    expect(r.status).toBe(500);
    expect((await call(s, ann, "GET", "/api/runs")).status).toBe(401);
    expect(getUser(ann.user.id)!.status).toBe("active");
    expect(auditLines()).toHaveLength(0);
    expect(s.ctx.scheduler.isQueued(queued)).toBe(true);
    rmSync(usersPath() + ".tmp", { recursive: true });
    expect((await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, {})).status).toBe(200);
    expect(auditLines().filter((l) => l.action === "block")).toHaveLength(1);
  });

  it("a queue.json that cannot be written answers a plain 500 and logs the file and kind", async () => {
    const { s, admin, ann, start } = await world();
    await start(ann, "slow");
    await start(ann, "slow");
    rmSync(join(s.home, "queue.json"), { force: true });
    mkdirSync(join(s.home, "queue.json"));
    const r = await call(s, admin, "POST", `/api/users/${ann.user.id}/block`, {});
    expect(r.status).toBe(500);
    expect(r.json().error).toBe(INTERNAL);
    expect(s.logs).toContain("users: queue.json cannot-write");
    expect(r.text).not.toContain(s.tmp);
    expect(s.logs.join("\n")).not.toContain(s.tmp);
  });

  it("leaks no token or hash in any kept answer", () => {
    const all = seen.join("\n");
    expect(all).not.toMatch(/scrypt\$/);
    expect(all).not.toMatch(/"token":"[A-Za-z0-9_-]{43}"/);
  });
});
