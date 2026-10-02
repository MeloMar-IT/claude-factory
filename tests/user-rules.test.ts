import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { readSessions } from "../src/auth/sessions.js";
import { createUser, getUser, hashPassword, listUsers, setPassword, setStatus, startSession, updateUser, usersPath, type UserError } from "../src/auth/users.js";

const PW = "test-password-12345";
let home: string;
let saved: string | undefined;
let goodHash: string;

beforeAll(async () => {
  goodHash = await hashPassword(PW);
});
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "user-rules-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const ann = (over: Record<string, unknown> = {}) => ({ name: "Ann", email: "ann@example.com", password: PW, ...over });
const record = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: "Ann",
  email: "ann@example.com",
  role: "admin",
  status: "active",
  passwordHash: goodHash,
  created: "2026-01-01T00:00:00.000Z",
  lastSignIn: null,
  ...over,
});
const put = (users: unknown[]) => writeFileSync(usersPath(), JSON.stringify({ version: 1, users }), { mode: 0o600 });
const code = async (p: Promise<unknown>) => await p.then(() => undefined, (e: UserError) => e.code);
const msg = async (p: Promise<unknown>) => await p.then(() => "", (e: Error) => e.message);
const bytes = () => readFileSync(usersPath());
const auditLines = () =>
  existsSync(auditPath())
    ? readFileSync(auditPath(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe("updateUser", () => {
  it("changes name, e-mail and role and keeps the rest", async () => {
    const u = await createUser(ann({ role: "admin" }));
    await createUser(ann({ email: "z@example.com", role: "admin" }));
    const now = await updateUser(u.id, { name: " Anna ", email: " ANNA@Example.com ", role: "user" });
    expect(now).toMatchObject({ name: "Anna", email: "anna@example.com", role: "user", id: u.id, status: "active", passwordHash: u.passwordHash });
    expect(now.created).toBe(u.created);
    expect(Object.keys(getUser(u.id)!)).toHaveLength(8);
    expect(statSync(usersPath()).mode & 0o777).toBe(0o600);
  });

  it("refuses bad input and changes nothing", async () => {
    const u = await createUser(ann({ role: "admin" }));
    await createUser(ann({ email: "b@example.com" }));
    const before = bytes();
    expect(await code(updateUser(u.id, { name: "" }))).toBe("bad-name");
    expect(await code(updateUser(u.id, { email: "nope" }))).toBe("bad-email");
    expect(await code(updateUser(u.id, { role: "root" as never }))).toBe("bad-role");
    expect(await code(updateUser(u.id, { email: "B@example.com" }))).toBe("email-taken");
    expect(await code(updateUser(randomUUID(), { name: "x" }))).toBe("not-found");
    expect(bytes()).toEqual(before);
    await updateUser(u.id, { email: "ANN@example.com" }); // its own e-mail in another case is fine
  });

  it("same values change nothing and write no line", async () => {
    const u = await createUser(ann({ role: "admin" }), { by: "cli" });
    const before = bytes();
    await updateUser(u.id, { name: "Ann", email: "ann@example.com", role: "admin" }, { by: "cli" });
    expect(bytes()).toEqual(before);
    expect(auditLines()).toHaveLength(1);
  });

  it("a no-op block touches no file", async () => {
    const id = randomUUID();
    put([record({ email: "a@example.com" }), record({ id, status: "blocked", role: "user", email: "b@example.com" })]);
    const sessions = join(home, "sessions.json");
    writeFileSync(sessions, JSON.stringify({ version: 1, sessions: [] }), { mode: 0o600 });
    const u = bytes();
    const s = readFileSync(sessions);
    await setStatus(id, "blocked", { by: "cli" });
    expect(bytes()).toEqual(u);
    expect(readFileSync(sessions)).toEqual(s);
    expect(auditLines()).toHaveLength(0);
  });

  it("a role change keeps sessions", async () => {
    const a = await createUser(ann({ role: "admin" }));
    await createUser(ann({ email: "b@example.com", role: "admin" }));
    startSession(a.id, a.passwordHash);
    await updateUser(a.id, { role: "user" });
    expect(readSessions()).toHaveLength(1);
  });
});

describe("the last admin", () => {
  it("cannot be demoted or blocked", async () => {
    const a = await createUser(ann({ role: "admin" }));
    startSession(a.id, a.passwordHash);
    const before = bytes();
    expect(await msg(updateUser(a.id, { role: "user" }))).toContain("make another admin first");
    expect(await code(setStatus(a.id, "blocked"))).toBe("last-admin");
    expect(bytes()).toEqual(before);
    expect(readSessions()).toHaveLength(1);
  });

  it("is not helped by a blocked second admin", async () => {
    const id = randomUUID();
    put([record({ id }), record({ email: "b@example.com", status: "blocked" })]);
    expect(await code(updateUser(id, { role: "user" }))).toBe("last-admin");
    expect(await code(setStatus(id, "blocked"))).toBe("last-admin");
  });

  it("two active admins: the first demotion works, the second is refused", async () => {
    const a = await createUser(ann({ role: "admin" }));
    const b = await createUser(ann({ email: "b@example.com", role: "admin" }));
    await updateUser(a.id, { role: "user" });
    expect(await code(updateUser(b.id, { role: "user" }))).toBe("last-admin");
  });

  it("a blocked admin can be demoted; unblock and promote always work", async () => {
    const bId = randomUUID();
    put([record({ email: "a@example.com" }), record({ id: bId, email: "b@example.com", status: "blocked" })]);
    await updateUser(bId, { role: "user" });
    await setStatus(bId, "active");
    await updateUser(bId, { role: "admin" });
  });

  it("a legacy file with only a blocked admin can unblock it", async () => {
    const id = randomUUID();
    put([record({ id, status: "blocked" })]);
    expect((await setStatus(id, "active")).status).toBe("active");
  });
});

describe("the audit log from the store", () => {
  it("one line per action, without personal data", async () => {
    const a = await createUser(ann({ role: "admin" }), { by: "cli" });
    const b = await createUser(ann({ email: "b@example.com", name: "Zebulon" }), { by: "cli" });
    await setPassword(b.id, "another-password-123", { by: "cli" });
    await updateUser(b.id, { role: "admin" }, { by: "cli" });
    await setStatus(b.id, "blocked", { by: "cli" });
    await setStatus(b.id, "active", { by: "cli" });
    const l = auditLines();
    expect(l.map((e) => e.action)).toEqual(["create", "create", "password", "role", "block", "unblock"]);
    expect(l[3]).toMatchObject({ oldRole: "user", newRole: "admin", userId: b.id });
    expect(l[0]!.userId).toBe(a.id);
    const text = readFileSync(auditPath(), "utf8");
    for (const w of ["Zebulon", "b@example.com", "scrypt$", "passwordHash", "another-password-123"]) expect(text).not.toContain(w);
  });

  it("name and e-mail changes write no line", async () => {
    const a = await createUser(ann({ role: "admin" }));
    await updateUser(a.id, { name: "New", email: "new@example.com" }, { by: "cli" });
    expect(auditLines()).toHaveLength(0);
  });

  it("failed actions write no line", async () => {
    const a = await createUser(ann({ role: "admin" }), { by: "cli" });
    expect(await code(setStatus(a.id, "blocked", { by: "cli" }))).toBe("last-admin");
    expect(await code(updateUser(a.id, { role: "user" }, { by: "cli" }))).toBe("last-admin");
    expect(await code(setStatus(randomUUID(), "blocked", { by: "cli" }))).toBe("not-found");
    expect(await code(setPassword(a.id, "short", { by: "cli" }))).toBe("bad-password");
    expect(await code(createUser(ann(), { by: "cli" }))).toBe("email-taken");
    expect(auditLines()).toHaveLength(1);
  });

  it("an unwritable log stops the change before it happens", async () => {
    const a = await createUser(ann({ role: "admin" }));
    const b = await createUser(ann({ email: "b@example.com", role: "admin" }));
    startSession(b.id, b.passwordHash);
    mkdirSync(auditPath());
    const before = bytes();
    const rejects = async (p: Promise<unknown>) =>
      expect(await p.then(() => undefined, (e: Error) => e)).toMatchObject({ kind: "cannot-write", message: expect.stringContaining("audit.jsonl") });
    await rejects(setStatus(b.id, "blocked", { by: "cli" }));
    await rejects(setPassword(b.id, "another-password-123", { by: "cli" }));
    await rejects(updateUser(a.id, { role: "user" }, { by: "cli" }));
    await rejects(createUser(ann({ email: "c@example.com" }), { by: "cli" }));
    expect(bytes()).toEqual(before);
    expect(readSessions()).toHaveLength(1);
    expect(listUsers()).toHaveLength(2);
    // without `by` nothing is logged, so it works
    await setStatus(b.id, "active");
    await setPassword(b.id, "another-password-123");
    await updateUser(a.id, { role: "user" });
  });

  it("loads a users.json in today's format unchanged", () => {
    const text = JSON.stringify({ version: 1, users: [record()] }, null, 2) + "\n";
    writeFileSync(usersPath(), text, { mode: 0o600 });
    expect(listUsers()).toHaveLength(1);
    expect(readFileSync(usersPath(), "utf8")).toBe(text);
  });
});

describe("setStatus with stopWork", () => {
  const blocks = () => auditLines().filter((l) => l.action === "block");
  const setup = () => {
    const b = record({ id: randomUUID(), email: "b@example.com", role: "user" });
    put([record({ email: "a@example.com" }), b]);
    return b.id;
  };

  it("follows the table", async () => {
    const b = setup();
    await setStatus(b, "blocked", { by: "cli" });
    expect(getUser(b)).toMatchObject({ status: "blocked" });
    expect(getUser(b)!.stopWork).toBeUndefined();
    expect(blocks().at(-1)!.stopWork).toBe(false);

    await setStatus(b, "active", { by: "cli" });
    await setStatus(b, "blocked", { by: "cli", stopWork: true });
    const first = getUser(b)!.stopWork;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(blocks().at(-1)!.stopWork).toBe(true);

    // the option on a blocked account is a new request
    await setStatus(b, "blocked", { by: "cli", stopWork: true });
    const second = getUser(b)!.stopWork;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(blocks().at(-1)!.stopWork).toBe(true);

    // a plain block of a blocked account changes nothing
    const before = bytes();
    await setStatus(b, "blocked", { by: "cli" });
    expect(bytes()).toEqual(before);

    // unblock removes a request that was not handled
    await setStatus(b, "active", { by: "cli" });
    expect(getUser(b)).toMatchObject({ status: "active" });
    expect(getUser(b)!.stopWork).toBeUndefined();
    // unblock of an active account is a no-op
    const now = bytes();
    await setStatus(b, "active", { by: "cli" });
    expect(bytes()).toEqual(now);
  });

  it("loads a file with stopWork and refuses one that is not a UUID", () => {
    const b = record({ id: randomUUID(), email: "b@example.com", role: "user", status: "blocked" });
    put([record({ email: "a@example.com" }), { ...b, stopWork: randomUUID() }]);
    expect(listUsers()[1]!.stopWork).toBeDefined();
    put([record({ email: "a@example.com" }), { ...b, stopWork: "later" }]);
    expect(() => listUsers()).toThrow();
  });
});
