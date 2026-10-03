import { randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addSession, readSessions, sessionId, sessionsPath } from "../src/auth/sessions.js";
import {
  changePassword, checkSignIn, createUser, createUserWithLink, getUser, listUsers, redeemPasswordLink, resetPassword, setStatus, usersPath, type UserError,
} from "../src/auth/users.js";
import { throttlesOf } from "../src/server/api-auth.js";
import { startServer } from "../src/server/server.js";
import { TEST_PASSWORD, signInAs, type TestSession } from "./helpers/session.js";

const PW = TEST_PASSWORD;
const PW2 = "test-other-password-678";
const COMMON = "password1234";
const SHORT_PW = "test-pw-10";
const WRONG = "wrong-password-123";
const INTERNAL = { error: "sign-in is not working; see the server log" };

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "password-change-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = async (p: Promise<unknown>) => await p.then(() => undefined, (e: UserError) => e.code);
const rejection = async (p: Promise<unknown>) => await p.then(() => undefined, (e: Error) => e);
const audit = () =>
  existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const bytes = () => readFileSync(usersPath());
const tmpFolder = (path: string) => mkdirSync(`${path}.tmp`);
const sessionsOf = (id: string) => readSessions().filter((s) => s.userId === id).length;
const ann = () => createUser({ name: "Ann", email: "ann@example.com", password: PW, role: "admin" });
const bob = () => createUser({ name: "Bob", email: "bob@example.com", password: PW, role: "admin" });
const signsIn = async (email: string, password: string) => (await checkSignIn(email, password)) !== undefined;

describe("resetPassword", () => {
  it("removes the hash, stores a link (the hash of the token only) and ends the sessions of the account only", async () => {
    const a = await ann();
    const b = await bob();
    addSession(a.id);
    addSession(a.id);
    addSession(b.id);
    const r = await resetPassword(a.id, { by: "cli" });
    const stored = getUser(a.id)!;
    expect(stored.passwordHash).toBeUndefined();
    expect(stored.passwordLink?.id).toBe(sessionId(r.token));
    expect(readFileSync(usersPath(), "utf8")).not.toContain(r.token);
    expect(r.user).not.toHaveProperty("passwordHash");
    expect(sessionsOf(a.id)).toBe(0);
    expect(sessionsOf(b.id)).toBe(1);
    expect(await signsIn("ann@example.com", PW)).toBe(false);
  });

  it("writes the audit line `reset` with `by`, and the link sets a password that signs in", async () => {
    const a = await ann();
    await bob();
    const r = await resetPassword(a.id, { by: "cli" });
    const lines = audit().filter((l) => l.action === "reset");
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0]!).sort()).toEqual(["action", "by", "time", "userId"]);
    expect(lines[0]).toMatchObject({ by: "cli", userId: a.id });
    expect(await redeemPasswordLink(r.token, PW2)).toBeDefined();
    expect(await signsIn("ann@example.com", PW2)).toBe(true);
  });

  it("refuses an account without a password and the only admin; allows a second admin and a blocked account", async () => {
    const link = await createUserWithLink({ name: "New", email: "new@example.com" });
    expect(await code(resetPassword(link.user.id))).toBe("no-password");
    const a = await ann();
    const before = bytes();
    expect(await code(resetPassword(a.id))).toBe("last-admin");
    expect(bytes()).toEqual(before);
    const b = await bob();
    await createUser({ name: "Cy", email: "cy@example.com", password: PW, role: "admin" });
    expect((await resetPassword(a.id)).user.id).toBe(a.id);
    await setStatus(b.id, "blocked");
    expect((await resetPassword(b.id)).user.id).toBe(b.id);
  });

  it("changes nothing when the audit log cannot be opened", async () => {
    const a = await ann();
    await bob();
    addSession(a.id);
    mkdirSync(auditPath());
    const before = bytes();
    const sessions = readFileSync(sessionsPath());
    expect(await rejection(resetPassword(a.id, { by: "cli" }))).toBeDefined();
    expect(bytes()).toEqual(before);
    expect(readFileSync(sessionsPath())).toEqual(sessions);
  });

  it("changes nothing when sessions.json cannot be written", async () => {
    const a = await ann();
    await bob();
    addSession(a.id);
    tmpFolder(sessionsPath());
    const before = bytes();
    expect(await rejection(resetPassword(a.id, { by: "cli" }))).toBeDefined();
    expect(bytes()).toEqual(before);
    expect(sessionsOf(a.id)).toBe(1);
    expect(await signsIn("ann@example.com", PW)).toBe(true);
  });

  it("when users.json cannot be written: the sessions are gone, the password stays, no link; a second reset works", async () => {
    const a = await ann();
    await bob();
    addSession(a.id);
    tmpFolder(usersPath());
    expect(await rejection(resetPassword(a.id, { by: "cli" }))).toBeDefined();
    expect(sessionsOf(a.id)).toBe(0);
    expect(await signsIn("ann@example.com", PW)).toBe(true);
    expect(getUser(a.id)!.passwordLink).toBeUndefined();
    expect(audit().filter((l) => l.action === "reset")).toHaveLength(0);
    rmSync(`${usersPath()}.tmp`, { recursive: true });
    const r = await resetPassword(a.id, { by: "cli" });
    expect(getUser(a.id)!.passwordLink?.id).toBe(sessionId(r.token));
  });
});

