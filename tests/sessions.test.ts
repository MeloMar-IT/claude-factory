import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_TTL_MS, addSession, csrfToken, findSession, readSessions, removeSessionsLocked, revokeSession, revokeUserSessions, sessionId, sessionsPath,
} from "../src/auth/sessions.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { checkSignIn, createUser, getUser, setPassword, setStatus, startSession } from "../src/auth/users.js";

const PW = "test-password-12345";
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "sessions-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const ann = (over: Record<string, unknown> = {}) => ({ name: "Ann", email: "ann@example.com", password: PW, ...over });
const raw = () => readFileSync(sessionsPath(), "utf8");
const entry = (over: Record<string, unknown> = {}) => ({
  id: "a".repeat(64),
  userId: randomUUID(),
  created: "2026-10-01T10:00:00.000Z",
  expires: "2026-10-08T10:00:00.000Z",
  ...over,
});
const put = (sessions: unknown[], extra: Record<string, unknown> = {}) =>
  writeFileSync(sessionsPath(), JSON.stringify({ version: 1, sessions, ...extra }));

describe("session file", () => {
  it("is private, holds only the hash of the token and leaves nothing behind", () => {
    const token = addSession(randomUUID());
    expect(statSync(sessionsPath()).mode & 0o777).toBe(0o600);
    expect(raw()).toContain(sessionId(token));
    expect(raw()).not.toContain(token);
    expect(readdirSync(home).sort()).toEqual(["sessions.json"]);
  });

  it("lasts 7 days and ends exactly at the expiry", () => {
    const token = addSession(randomUUID());
    const [s] = readSessions();
    expect(Date.parse(s!.expires) - Date.parse(s!.created)).toBe(604800000);
    expect(SESSION_TTL_MS).toBe(604800000);
    const end = Date.parse(s!.expires);
    expect(findSession(token, end - 1)).toBeDefined();
    expect(findSession(token, end)).toBeUndefined();
  });

  it("finds nothing for a malformed or unknown token", () => {
    addSession(randomUUID());
    for (const t of [undefined, "", "short", "x".repeat(43), "!".repeat(43), "a".repeat(44)]) expect(findSession(t)).toBeUndefined();
  });

  it("gives a CSRF token that depends on the session token", () => {
    expect(csrfToken("a")).toBe(csrfToken("a"));
    expect(csrfToken("a")).not.toBe(csrfToken("b"));
  });

  it("counts a file that is not JSON or not in the format as no sessions", () => {
    const bad: unknown[] = [
      [entry({ id: "z".repeat(64) })],
      [entry({ id: "A".repeat(64) })],
      [entry({ userId: "nope" })],
      [entry({ created: "yesterday" })],
      [entry({ extra: 1 })],
      [entry({ expires: "2026-10-01T10:00:00.000Z" })],
      [entry({ expires: "2026-09-01T10:00:00.000Z" })],
      [entry(), entry()],
    ];
    for (const s of bad) {
      put(s as unknown[]);
      expect(readSessions()).toEqual([]);
    }
    put([entry()], { more: true });
    expect(readSessions()).toEqual([]);
    writeFileSync(sessionsPath(), "not json");
    expect(readSessions()).toEqual([]);
    put([entry()]);
    expect(readSessions()).toHaveLength(1);
  });

  it("throws when the file is a folder", () => {
    mkdirSync(sessionsPath());
    expect(() => readSessions()).toThrow(expect.objectContaining({ kind: "unreadable" }));
    expect(() => readSessions()).toThrow(StoreError);
  });

  it("drops expired entries and the replaced one when adding", () => {
    const user = randomUUID();
    put([entry({ id: "b".repeat(64), userId: user }), entry({ id: "c".repeat(64), userId: user, created: "2020-01-01T00:00:00.000Z", expires: "2020-01-08T00:00:00.000Z" })]);
    const token = addSession(user, "b".repeat(64));
    expect(readSessions().map((s) => s.id)).toEqual([sessionId(token)]);
  });

  it("revokes one session or all sessions of one user", () => {
    const [u1, u2] = [randomUUID(), randomUUID()];
    const t1 = addSession(u1);
    const t2 = addSession(u1);
    const t3 = addSession(u2);
    expect(revokeSession(sessionId(t1))).toBe(1);
    expect(findSession(t1)).toBeUndefined();
    expect(findSession(t2)).toBeDefined();
    expect(revokeUserSessions(u1)).toBe(1);
    expect(findSession(t2)).toBeUndefined();
    expect(findSession(t3)).toBeDefined();
  });

  it("writes nothing when no session matches", () => {
    expect(revokeUserSessions(randomUUID())).toBe(0);
    expect(withAuthLock(() => removeSessionsLocked(() => true))).toBe(0);
    expect(existsSync(sessionsPath())).toBe(false);
  });
});

describe("sign-in", () => {
  it("checks the password and runs for unknown e-mails too", async () => {
    const u = await createUser(ann());
    expect((await checkSignIn("ANN@example.com", PW))?.id).toBe(u.id);
    expect(await checkSignIn("ann@example.com", "wrong-password-1")).toBeUndefined();
    expect(await checkSignIn("nobody@example.com", PW)).toBeUndefined();
    expect(await checkSignIn("ann@example.com", "x".repeat(201))).toBeUndefined();
  });

  it("creates a session and sets the sign-in time", async () => {
    const u = await createUser(ann());
    const s = startSession(u.id, u.passwordHash)!;
    expect(findSession(s.token)?.userId).toBe(u.id);
    expect(s.user.lastSignIn).not.toBeNull();
    expect(getUser(u.id)?.lastSignIn).toBe(s.user.lastSignIn);
  });

  it("creates no session for an old hash, a blocked or a missing user", async () => {
    const u = await createUser(ann());
    const oldHash = u.passwordHash;
    await setPassword(u.id, "another-password-678");
    expect(startSession(u.id, oldHash)).toBeUndefined();
    expect(startSession(randomUUID(), oldHash)).toBeUndefined();
    const fresh = getUser(u.id)!;
    await setStatus(u.id, "blocked");
    expect(startSession(u.id, fresh.passwordHash)).toBeUndefined();
    expect(readSessions()).toEqual([]);
    expect(getUser(u.id)?.lastSignIn).toBeNull();
  });

  it("replaces the session the sign-in came with", async () => {
    const u = await createUser(ann());
    const first = startSession(u.id, u.passwordHash)!;
    const second = startSession(u.id, u.passwordHash, sessionId(first.token))!;
    expect(findSession(first.token)).toBeUndefined();
    expect(findSession(second.token)).toBeDefined();
  });

  it("ends the sessions of a user on a new password or a block, and only those", async () => {
    const a = await createUser(ann());
    const b = await createUser(ann({ email: "bob@example.com" }));
    const ta = startSession(a.id, a.passwordHash)!.token;
    const tb = startSession(b.id, b.passwordHash)!.token;
    await setStatus(a.id, "active");
    expect(findSession(ta)).toBeDefined();
    await setStatus(a.id, "blocked");
    expect(findSession(ta)).toBeUndefined();
    expect(findSession(tb)).toBeDefined();
    const tb2 = startSession(b.id, b.passwordHash)!.token;
    await setPassword(b.id, "another-password-678");
    expect(findSession(tb)).toBeUndefined();
    expect(findSession(tb2)).toBeUndefined();
  });
});
