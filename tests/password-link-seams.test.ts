// Wraps two built-ins so the tests can count and hold password hashes and fail one audit append. Everything else is real.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
  calls: [] as { N: unknown; r: unknown; p: unknown; maxmem: unknown; keylen: number; saltLen: number }[],
  running: 0,
  peak: 0,
  hold: false,
  held: [] as (() => void)[],
  failNextWrite: false,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const scrypt = (password: unknown, salt: Buffer, keylen: number, options: Record<string, unknown>, cb: (e: Error | null, k: Buffer) => void) => {
    probe.calls.push({ N: options.N, r: options.r, p: options.p, maxmem: options.maxmem, keylen, saltLen: salt.length });
    probe.running++;
    probe.peak = Math.max(probe.peak, probe.running);
    const run = () =>
      (actual.scrypt as (...a: unknown[]) => void)(password, salt, keylen, options, (e: Error | null, k: Buffer) => {
        probe.running--;
        cb(e, k);
      });
    if (probe.hold) probe.held.push(run);
    else run();
  };
  return { ...actual, scrypt, default: { ...actual, scrypt } };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeSync = (...args: Parameters<typeof actual.writeSync>) => {
    if (probe.failNextWrite) {
      probe.failNextWrite = false;
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    }
    return actual.writeSync(...args);
  };
  return { ...actual, writeSync, default: { ...actual, writeSync } };
});

const { auditPath } = await import("../src/auth/audit.js");
const { addSession, readSessions, sessionId } = await import("../src/auth/sessions.js");
const { changePassword, checkSignIn, createUser, createUserWithLink, getUser, newPasswordLink, redeemPasswordLink, resetPassword, usersPath } = await import(
  "../src/auth/users.js"
);
const { startServer } = await import("../src/server/server.js");

const PW = "test-password-12345";
const PW2 = "test-other-password-678";
const INTERNAL = { error: "sign-in is not working; see the server log" };
const BUSY = { error: "the server is busy; try again in a moment" };

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "password-link-seams-"));
  process.env.FACTORY_HOME = home;
  probe.calls.length = 0;
  probe.running = probe.peak = 0;
  probe.hold = false;
  probe.held.length = 0;
  probe.failNextWrite = false;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const newcomer = (email = "new@example.com") => ({ name: "New", email });
const rejection = async (p: Promise<unknown>) => await p.then(() => undefined, (e: Error) => e);
const auditLines = () => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean);
const wrote = { kind: "cannot-write", message: expect.stringMatching(/audit\.jsonl.*change was made/) };

describe("the wrapper reaches the store", () => {
  it("counts one scrypt for one checkSignIn", async () => {
    await checkSignIn("nobody@example.com", PW);
    expect(probe.calls).toHaveLength(1);
  });
});

describe("exactly one scrypt", () => {
  it("is the same for an unknown e-mail, a wrong password and an account without a password", async () => {
    await createUser({ name: "Bob", email: "bob@example.com", password: PW });
    await createUserWithLink(newcomer());
    probe.calls.length = 0;
    const sets: unknown[] = [];
    for (const [email, password] of [["nobody@example.com", PW], ["bob@example.com", "wrong-password-123"], ["new@example.com", PW]] as const) {
      probe.calls.length = 0;
      expect(await checkSignIn(email, password)).toBeUndefined();
      expect(probe.calls).toHaveLength(1);
      sets.push(probe.calls[0]);
    }
    expect(sets[1]).toEqual(sets[0]);
    expect(sets[2]).toEqual(sets[0]);
  });

  it("is none for a dead link and one for a live link", async () => {
    const r = await createUserWithLink(newcomer());
    expect(await redeemPasswordLink("A".repeat(43), PW2)).toBeUndefined();
    expect(probe.calls).toHaveLength(0);
    expect(await redeemPasswordLink(r.token, PW2)).toBeDefined();
    expect(probe.calls).toHaveLength(1);
  });
});

describe("audit line fails after the change", () => {
  it("createUserWithLink: the account exists, and a new link works", async () => {
    probe.failNextWrite = true;
    expect(await rejection(createUserWithLink(newcomer(), { by: "cli" }))).toMatchObject(wrote);
    const user = (await import("../src/auth/users.js")).listUsers()[0]!;
    expect(user.passwordHash).toBeUndefined();
    const n = await newPasswordLink(user.id);
    expect(await redeemPasswordLink(n.token, PW2)).toBeDefined();
  });

  it("newPasswordLink: the earlier token is dead and a second call works", async () => {
    const r = await createUserWithLink(newcomer());
    probe.failNextWrite = true;
    expect(await rejection(newPasswordLink(r.user.id, { by: "cli" }))).toMatchObject(wrote);
    expect(await redeemPasswordLink(r.token, PW2)).toBeUndefined();
    const n = await newPasswordLink(r.user.id, { by: "cli" });
    expect(await redeemPasswordLink(n.token, PW2)).toBeDefined();
  });

  it("redeemPasswordLink: the password is set and the link is gone", async () => {
    const r = await createUserWithLink(newcomer());
    probe.failNextWrite = true;
    expect(await rejection(redeemPasswordLink(r.token, PW2))).toMatchObject(wrote);
    expect(getUser(r.user.id)!.passwordLink).toBeUndefined();
    expect((await checkSignIn("new@example.com", PW2))?.id).toBe(r.user.id);
    expect(await redeemPasswordLink(r.token, PW2)).toBeUndefined();
  });

  it("resetPassword: no password, a stored link, no sessions; a new link works", async () => {
    const u = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
    addSession(u.id);
    addSession(u.id);
    probe.failNextWrite = true;
    expect(await rejection(resetPassword(u.id, { by: "cli" }))).toMatchObject(wrote);
    const after = getUser(u.id)!;
    expect(after.passwordHash).toBeUndefined();
    expect(after.passwordLink).toBeDefined();
    expect(readSessions().filter((x) => x.userId === u.id)).toHaveLength(0);
    expect(await checkSignIn("bob@example.com", PW)).toBeUndefined();
    const n = await newPasswordLink(u.id);
    expect(await redeemPasswordLink(n.token, PW2)).toBeDefined();
    expect((await checkSignIn("bob@example.com", PW2))?.id).toBe(u.id);
  });

  it("changePassword: the new password works, the kept session stays, the others are gone", async () => {
    const u = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
    const keep = addSession(u.id);
    addSession(u.id);
    probe.failNextWrite = true;
    expect(await rejection(changePassword(u.id, PW, PW2, { keepSession: sessionId(keep) }))).toMatchObject(wrote);
    expect((await checkSignIn("bob@example.com", PW2))?.id).toBe(u.id);
    expect(await checkSignIn("bob@example.com", PW)).toBeUndefined();
    expect(readSessions().map((x) => x.id)).toEqual([sessionId(keep)]);
  });
});