describe("changePassword", () => {
  it("gives wrong-password for a wrong current password and changes nothing", async () => {
    const a = await ann();
    const before = bytes();
    expect(await code(changePassword(a.id, WRONG, PW2))).toBe("wrong-password");
    expect(bytes()).toEqual(before);
    expect(audit()).toEqual([]);
  });

  it("gives bad-password for a short or common new password", async () => {
    const a = await ann();
    expect(await code(changePassword(a.id, PW, "short"))).toBe("bad-password");
    expect(await code(changePassword(a.id, PW, COMMON))).toBe("bad-password");
    expect(await code(changePassword(a.id, PW, COMMON.toUpperCase()))).toBe("bad-password");
    expect(await signsIn("ann@example.com", PW)).toBe(true);
  });

  it("changes the password, keeps the given session, ends the others, and logs `password` by the account", async () => {
    const a = await ann();
    const b = await bob();
    const keep = addSession(a.id);
    addSession(a.id);
    addSession(b.id);
    await changePassword(a.id, PW, PW2, { keepSession: sessionId(keep) });
    expect(await signsIn("ann@example.com", PW)).toBe(false);
    expect(await signsIn("ann@example.com", PW2)).toBe(true);
    expect(readSessions().filter((s) => s.userId === a.id).map((s) => s.id)).toEqual([sessionId(keep)]);
    expect(sessionsOf(b.id)).toBe(1);
    expect(audit()).toEqual([expect.objectContaining({ action: "password", by: a.id, userId: a.id })]);
  });

  it("gives wrong-password when the password was changed in between", async () => {
    const a = await ann();
    const slow = changePassword(a.id, PW, PW2);
    // the stored hash changes while the new one is being hashed
    const { setPassword } = await import("../src/auth/users.js");
    await setPassword(a.id, "test-third-password-9");
    expect(await code(slow)).toBe("wrong-password");
    expect(await signsIn("ann@example.com", "test-third-password-9")).toBe(true);
  });

  it("when sessions.json cannot be written: nothing changes", async () => {
    const a = await ann();
    const keep = addSession(a.id);
    addSession(a.id);
    tmpFolder(sessionsPath());
    expect(await rejection(changePassword(a.id, PW, PW2, { keepSession: sessionId(keep) }))).toBeDefined();
    expect(await signsIn("ann@example.com", PW)).toBe(true);
    expect(await signsIn("ann@example.com", PW2)).toBe(false);
    expect(sessionsOf(a.id)).toBe(2);
    expect(audit()).toEqual([]);
  });

  it("when users.json cannot be written: the old password stays, the other sessions are gone; a second change works", async () => {
    const a = await ann();
    const keep = addSession(a.id);
    addSession(a.id);
    tmpFolder(usersPath());
    expect(await rejection(changePassword(a.id, PW, PW2, { keepSession: sessionId(keep) }))).toBeDefined();
    expect(await signsIn("ann@example.com", PW)).toBe(true);
    expect(await signsIn("ann@example.com", PW2)).toBe(false);
    expect(readSessions().map((s) => s.id)).toEqual([sessionId(keep)]);
    expect(audit()).toEqual([]);
    rmSync(`${usersPath()}.tmp`, { recursive: true });
    await changePassword(a.id, PW, PW2, { keepSession: sessionId(keep) });
    expect(await signsIn("ann@example.com", PW2)).toBe(true);
  });
});

