import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { readSessions, sessionId, sessionsPath } from "../src/auth/sessions.js";
import { StoreError } from "../src/auth/store.js";
import {
  LINK_TTL_MS,
  checkSignIn,
  createUser,
  createUserWithLink,
  getUser,
  hashPassword,
  listUsers,
  newPasswordLink,
  redeemPasswordLink,
  setPassword,
  setStatus,
  startSession,
  deleteUser,
  updateUser,
  usersPath,
  type UserError,
} from "../src/auth/users.js";
import { startServer } from "../src/server/server.js";

const PW = "test-password-12345";
const PW2 = "test-other-password-678";
const DEAD = { error: "this link is not valid any more; ask your admin for a new one" };
const INTERNAL = { error: "sign-in is not working; see the server log" };
const BAD_LOGIN = { error: "wrong e-mail or password" };

let home: string;
let saved: string | undefined;
let goodHash: string;
beforeAll(async () => {
  goodHash = await hashPassword(PW);
});
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "password-link-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const bytes = () => readFileSync(usersPath());
const code = async (p: Promise<unknown>) => await p.then(() => undefined, (e: UserError) => e.code);
const rejection = async (p: Promise<unknown>) => await p.then(() => undefined, (e: Error) => e);
const audit = () =>
  existsSync(auditPath())
    ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const newcomer = (over: Record<string, unknown> = {}) => ({ name: "New", email: "new@example.com", ...over });
const record = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  name: "Ann",
  email: "ann@example.com",
  role: "user",
  status: "active",
  passwordHash: goodHash,
  created: "2026-01-01T00:00:00.000Z",
  lastSignIn: null,
  ...over,
});
const put = (users: unknown[]) => writeFileSync(usersPath(), JSON.stringify({ version: 1, users }), { mode: 0o600 });
const link = (over: Record<string, unknown> = {}) => ({ id: "a".repeat(64), expires: "2999-01-01T00:00:00.000Z", ...over });
const loadCode = () => {
  try {
    listUsers();
    return undefined;
  } catch (e) {
    return e instanceof StoreError ? e.kind : "other";
  }
};

describe("createUserWithLink", () => {
  it("returns a token and an end time, and stores only the hash of the token", async () => {
    const before = Date.now();
    const r = await createUserWithLink(newcomer());
    expect(LINK_TTL_MS).toBe(604800000);
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(r.expires) - before).toBeGreaterThanOrEqual(LINK_TTL_MS);
    expect(Date.parse(r.expires) - Date.now()).toBeLessThanOrEqual(LINK_TTL_MS);
    expect(r.user).not.toHaveProperty("passwordHash");
    expect(r.user).not.toHaveProperty("passwordLink");
    const raw = readFileSync(usersPath(), "utf8");
    expect(raw).toContain(sessionId(r.token));
    expect(raw).not.toContain(r.token);
    expect(listUsers()[0]!.passwordHash).toBeUndefined();
    expect(statSync(usersPath()).mode & 0o777).toBe(0o600);
    expect(audit()).toEqual([]);
  });

  it("checks its input and writes nothing on an error", async () => {
    expect(await code(createUserWithLink(newcomer({ name: " " })))).toBe("bad-name");
    expect(await code(createUserWithLink(newcomer({ email: "nope" })))).toBe("bad-email");
    expect(await code(createUserWithLink(newcomer({ role: "boss" })))).toBe("bad-role");
    expect(existsSync(usersPath())).toBe(false);
    await createUserWithLink(newcomer());
    const before = bytes();
    expect(await code(createUserWithLink(newcomer()))).toBe("email-taken");
    expect(await code(createUserWithLink(newcomer({ email: "NEW@Example.com" })))).toBe("email-taken");
    expect(bytes()).toEqual(before);
  });

  it("writes one `create` audit line with `by`", async () => {
    const r = await createUserWithLink(newcomer(), { by: "cli" });
    expect(audit()).toMatchObject([{ action: "create", by: "cli", userId: r.user.id }]);
  });

  it("makes an account that cannot sign in and cannot get a session", async () => {
    const r = await createUserWithLink(newcomer());
    expect(await checkSignIn("new@example.com", PW)).toBeUndefined();
    expect(await checkSignIn("new@example.com", "")).toBeUndefined();
    expect(startSession(r.user.id, undefined)).toBeUndefined();
    expect(readSessions()).toEqual([]);
  });
});