// ---- HTTP ------------------------------------------------------------------------------------------

async function boot() {
  const logs: string[] = [];
  const opts = { repo: home, runsDir: join(home, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m: string) => void logs.push(m), signInClock: () => 1_800_000_000_000 };
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
type Srv = Awaited<ReturnType<typeof boot>>;
const post = (s: Srv, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(s.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
/** A client address (the server trusts these headers from loopback). */
const from = (n: number) => ({ "x-forwarded-proto": "https", "x-forwarded-for": `10.0.0.${n}` });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

describe("over HTTP", () => {
  let s: Srv;
  beforeEach(async () => void (s = await boot()));
  afterEach(() => s.close());

  it("sign-in to an account without a password makes one scrypt", async () => {
    await createUserWithLink(newcomer());
    probe.calls.length = 0;
    expect((await post(s, "/api/session", { email: "new@example.com", password: PW })).status).toBe(401);
    expect(probe.calls).toHaveLength(1);
  });

  it("runs at most 16 hashes at once and refuses the rest as busy", async () => {
    const links = await Promise.all(Array.from({ length: 20 }, (_, i) => createUserWithLink(newcomer(`u${i}@example.com`))));
    probe.hold = true;
    const answers: { status: number; body: unknown; token: string }[] = [];
    const sends = links.map((l, i) =>
      post(s, "/api/set-password", { token: l.token, password: PW2 }, from(i + 1)).then(async (r) => void answers.push({ status: r.status, body: await r.json(), token: l.token })),
    );
    await until(() => probe.held.length === 16 && answers.length === 4);
    expect(answers.every((a) => a.status === 429 && JSON.stringify(a.body) === JSON.stringify(BUSY))).toBe(true);
    expect(probe.peak).toBe(16);
    const login = await post(s, "/api/session", { email: "u0@example.com", password: PW });
    expect(login.status).toBe(429);
    expect(await login.json()).toEqual(BUSY);
    const refused = answers.map((a) => a.token);
    probe.hold = false;
    for (const run of probe.held.splice(0)) run();
    await Promise.all(sends);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(16);
    for (const token of refused) expect((await post(s, "/api/set-password", { token, password: PW2 })).status).toBe(200);
    expect(probe.peak).toBe(16);
  });

  it("holds 5 hashes for 16 live links from one address and refuses 11 with the wait text", async () => {
    const links = await Promise.all(Array.from({ length: 16 }, (_, i) => createUserWithLink(newcomer(`u${i}@example.com`))));
    probe.hold = true;
    const answers: { status: number; body: unknown; token: string }[] = [];
    const sends = links.map((l) =>
      post(s, "/api/set-password", { token: l.token, password: PW2 }, from(1)).then(async (r) => void answers.push({ status: r.status, body: await r.json(), token: l.token })),
    );
    await until(() => probe.held.length === 5 && answers.length === 11);
    await new Promise((r) => setTimeout(r, 100));
    expect(probe.held).toHaveLength(5);
    expect(answers.every((a) => a.status === 429 && JSON.stringify(a.body) === JSON.stringify({ error: "too many tries; try again in 1 second" }))).toBe(true);
    const refused = answers.map((a) => a.token);
    probe.hold = false;
    for (const run of probe.held.splice(0)) run();
    await Promise.all(sends);
    expect(answers.filter((a) => a.status === 200)).toHaveLength(5);
    for (const token of refused) expect((await post(s, "/api/set-password", { token, password: PW2 }, from(1))).status).toBe(200);
  });

  it("answers 500 when the audit line fails, and the chosen password works", async () => {
    const r = await createUserWithLink(newcomer());
    probe.failNextWrite = true;
    const res = await post(s, "/api/set-password", { token: r.token, password: PW2 });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(INTERNAL);
    expect(s.logs).toContain("auth: audit.jsonl cannot-write");
    expect((await post(s, "/api/session", { email: "new@example.com", password: PW2 })).status).toBe(200);
    for (const t of [text, ...s.logs, auditLines().join("\n"), readFileSync(usersPath(), "utf8")]) {
      for (const secret of [r.token, sessionId(r.token), PW2]) expect(t).not.toContain(secret);
    }
  });
});