describe("an old hash", () => {
  it("of a 10-character password still signs in", async () => {
    const salt = Buffer.alloc(16, 7);
    const key = scryptSync(SHORT_PW, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    const hash = `scrypt$N=32768,r=8,p=3$${salt.toString("base64")}$${key.toString("base64")}`;
    const user = { id: randomUUID(), name: "Old", email: "old@example.com", role: "user", status: "active", passwordHash: hash, created: "2026-01-01T00:00:00.000Z", lastSignIn: null };
    writeFileSync(usersPath(), JSON.stringify({ version: 1, users: [user] }), { mode: 0o600 });
    expect(listUsers()).toHaveLength(1);
    expect(await signsIn("old@example.com", SHORT_PW)).toBe(true);
  });
});

// ---- HTTP ------------------------------------------------------------------------------------------

describe("POST /api/password", () => {
  let base: string;
  let logs: string[];
  let close: () => void;
  let now = 0;
  let seen: string[];
  let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  const from = (n: number) => ({ "x-forwarded-proto": "https", "x-forwarded-for": `10.0.0.${n}` });

  beforeEach(async () => {
    now = Date.now();
    logs = [];
    seen = [];
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({
          repo: home, runsDir: join(home, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false,
          log: (m) => void logs.push(m), signInClock: () => now,
        });
        base = `http://127.0.0.1:${port}`;
        close = started.close;
        ctx = started.ctx;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      }
    }
  });
  afterEach(() => {
    // no password, hash or token in any answer or log line of the test
    for (const text of [...seen, ...logs]) for (const secret of [PW, PW2, WRONG, "scrypt$"]) expect(text).not.toContain(secret);
    close();
  });

  const change = async (who: TestSession, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json", ...who.headers("POST"), ...headers },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    seen.push(text);
    return { status: r.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  };
  const signIn = async (email: string, password: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ email, password }) });
    seen.push(await r.clone().text());
    return r;
  };
  const alive = async (who: TestSession) => (await fetch(`${base}/api/runs`, { headers: who.headers() })).status;
  const admin = () => signInAs(base);

  it("answers 401 without a session and 403 without the CSRF token", async () => {
    const who = await admin();
    const bare = await fetch(`${base}/api/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current: PW, password: PW2 }) });
    expect(bare.status).toBe(401);
    const noCsrf = await fetch(`${base}/api/password`, { method: "POST", headers: { "content-type": "application/json", cookie: who.cookie }, body: JSON.stringify({ current: PW, password: PW2 }) });
    expect(noCsrf.status).toBe(403);
    expect(await signIn(who.user.email, PW).then((r) => r.status)).toBe(200);
  });

  it("answers 400 for a missing field or a bad new password, and 403 for a wrong current password", async () => {
    const who = await admin();
    expect((await change(who, { password: PW2 })).status).toBe(400);
    expect((await change(who, { current: PW })).status).toBe(400);
    expect((await change(who, { current: 5, password: PW2 })).status).toBe(400);
    const short = await change(who, { current: PW, password: "short" });
    expect(short.status).toBe(400);
    expect(short.json().error).toContain("12 to 200 characters");
    expect((await change(who, { current: PW, password: COMMON })).status).toBe(400);
    const wrong = await change(who, { current: WRONG, password: PW2 }, from(1));
    expect(wrong.status).toBe(403);
    expect(wrong.json()).toEqual({ error: "the current password is wrong" });
    expect(await signIn(who.user.email, PW).then((r) => r.status)).toBe(200);
  });

  it("keeps the caller's session and ends the other sessions of the account", async () => {
    const who = await admin();
    const other = await admin();
    const bystander = await signInAs(base, { name: "Cy", email: "cy@example.com", role: "user" });
    const r = await change(who, { current: PW, password: PW2 });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(await alive(who)).toBe(200);
    expect(await alive(other)).toBe(401);
    expect(await alive(bystander)).toBe(200);
    expect((await signIn(who.user.email, PW)).status).toBe(401);
    expect((await signIn(who.user.email, PW2)).status).toBe(200);
  });

  it("works for the role user", async () => {
    await admin();
    const user = await signInAs(base, { name: "Cy", email: "cy@example.com", role: "user" });
    expect((await change(user, { current: PW, password: PW2 })).status).toBe(200);
    expect((await signIn("cy@example.com", PW2)).status).toBe(200);
  });

  it("waits after five wrong current passwords", async () => {
    const who = await admin();
    for (let i = 0; i < 5; i++) expect((await change(who, { current: WRONG, password: PW2 }, from(1))).status).toBe(403);
    const r = await change(who, { current: PW, password: PW2 }, from(1));
    expect(r.status).toBe(429);
    expect(r.json()).toEqual({ error: "too many tries; try again in 1 second" });
  });

  it("gives every slot back: 17 wrong calls, a failing call and the right call", async () => {
    const who = await admin();
    for (let i = 0; i < 17; i++) {
      const r = await change(who, { current: WRONG, password: PW2 }, from(1));
      expect(r.status).toBe(403);
      now += 61_000;
    }
    mkdirSync(`${usersPath()}.tmp`);
    const failing = await change(who, { current: PW, password: PW2 }, from(1));
    expect(failing.status).toBe(500);
    expect(failing.json()).toEqual(INTERNAL);
    rmSync(`${usersPath()}.tmp`, { recursive: true });
    now += 61_000;
    expect((await change(who, { current: PW, password: PW2 }, from(1))).status).toBe(200);
  });

  describe("one counter per e-mail, shared with sign-in", () => {
    it("five wrong sign-ins delay Change password", async () => {
      const who = await admin();
      for (let i = 0; i < 5; i++) expect((await signIn(who.user.email, WRONG, from(2))).status).toBe(401);
      const r = await change(who, { current: PW, password: PW2 }, from(1));
      expect(r.status).toBe(429);
      expect(r.json()).toEqual({ error: "too many tries; try again in 1 second" });
      now += 1000;
      expect((await change(who, { current: PW, password: PW2 }, from(1))).status).toBe(200);
    });

    it("five wrong current passwords delay sign-in from another address", async () => {
      const who = await admin();
      for (let i = 0; i < 5; i++) expect((await change(who, { current: WRONG, password: PW2 }, from(1))).status).toBe(403);
      const r = await signIn(who.user.email, PW, from(3));
      expect(r.status).toBe(429);
      expect(await r.json()).toEqual({ error: "too many tries; try again in 1 second" });
    });

    it("20 wrong current passwords lock the account, and the list shows it", async () => {
      const who = await admin();
      for (let i = 0; i < 20; i++) {
        expect((await change(who, { current: WRONG, password: PW2 }, from(1))).status).toBe(403);
        now += 61_000;
      }
      const r = await signIn(who.user.email, PW, from(3));
      expect(r.status).toBe(429);
      expect(((await r.json()) as { error: string }).error).toMatch(/locked/);
      const list = (await (await fetch(`${base}/api/users`, { headers: who.headers() })).json()) as { email: string; lockedUntil: string | null }[];
      expect(list.find((u) => u.email === who.user.email)!.lockedUntil).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    });

    it("a successful change clears the count of the account", async () => {
      const who = await admin();
      for (let i = 0; i < 4; i++) expect((await signIn(who.user.email, WRONG, from(2))).status).toBe(401);
      expect((await change(who, { current: PW, password: PW2 }, from(1))).status).toBe(200);
      expect(throttlesOf(ctx).accounts.countOf(who.user.email)).toBe(0);
      for (let i = 0; i < 4; i++) expect((await signIn(who.user.email, WRONG, from(3))).status).toBe(401);
    });
  });
});

describe("the user file", () => {
  it("has no field for waits or locks (they live in memory)", async () => {
    const a = await ann();
    expect(Object.keys(getUser(a.id)!).sort()).toEqual(["created", "email", "id", "lastSignIn", "name", "passwordHash", "role", "status"]);
  });
});