describe("redeemPasswordLink", () => {
  it("sets the password, removes the link and starts no session", async () => {
    const other = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
    startSession(other.id, other.passwordHash);
    const r = await createUserWithLink(newcomer());
    const sessions = readFileSync(sessionsPath());
    const user = await redeemPasswordLink(r.token, PW2);
    expect(user).toMatchObject({ id: r.user.id, email: "new@example.com" });
    expect(JSON.stringify(user)).not.toMatch(/scrypt\$|passwordLink|passwordHash/);
    const stored = getUser(r.user.id)!;
    expect(stored.passwordLink).toBeUndefined();
    expect(stored.lastSignIn).toBeNull();
    expect((await checkSignIn("new@example.com", PW2))?.id).toBe(r.user.id);
    expect(audit()).toMatchObject([{ action: "password", by: r.user.id, userId: r.user.id }]);
    expect(readFileSync(sessionsPath())).toEqual(sessions);
    expect(readSessions().some((s) => s.userId === r.user.id)).toBe(false);
  });

  it("answers undefined for a link that is not live, and changes nothing", async () => {
    const r = await createUserWithLink(newcomer());
    const before = bytes();
    const dead = async (token: unknown, now?: number) => {
      expect(await redeemPasswordLink(token as string, PW2, now)).toBeUndefined();
      expect(bytes()).toEqual(before);
    };
    await dead("");
    await dead(r.token.slice(0, 42));
    await dead("!".repeat(43));
    await dead(5);
    await dead(undefined);
    await dead("A".repeat(43));
    await dead(r.token, Date.parse(r.expires));
    // a bad password with a dead link is not an error
    await dead("A".repeat(43), undefined);
    expect(await redeemPasswordLink("A".repeat(43), "short")).toBeUndefined();
    const expires = Date.parse(r.expires);
    const user = await redeemPasswordLink(r.token, PW2, expires - 1);
    expect(user).toBeDefined();
  });

  it("is dead after use, after a new link, for a blocked or deleted account, and after setPassword", async () => {
    const a = await createUserWithLink(newcomer());
    expect(await redeemPasswordLink(a.token, PW2)).toBeDefined();
    const afterUse = bytes();
    expect(await redeemPasswordLink(a.token, PW2)).toBeUndefined();
    expect(bytes()).toEqual(afterUse);

    const b = await createUserWithLink(newcomer({ email: "b@example.com" }));
    const b2 = await newPasswordLink(b.user.id);
    expect(b2.token).not.toBe(b.token);
    expect(await redeemPasswordLink(b.token, PW2)).toBeUndefined();

    await setStatus(b.user.id, "blocked");
    const blocked = bytes();
    expect(await redeemPasswordLink(b2.token, PW2)).toBeUndefined();
    expect(bytes()).toEqual(blocked);
    await setStatus(b.user.id, "active");

    const c = await createUserWithLink(newcomer({ email: "c@example.com" }));
    await setPassword(c.user.id, PW);
    expect(await redeemPasswordLink(c.token, PW2)).toBeUndefined();

    const d = await createUserWithLink(newcomer({ email: "d@example.com" }));
    deleteUser(d.user.id);
    expect(await redeemPasswordLink(d.token, PW2)).toBeUndefined();

    expect(await redeemPasswordLink(b2.token, PW2)).toBeDefined();
  });

  it("rejects a bad password with a live link, and the link still works", async () => {
    const r = await createUserWithLink(newcomer());
    const before = bytes();
    expect(await code(redeemPasswordLink(r.token, "short"))).toBe("bad-password");
    expect(await code(redeemPasswordLink(r.token, 5 as unknown as string))).toBe("bad-password");
    expect(bytes()).toEqual(before);
    expect(await redeemPasswordLink(r.token, PW2)).toBeDefined();
  });

  it("lets exactly one of two calls at once succeed", async () => {
    const r = await createUserWithLink(newcomer());
    const results = await Promise.all([redeemPasswordLink(r.token, PW2), redeemPasswordLink(r.token, PW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("newPasswordLink and setPassword", () => {
  it("gives a new token, refuses an account with a password and an unknown account", async () => {
    const r = await createUserWithLink(newcomer());
    const n = await newPasswordLink(r.user.id);
    expect(n.token).not.toBe(r.token);
    expect(n.user).not.toHaveProperty("passwordLink");
    expect(audit()).toEqual([]);
    await newPasswordLink(r.user.id, { by: "cli" });
    expect(audit()).toMatchObject([{ action: "link", by: "cli", userId: r.user.id }]);
    const withPassword = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
    expect(await code(newPasswordLink(withPassword.id))).toBe("has-password");
    expect(await code(newPasswordLink(randomUUID()))).toBe("not-found");
  });

  it("is allowed for a blocked account", async () => {
    const r = await createUserWithLink(newcomer());
    await setStatus(r.user.id, "blocked");
    expect((await newPasswordLink(r.user.id)).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("setPassword on an account without a password sets the hash and removes the link", async () => {
    const r = await createUserWithLink(newcomer());
    await setPassword(r.user.id, PW2);
    const u = getUser(r.user.id)!;
    expect(u.passwordHash).toBeDefined();
    expect(u.passwordLink).toBeUndefined();
    expect((await checkSignIn("new@example.com", PW2))?.id).toBe(r.user.id);
  });
});

describe("the last admin", () => {
  it("does not count an admin that has no password yet", async () => {
    const a = await createUser({ name: "A", email: "a@example.com", password: PW, role: "admin" });
    const b = await createUserWithLink(newcomer({ role: "admin" }));
    expect(await code(setStatus(a.id, "blocked"))).toBe("last-admin");
    expect(await code(updateUser(a.id, { role: "user" }))).toBe("last-admin");
    expect(() => deleteUser(a.id)).toThrow(/only admin/);
    deleteUser(b.user.id);
    const c = await createUserWithLink(newcomer({ email: "c@example.com", role: "admin" }));
    expect(await code(updateUser(a.id, { role: "user" }))).toBe("last-admin");
    await redeemPasswordLink(c.token, PW2);
    expect((await updateUser(a.id, { role: "user" })).role).toBe("user");
  });
});

describe("an audit log that cannot be opened", () => {
  const rejects = async (p: Promise<unknown>) =>
    expect(await rejection(p)).toMatchObject({ kind: "cannot-write", message: expect.stringContaining("audit.jsonl") });

  it("stops creation", async () => {
    mkdirSync(auditPath());
    await rejects(createUserWithLink(newcomer(), { by: "cli" }));
    expect(listUsers()).toEqual([]);
    rmSync(auditPath(), { recursive: true });
    await createUserWithLink(newcomer(), { by: "cli" });
    expect(listUsers()).toHaveLength(1);
  });

  it("stops a new link; the earlier token still works", async () => {
    const r = await createUserWithLink(newcomer());
    mkdirSync(auditPath());
    const before = bytes();
    await rejects(newPasswordLink(r.user.id, { by: "cli" }));
    expect(bytes()).toEqual(before);
    rmSync(auditPath(), { recursive: true });
    expect(await redeemPasswordLink(r.token, PW2)).toBeDefined();
  });

  it("stops a redeem; the same token still works", async () => {
    const r = await createUserWithLink(newcomer());
    mkdirSync(auditPath());
    const before = bytes();
    await rejects(redeemPasswordLink(r.token, PW2));
    expect(bytes()).toEqual(before);
    rmSync(auditPath(), { recursive: true });
    expect(await redeemPasswordLink(r.token, PW2)).toBeDefined();
  });

  it("does not matter without `by`", async () => {
    mkdirSync(auditPath());
    const r = await createUserWithLink(newcomer());
    await newPasswordLink(r.user.id);
  });
});

describe("the file format", () => {
  it("loads today's format unchanged", () => {
    put([record()]);
    const before = bytes();
    expect(listUsers()).toHaveLength(1);
    expect(bytes()).toEqual(before);
  });

  it("accepts an account without a hash, with or without a link", () => {
    put([record({ passwordHash: undefined, passwordLink: link() }), record({ email: "b@example.com", passwordHash: undefined })]);
    expect(loadCode()).toBeUndefined();
  });

  it("rejects a bad link, a hash with a link and a link id used twice", () => {
    const none = { passwordHash: undefined };
    put([record({ ...none, passwordLink: link({ id: "xyz" }) })]);
    expect(loadCode()).toBe("wrong-format");
    put([record({ ...none, passwordLink: link({ expires: "tomorrow" }) })]);
    expect(loadCode()).toBe("wrong-format");
    put([record({ ...none, passwordLink: { ...link(), extra: 1 } })]);
    expect(loadCode()).toBe("wrong-format");
    put([record({ passwordLink: link() })]);
    expect(loadCode()).toBe("wrong-format");
    put([record({ ...none, passwordLink: link() }), record({ ...none, email: "b@example.com", passwordLink: link() })]);
    expect(loadCode()).toBe("wrong-format");
  });
});

describe("where secrets may be", () => {
  it("keeps the token, the link id and hashes out of results, the audit log and users.json", async () => {
    const r = await createUserWithLink(newcomer(), { by: "cli" });
    const id = sessionId(r.token);
    expect(JSON.stringify(r.user)).not.toMatch(/scrypt\$/);
    expect(JSON.stringify(r.user)).not.toContain(r.token);
    expect(JSON.stringify(r.user)).not.toContain(id);
    expect(JSON.stringify(r)).not.toContain(id);
    const n = await newPasswordLink(r.user.id, { by: "cli" });
    await redeemPasswordLink(n.token, PW2);
    const log = readFileSync(auditPath(), "utf8");
    for (const t of [r.token, n.token, id, sessionId(n.token), "scrypt$"]) expect(log).not.toContain(t);
    const file = readFileSync(usersPath(), "utf8");
    expect(file).not.toContain(r.token);
    expect(file).not.toContain(n.token);
  });
});

// ---- HTTP ------------------------------------------------------------------------------------------

interface Srv {
  base: string;
  logs: string[];
  close: () => void;
}

async function boot(): Promise<Srv> {
  const logs: string[] = [];
  const opts = { repo: home, runsDir: join(home, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m: string) => void logs.push(m) };
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const started = await startServer({ ...opts, port });
      return { base: `http://127.0.0.1:${port}`, logs, close: started.close };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
    }
  }
}

/** Every response (headers and body) of the current test, and every secret it created. */
let recorded: string[] = [];
let secrets: string[] = [];
const send = async (url: string, init: RequestInit) => {
  const res = await fetch(url, init);
  recorded.push(JSON.stringify([...res.headers.entries()]), await res.clone().text());
  return res;
};
const post = (s: Srv, path: string, body: unknown, headers: Record<string, string> = {}) =>
  send(s.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
/** createUserWithLink that remembers the token and the link id as secrets. */
const mk = async (...args: Parameters<typeof createUserWithLink>) => {
  const r = await createUserWithLink(...args);
  secrets.push(r.token, sessionId(r.token));
  return r;
};
const setPw = (s: Srv, token: unknown, password: unknown = PW2, headers: Record<string, string> = {}) => post(s, "/api/set-password", { token, password }, headers);
const signIn = (s: Srv, email: string, password: string) => post(s, "/api/session", { email, password });
/** The status, body and cookies of a response, for comparing two answers. */
const shape = async (r: Response) => ({ status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() });

describe("POST /api/set-password", () => {
  let s: Srv;
  beforeEach(async () => {
    recorded = [];
    secrets = [PW, PW2, "wrong-password-123", "scrypt$"];
    s = await boot();
  });
  afterEach(() => {
    // no response body, header or log line of the test holds a token, a link id, a password or a hash
    for (const text of [...recorded, ...s.logs]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    s.close();
  });

  const editLink = (token: string, patch: Record<string, unknown>) => {
    const json = JSON.parse(readFileSync(usersPath(), "utf8"));
    for (const u of json.users) if (u.passwordLink?.id === sessionId(token)) Object.assign(u.passwordLink, patch);
    writeFileSync(usersPath(), JSON.stringify(json));
  };

  it("sets the password without a session, then the person can sign in", async () => {
    const r = await mk(newcomer());
    const res = await setPw(s, r.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(existsSync(sessionsPath())).toBe(false);
    const login = await signIn(s, "new@example.com", PW2);
    expect(login.status).toBe(200);
  });

  it("answers sign-in to an account without a password like a wrong password", async () => {
    await mk(newcomer());
    await createUser({ name: "Bob", email: "bob@example.com", password: PW });
    const a = await shape(await signIn(s, "new@example.com", PW));
    const b = await shape(await signIn(s, "bob@example.com", "wrong-password-123"));
    expect(a).toEqual(b);
    expect(a).toEqual({ status: 401, body: BAD_LOGIN, cookies: [] });
  });

  it("clears the wrong tries of the e-mail when the link is used", async () => {
    const r = await mk(newcomer());
    for (let i = 0; i < 10; i++) expect((await signIn(s, "new@example.com", "wrong-password-123")).status).toBe(401);
    expect(await shape(await signIn(s, "new@example.com", "wrong-password-123"))).toEqual({
      status: 429,
      body: { error: "too many wrong tries; wait 15 minutes" },
      cookies: [],
    });
    // a dead token does not clear the count
    expect((await setPw(s, "A".repeat(43))).status).toBe(400);
    expect((await signIn(s, "new@example.com", PW2)).status).toBe(429);
    expect((await setPw(s, r.token)).status).toBe(200);
    expect((await signIn(s, "new@example.com", PW2)).status).toBe(200);
  });

  it("answers every dead link the same way", async () => {
    const r = await mk(newcomer());
    const used = await mk(newcomer({ email: "used@example.com" }));
    expect((await setPw(s, used.token)).status).toBe(200);
    const expired = await mk(newcomer({ email: "expired@example.com" }));
    editLink(expired.token, { expires: new Date(Date.now() - 1000).toISOString() });
    const replaced = await mk(newcomer({ email: "replaced@example.com" }));
    await newPasswordLink(replaced.user.id);
    const blocked = await mk(newcomer({ email: "blocked@example.com" }));
    await setStatus(blocked.user.id, "blocked");
    const gone = await mk(newcomer({ email: "gone@example.com" }));
    deleteUser(gone.user.id);
    const tokens: unknown[] = [undefined, null, 5, "", "   ", r.token.slice(0, 42), "!".repeat(43), "A".repeat(43), used.token, expired.token, replaced.token, blocked.token, gone.token];
    for (const token of tokens) {
      const body = token === undefined ? { password: PW2 } : { token, password: "short" };
      const res = await post(s, "/api/set-password", body);
      expect(res.status, String(token)).toBe(400);
      expect(await res.json(), String(token)).toEqual(DEAD);
    }
    expect((await setPw(s, r.token)).status).toBe(200);
  });

  it("checks the password input, and a short password keeps the link", async () => {
    const r = await mk(newcomer());
    for (const body of [{ token: r.token }, { token: r.token, password: 5 }]) {
      const res = await post(s, "/api/set-password", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: `"password" must be a string` });
    }
    const short = await setPw(s, r.token, "short");
    expect(short.status).toBe(400);
    expect((await short.json()).error).toContain("10 to 200 characters");
    expect((await setPw(s, r.token)).status).toBe(200);
  });

  it("refuses text/plain and a foreign origin", async () => {
    const r = await mk(newcomer());
    const plain = await send(s.base + "/api/set-password", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: r.token, password: PW2 }) });
    expect(plain.status).toBe(415);
    expect((await setPw(s, r.token, PW2, { origin: "http://evil.example" })).status).toBe(403);
    expect((await setPw(s, r.token)).status).toBe(200);
  });

  it("counts every try per client, shared with sign-in", async () => {
    for (let i = 0; i < 60; i++) expect((await setPw(s, "A".repeat(43))).status).toBe(400);
    const res = await setPw(s, "A".repeat(43));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many tries; wait 15 minutes" });
    expect((await signIn(s, "x@example.com", PW)).status).toBe(429);
  });

  it("answers 500 when users.json cannot be written, and the link is not used up", async () => {
    const r = await mk(newcomer());
    mkdirSync(`${usersPath()}.tmp`);
    const res = await setPw(s, r.token);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(INTERNAL);
    expect(s.logs.some((l) => l.includes("users.json cannot-write"))).toBe(true);
    rmSync(`${usersPath()}.tmp`, { recursive: true });
    expect((await setPw(s, r.token)).status).toBe(200);
  });

  it("leaks no secret in any answer or log line (checked after every test; this one also fails and succeeds)", async () => {
    const r = await mk(newcomer());
    await setPw(s, r.token, "short");
    await setPw(s, r.token);
    await setPw(s, r.token);
    expect(recorded.length).toBeGreaterThan(0);
  });
});
