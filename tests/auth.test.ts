import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditEntrySchema } from "../src/auth/audit.js";
import { findSession, readSessions, revokeSession, revokeUserSessions, sessionId } from "../src/auth/sessions.js";
import { createUser, hasAdmin, listUsers, setPassword, setStatus, startSession } from "../src/auth/users.js";
import { SESSION_RECHECK_MS, SignInLimiter } from "../src/server/api-auth.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { TEST_PASSWORD, signInAs, type TestSession } from "./helpers/session.js";

const PW = TEST_PASSWORD;
const INTERNAL = { error: "sign-in is not working; see the server log" };
const DAY = 24 * 60 * 60 * 1000;

interface Srv {
  base: string;
  port: number;
  home: string;
  logs: string[];
  ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  close: () => void;
  /** Closes the server and starts a new one on the same port and folder. */
  restart: () => Promise<void>;
}

async function listen(opts: Omit<ServerOptions, "port">, port?: number) {
  for (let i = 0; ; i++) {
    const p = port ?? 20000 + Math.floor(Math.random() * 20000);
    try {
      return { port: p, started: await startServer({ ...opts, port: p }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      await new Promise((r) => setTimeout(r, port ? 50 : 0));
    }
  }
}

/** A real server on a new data folder (made current through FACTORY_HOME). */
async function boot(extra: Partial<ServerOptions> = {}): Promise<Srv> {
  const tmp = mkdtempSync(join(tmpdir(), "factory-auth-"));
  const home = join(tmp, "home");
  process.env.FACTORY_HOME = home;
  const logs: string[] = [];
  const opts = { repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, sessionRecheckMs: 100, log: (m: string) => void logs.push(m), ...extra };
  const first = await listen(opts);
  const s: Srv = {
    base: `http://127.0.0.1:${first.port}`,
    port: first.port,
    home,
    logs,
    ctx: first.started.ctx,
    close: () => {
      closeCurrent();
      rmSync(tmp, { recursive: true, force: true });
    },
    restart: async () => {
      closeCurrent();
      const again = await listen(opts, first.port);
      s.ctx = again.started.ctx;
      closeCurrent = again.started.close;
    },
  };
  let closeCurrent = first.started.close;
  return s;
}

/** Registers a server for a `describe`; the object is filled in before the first test. */
function useServer(extra: Partial<ServerOptions> = {}): Srv {
  const s = {} as Srv;
  beforeAll(async () => void Object.assign(s, await boot(extra)));
  afterAll(() => s.close());
  return s;
}

/** A server on its own folder for one test. */
async function withServer(fn: (s: Srv) => Promise<void>, extra: Partial<ServerOptions> = {}) {
  const before = process.env.FACTORY_HOME;
  const s = await boot(extra);
  try {
    await fn(s);
  } finally {
    s.close();
    process.env.FACTORY_HOME = before;
  }
}

const post = (s: Srv, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(s.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const login = (s: Srv, email: string, password: string, headers: Record<string, string> = {}) => post(s, "/api/session", { email, password }, headers);
const get = (s: Srv, path: string, who?: TestSession) => fetch(s.base + path, { headers: who ? who.headers() : {} });
const status = async (s: Srv, who: TestSession | undefined, path = "/api/info") => (await get(s, path, who)).status;
let counter = 0;
const newUser = (s: Srv) => signInAs(s.base, { name: "User", email: `user-${++counter}@example.com` });

const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const editSessions = (s: Srv, token: string, patch: Record<string, unknown>) => {
  const file = join(s.home, "sessions.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  for (const x of json.sessions) if (x.id === sessionId(token)) Object.assign(x, patch);
  writeFileSync(file, JSON.stringify(json));
};
const expire = (s: Srv, token: string) => editSessions(s, token, { created: iso(-8 * DAY), expires: iso(-DAY) });

describe("every route needs a session", () => {
  const s = useServer();
  let who: TestSession;
  beforeAll(async () => void (who = await signInAs(s.base)));

  const GETS = ["/api/credentials", "/api/repos", "/api/info", "/api/config", "/api/watchers", "/api/providers", "/api/evals", "/api/stats", "/api/flows", "/api/flows/x", "/api/blocks", "/api/queue", "/api/runs", "/api/runs/x", "/api/runs/x/events", "/api/runs/x/diff", "/api/runs/x/transcript/0", "/api/next", "/api/your-turn", "/api/since", "/api/board", "/api/nope", "/api/setup", "/api/set-password"];
  const PUTS = ["/api/config", "/api/flows/x", "/api/blocks/x", "/api/session", "/api/repos/x/auth", "/api/set-password"];
  const DELETES = ["/api/credentials/x", "/api/repos/a/b", "/api/repos/x", "/api/flows/x", "/api/blocks/x", "/api/set-password"];
  const POSTS = ["/api/credentials", "/api/repos", "/api/watchers/x/tick", "/api/clean", "/api/providers/test", "/api/validate", "/api/generate", "/api/runs", "/api/runs/x/cancel", "/api/runs/x/resume", "/api/runs/x/approve", "/api/runs/x/reject", "/api/your-turn/dismiss", "/api/your-turn/restore", "/api/nope"];
  const table = [...GETS.map((p) => ["GET", p]), ...PUTS.map((p) => ["PUT", p]), ...DELETES.map((p) => ["DELETE", p]), ...POSTS.map((p) => ["POST", p])] as [string, string][];

  const cases: [string, Record<string, string>][] = [
    ["no cookie", {}],
    ["an unknown cookie", {}],
    ["a valid token under another port's cookie name", {}],
  ];
  it.each(cases)("answers 401 to every route and method with %s", async (name, extra) => {
    const headers: Record<string, string> = { ...extra };
    if (name === "an unknown cookie") headers.cookie = `scf_session_${s.port}=${"A".repeat(43)}`;
    if (name.startsWith("a valid token")) headers.cookie = `scf_session_${s.port + 1}=${who.token}`;
    for (const [method, path] of table) {
      const r = await fetch(s.base + path, {
        method,
        headers: method === "GET" || method === "DELETE" ? headers : { ...headers, "content-type": "application/json" },
        body: method === "POST" || method === "PUT" ? "{}" : undefined,
      });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(await r.json(), `${method} ${path}`).toEqual({ error: "sign in first" });
    }
  });

  it("serves static files without a session", async () => {
    for (const p of ["/", "/app.js", "/auth.js", "/style.css", "/vendor/yaml/index.js"]) expect((await fetch(s.base + p)).status, p).toBe(200);
  });

  it("the same routes work with a session", async () => {
    expect(await status(s, who)).toBe(200);
    expect((await fetch(s.base + "/api/nope", { headers: who.headers() })).status).toBe(404);
  });
});

describe("setup", () => {
  const s = useServer();
  const good = { name: "Ann", email: "ann@example.com", password: PW };
  let cookie = "";

  it("says setup is needed while there is no admin", async () => {
    const r = await get(s, "/api/session");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ user: null, setupNeeded: true });
  });

  it("refuses bad input and a wrong content type", async () => {
    for (const bad of [{ ...good, name: "" }, { ...good, email: "nope" }, { ...good, password: "short" }, { email: "a@example.com" }]) {
      expect((await post(s, "/api/setup", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const r = await fetch(s.base + "/api/setup", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(good) });
    expect(r.status).toBe(415);
    expect(hasAdmin()).toBe(false);
  });

  it("creates the first admin and signs in with the exact cookie", async () => {
    const r = await post(s, "/api/setup", good);
    expect(r.status).toBe(201);
    const set = r.headers.getSetCookie();
    expect(set).toHaveLength(1);
    const m = set[0]!.match(/^scf_session_(\d+)=([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect(m?.[1]).toBe(String(s.port));
    cookie = `scf_session_${s.port}=${m![2]}`;
    const body = (await r.json()) as { user: Record<string, unknown>; csrfToken: string };
    expect(Object.keys(body).sort()).toEqual(["csrfToken", "user"]);
    expect(Object.keys(body.user).sort()).toEqual(["email", "id", "name", "role"]);
    expect(body.user).toMatchObject({ name: "Ann", email: "ann@example.com", role: "admin" });
    expect(findSession(m![2])).toBeDefined();
  });

  it("answers 409 afterwards, and setupNeeded is false", async () => {
    const r = await post(s, "/api/setup", { ...good, email: "other@example.com" });
    expect(r.status).toBe(409);
    expect(listUsers()).toHaveLength(1);
    const session = (await (await fetch(s.base + "/api/session", { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(session.setupNeeded).toBe(false);
    expect(Object.keys(session).sort()).toEqual(["csrfToken", "setupNeeded", "user"]);
    expect(Object.keys(session.user as object).sort()).toEqual(["email", "id", "name", "role"]);
    expect((await get(s, "/api/session")).status).toBe(200);
    expect(await (await get(s, "/api/session")).json()).toEqual({ user: null, setupNeeded: false });
  });
});

describe("setup with a password of only spaces", () => {
  it("creates the admin, who can then sign in", async () => {
    await withServer(async (s) => {
      const spaces = " ".repeat(10);
      expect((await post(s, "/api/setup", { name: "Ann", email: "ann@example.com", password: " ".repeat(9) })).status).toBe(400);
      expect((await post(s, "/api/setup", { name: "Ann", email: "ann@example.com", password: spaces })).status).toBe(201);
      expect((await login(s, "ann@example.com", spaces)).status).toBe(200);
    });
  });
});

describe("sign-in", () => {
  const s = useServer();
  let who: TestSession;
  beforeAll(async () => void (who = await signInAs(s.base)));

  it("gives the same answer for a wrong password and an unknown e-mail", async () => {
    const wrong = await login(s, who.user.email, "not-the-password-1");
    const unknown = await login(s, "nobody@example.com", "not-the-password-1");
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual({ error: "wrong e-mail or password" });
    expect(await unknown.json()).toEqual({ error: "wrong e-mail or password" });
    expect(wrong.headers.getSetCookie()).toEqual([]);
  });

  it("answers 200 with the exact keys, and the e-mail is not case sensitive", async () => {
    const r = await login(s, who.user.email.toUpperCase(), PW);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { user: object };
    expect(Object.keys(body).sort()).toEqual(["csrfToken", "user"]);
    expect(Object.keys(body.user).sort()).toEqual(["email", "id", "name", "role"]);
    expect(r.headers.getSetCookie()[0]).toMatch(/^scf_session_\d+=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
  });

  it("makes a new token and ends the session of the cookie it came with", async () => {
    const first = await newUser(s);
    const r = await login(s, first.user.email, PW, { cookie: first.cookie });
    expect(r.status).toBe(200);
    const token = r.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!;
    expect(token).not.toBe(first.token);
    expect(await status(s, first)).toBe(401);
    expect((await fetch(s.base + "/api/info", { headers: { cookie: `scf_session_${s.port}=${token}` } })).status).toBe(200);
  });

  it("signs in with a password of only spaces, as `scf user` allows", async () => {
    const spaces = " ".repeat(10);
    await createUser({ name: "Space", email: "space@example.com", password: spaces, role: "user" });
    expect((await login(s, "space@example.com", spaces)).status).toBe(200);
    expect((await login(s, "space@example.com", " ".repeat(11))).status).toBe(401);
    expect((await post(s, "/api/session", { email: "space@example.com" })).status).toBe(400);
    expect((await post(s, "/api/session", { email: "space@example.com", password: 5 })).status).toBe(400);
  });

  it("refuses a foreign origin on sign-in and setup", async () => {
    for (const path of ["/api/session", "/api/setup", "/api/set-password"]) {
      const r = await post(s, path, { email: who.user.email, password: PW, name: "x" }, { origin: "http://evil.example" });
      expect(r.status, path).toBe(403);
      expect(r.headers.getSetCookie()).toEqual([]);
    }
  });
});

describe("CSRF", () => {
  const s = useServer();
  let a: TestSession;
  let b: TestSession;
  beforeAll(async () => {
    a = await newUser(s);
    b = await newUser(s);
  });
  const validate = (headers: Record<string, string>) => fetch(s.base + "/api/validate", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ yaml: "name: x\nsteps: []" }) });

  it("needs the matching token on a call that writes", async () => {
    expect((await validate({ cookie: a.cookie })).status).toBe(403);
    expect((await validate({ cookie: a.cookie, "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await validate({ cookie: a.cookie, "x-csrf-token": b.csrf })).status).toBe(403);
    expect((await validate(a.headers("POST"))).status).toBe(200);
  });

  it("answers 403, not an error, for a non-ASCII token of the right length", async () => {
    const odd = "é".repeat(a.csrf.length);
    expect((await validate({ cookie: a.cookie, "x-csrf-token": odd })).status).toBe(403);
    const out = await fetch(s.base + "/api/session", { method: "DELETE", headers: { cookie: a.cookie, "x-csrf-token": odd } });
    expect(out.status).toBe(403);
    expect(await status(s, a)).toBe(200);
  });

  it("needs none on a GET", async () => {
    expect((await fetch(s.base + "/api/info", { headers: { cookie: a.cookie } })).status).toBe(200);
  });

  it("gives the token back on GET /api/session", async () => {
    const r = (await (await get(s, "/api/session", a)).json()) as { csrfToken: string };
    expect(r.csrfToken).toBe(a.csrf);
  });

  it("sign-out needs the token, and always clears the cookie", async () => {
    const c = await newUser(s);
    const without = await fetch(s.base + "/api/session", { method: "DELETE", headers: { cookie: c.cookie } });
    expect(without.status).toBe(403);
    expect(await status(s, c)).toBe(200);

    const out = await fetch(s.base + "/api/session", { method: "DELETE", headers: c.headers("DELETE") });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie()).toEqual([`scf_session_${s.port}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`]);
    expect(await status(s, c)).toBe(401);
    expect(readSessions().some((x) => x.id === sessionId(c.token))).toBe(false);

    const none = await fetch(s.base + "/api/session", { method: "DELETE" });
    expect(none.status).toBe(200);
    expect(none.headers.getSetCookie()[0]).toContain("Max-Age=0");
  });
});

describe("a session ends", () => {
  const s = useServer();
  const ends: [string, (who: TestSession) => unknown][] = [
    ["revokeSession", (w) => revokeSession(sessionId(w.token))],
    ["revokeUserSessions", (w) => revokeUserSessions(w.user.id)],
    ["a block", (w) => setStatus(w.user.id, "blocked")],
    ["a password change", (w) => setPassword(w.user.id, "another-password-123")],
    ["expiry", (w) => expire(s, w.token)],
  ];
  it.each(ends)("answers 401 after %s", async (_n, end) => {
    const who = await newUser(s);
    expect(await status(s, who)).toBe(200);
    await end(who);
    expect(await status(s, who)).toBe(401);
    expect(await (await get(s, "/api/session", who)).json()).toEqual({ user: null, setupNeeded: false });
  });

  it("revoking one session leaves the user's others", async () => {
    const one = await newUser(s);
    const other = await signInAs(s.base, { email: one.user.email });
    revokeSession(sessionId(one.token));
    expect(await status(s, one)).toBe(401);
    expect(await status(s, other)).toBe(200);
  });

  it("a session that has not expired yet still works", async () => {
    const who = await newUser(s);
    editSessions(s, who.token, { created: iso(-6 * DAY), expires: iso(DAY) });
    expect(await status(s, who)).toBe(200);
  });

  it("a blocked account cannot sign in; unblocking allows it again", async () => {
    const who = await newUser(s);
    await setStatus(who.user.id, "blocked");
    expect((await login(s, who.user.email, PW)).status).toBe(403);
    expect((await login(s, who.user.email, "wrong-password-123")).status).toBe(401);
    await setStatus(who.user.id, "active");
    expect((await login(s, who.user.email, PW)).status).toBe(200);
  });

  it("startSession with an old hash makes no session", async () => {
    const who = await newUser(s);
    const before = listUsers().find((u) => u.id === who.user.id)!.passwordHash;
    await setPassword(who.user.id, "another-password-123");
    const count = readSessions().length;
    expect(startSession(who.user.id, before)).toBeUndefined();
    expect(readSessions()).toHaveLength(count);
  });

  it("a schema-invalid sessions.json answers 401", async () => {
    const who = await newUser(s);
    expect(await status(s, who)).toBe(200);
    const file = join(s.home, "sessions.json");
    const good = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ version: 1, sessions: [{ id: "nope", userId: "x", created: "y", expires: "z" }] }));
    expect(await status(s, who)).toBe(401);
    writeFileSync(file, "{ not json");
    expect(await status(s, who)).toBe(401);
    writeFileSync(file, good);
    expect(await status(s, who)).toBe(200);
  });
});

describe("a session survives a server restart", () => {
  const s = useServer();
  it("keeps working on the new server", async () => {
    const who = await newUser(s);
    await s.restart();
    expect(await status(s, who)).toBe(200);
  });
});

describe("an open stream", () => {
  const s = useServer();

  const cases: [string, (who: TestSession) => Promise<unknown> | unknown][] = [
    ["sign-out", (w) => fetch(s.base + "/api/session", { method: "DELETE", headers: w.headers("DELETE") })],
    ["revoke", (w) => revokeSession(sessionId(w.token))],
    ["a password change", (w) => setPassword(w.user.id, "another-password-123")],
    ["a block", (w) => setStatus(w.user.id, "blocked")],
    ["expiry", (w) => expire(s, w.token)],
  ];

  /**
   * Opens the log stream of a run that does not exist. The route sends nothing until the first event or ping, so the
   * response does not arrive yet: `ended` settles when the server cut the connection (a failed fetch or a finished read).
   */
  function openStream(srv: Srv, who: TestSession) {
    const abort = new AbortController();
    const ended = fetch(srv.base + "/api/runs/none/events", { headers: who.headers(), signal: abort.signal }).then(
      async (r) => {
        const reader = r.body!.getReader();
        try {
          for (;;) if ((await reader.read()).done) return;
        } catch {
          // the connection was cut
        }
      },
      () => undefined,
    );
    return { ended, abort: () => abort.abort() };
  }
  const settlesWithin = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  /** Counts subscribe and unsubscribe calls of the scheduler. */
  const spy = (srv: Srv) => {
    const counts = { subscribed: 0, unsubscribed: 0 };
    const original = srv.ctx.scheduler.subscribe.bind(srv.ctx.scheduler);
    vi.spyOn(srv.ctx.scheduler, "subscribe").mockImplementation((id, fn) => {
      counts.subscribed++;
      const off = original(id, fn);
      return () => {
        counts.unsubscribed++;
        off();
      };
    });
    return counts;
  };

  it.each(cases)("is closed after %s", async (_n, end) => {
    const who = await newUser(s);
    const counts = spy(s);
    const stream = openStream(s, who);
    await vi.waitFor(() => expect(counts.subscribed).toBe(1));
    await end(who);
    expect(await settlesWithin(stream.ended, 2000)).toBe(true);
    await vi.waitFor(() => expect(counts.unsubscribed).toBe(1));
    vi.restoreAllMocks();
  });

  it("is closed within 5 seconds at the default interval", async () => {
    expect(SESSION_RECHECK_MS).toBeLessThan(5000);
    await withServer(async (d) => {
      const who = await newUser(d);
      const counts = spy(d);
      const stream = openStream(d, who);
      await vi.waitFor(() => expect(counts.subscribed).toBe(1));
      const started = Date.now();
      revokeSession(sessionId(who.token));
      expect(await settlesWithin(stream.ended, 5000)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      vi.restoreAllMocks();
    }, { sessionRecheckMs: undefined });
  }, 8000);

  it("stays open while the session lives", async () => {
    const who = await newUser(s);
    const counts = spy(s);
    const stream = openStream(s, who);
    await vi.waitFor(() => expect(counts.subscribed).toBe(1));
    expect(await settlesWithin(stream.ended, 600)).toBe(false);
    expect(counts.unsubscribed).toBe(0);
    stream.abort();
    await vi.waitFor(() => expect(counts.unsubscribed).toBe(1));
    vi.restoreAllMocks();
  });
});

describe("the sign-in limit", () => {
  it("answers 429 after 10 wrong tries for one e-mail, not for another", async () => {
    await withServer(async (s) => {
      const a = await newUser(s);
      const b = await newUser(s);
      for (let i = 0; i < 10; i++) expect((await login(s, a.user.email, "wrong-password-123")).status).toBe(401);
      expect((await login(s, a.user.email, PW)).status).toBe(429);
      expect((await login(s, b.user.email, PW)).status).toBe(200);
    });
  });

  it("lets only 10 tries through when they arrive at the same time", async () => {
    await withServer(async (s) => {
      const a = await newUser(s);
      const answers = await Promise.all(Array.from({ length: 16 }, () => login(s, a.user.email, "wrong-password-123")));
      const codes = answers.map((r) => r.status);
      expect(codes.filter((c) => c === 401)).toHaveLength(10);
      expect(codes.filter((c) => c === 429)).toHaveLength(6);
      expect((await login(s, a.user.email, PW)).status).toBe(429);
    });
  });

  it("limits one client that cycles e-mail addresses, and refuses over-long ones", async () => {
    await withServer(async (s) => {
      expect((await login(s, `${"a".repeat(300)}@example.com`, "x")).status).toBe(401);
      for (let i = 0; i < 60; i++) expect((await login(s, `nobody-${i}@example.com`, "wrong-password-123")).status).toBe(401);
      expect((await login(s, "nobody-last@example.com", "wrong-password-123")).status).toBe(429);
    });
  });

  it("a right password clears the count", async () => {
    await withServer(async (s) => {
      const a = await newUser(s);
      for (let i = 0; i < 9; i++) await login(s, a.user.email, "wrong-password-123");
      expect((await login(s, a.user.email, PW)).status).toBe(200);
      for (let i = 0; i < 9; i++) expect((await login(s, a.user.email, "wrong-password-123")).status).toBe(401);
    });
  });

  it("SignInLimiter: the window ends, clear works, and the cap evicts the oldest", () => {
    let now = 1000;
    const l = new SignInLimiter(2, 100, 3, () => now);
    l.fail("a");
    expect(l.blocked("a")).toBe(false);
    l.fail("a");
    expect(l.blocked("a")).toBe(true);
    now += 100;
    expect(l.blocked("a")).toBe(false);
    l.fail("a");
    l.fail("a");
    l.clear("a");
    expect(l.blocked("a")).toBe(false);

    const small = new SignInLimiter(1, 1000, 3, () => now);
    for (const k of ["a", "b", "c", "d"]) small.fail(k);
    expect(["a", "b", "c", "d"].map((k) => small.blocked(k))).toEqual([false, true, true, true]);
  });
});

describe("internal errors give a plain 500", () => {
  const expect500 = async (r: Response, s: Srv) => {
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual(INTERNAL);
    expect(text).not.toContain(s.home);
    expect(text).not.toContain("scrypt$");
  };
  const logged = (s: Srv, file: string, kind: string) => {
    expect(s.logs.some((l) => l.includes(file) && l.includes(kind)), s.logs.join("\n")).toBe(true);
    for (const l of s.logs) expect(l).not.toContain(PW);
  };
  const replaceWithFolder = (path: string) => {
    rmSync(path, { force: true });
    mkdirSync(path);
  };

  it("users.json is a folder", async () => {
    await withServer(async (s) => {
      const who = await newUser(s);
      replaceWithFolder(join(s.home, "users.json"));
      await expect500(await login(s, who.user.email, PW), s);
      await expect500(await get(s, "/api/session"), s);
      await expect500(await get(s, "/api/info", who), s);
      logged(s, "users.json", "unreadable");
    });
  });

  it("sessions.json is a folder", async () => {
    await withServer(async (s) => {
      const who = await newUser(s);
      replaceWithFolder(join(s.home, "sessions.json"));
      await expect500(await login(s, who.user.email, PW), s);
      await expect500(await get(s, "/api/info", who), s);
      logged(s, "sessions.json", "unreadable");
    });
  });

  it("sessions.json.tmp is a folder: no session and no cookie", async () => {
    await withServer(async (s) => {
      await createUser({ name: "Ann", email: "ann@example.com", password: PW, role: "admin" });
      mkdirSync(join(s.home, "sessions.json.tmp"));
      const r = await login(s, "ann@example.com", PW);
      await expect500(r, s);
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(readSessions()).toEqual([]);
      logged(s, "sessions.json", "cannot-write");
    });
  });

  it("users.json.tmp is a folder: sign-in and setup fail cleanly", async () => {
    await withServer(async (s) => {
      await createUser({ name: "Ann", email: "ann@example.com", password: PW, role: "admin" });
      mkdirSync(join(s.home, "users.json.tmp"));
      const r = await login(s, "ann@example.com", PW);
      await expect500(r, s);
      expect(r.headers.getSetCookie()).toEqual([]);
      logged(s, "users.json", "cannot-write");
    });
    await withServer(async (s) => {
      mkdirSync(s.home, { recursive: true });
      mkdirSync(join(s.home, "users.json.tmp"));
      const r = await post(s, "/api/setup", { name: "Ann", email: "ann@example.com", password: PW });
      await expect500(r, s);
      expect(r.headers.getSetCookie()).toEqual([]);
      expect(listUsers()).toEqual([]);
    });
  });

  it("auth.lock is held", async () => {
    await withServer(async (s) => {
      await createUser({ name: "Ann", email: "ann@example.com", password: PW, role: "admin" });
      const lock = join(s.home, "auth.lock");
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      try {
        const quick = Date.now();
        expect((await login(s, "ann@example.com", "not-the-password-1")).status).toBe(401);
        expect(Date.now() - quick).toBeLessThan(1000);
        expect(s.logs).toContain("auth: audit.jsonl cannot-write");
        expect(existsSync(join(s.home, "audit.jsonl"))).toBe(false);
        const started = Date.now();
        await expect500(await login(s, "ann@example.com", PW), s);
        expect(Date.now() - started).toBeGreaterThan(1500);
        logged(s, "auth.lock", "locked");
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    });
  }, 10_000);
});

describe("no secret in a response or a log line", () => {
  it("never shows the password or a hash", async () => {
    await withServer(async (s) => {
      const seen: string[] = [];
      const keep = async (r: Response) => {
        seen.push(await r.clone().text(), ...r.headers.getSetCookie(), JSON.stringify([...r.headers]));
        return r;
      };
      await keep(await post(s, "/api/setup", { name: "Ann", email: "ann@example.com", password: PW }));
      await keep(await post(s, "/api/setup", { name: "Ann", email: "ann@example.com", password: PW }));
      await keep(await login(s, "ann@example.com", "wrong-password-123"));
      const ok = await keep(await login(s, "ann@example.com", PW));
      const who = await signInAs(s.base);
      await keep(await get(s, "/api/session", who));
      await keep(await get(s, "/api/info", who));
      await keep(await fetch(s.base + "/api/session", { method: "DELETE", headers: who.headers("DELETE") }));
      expect(ok.status).toBe(200);
      replaceWithFolder();
      await keep(await login(s, "ann@example.com", PW));

      const stored = listUsers()[0]!.passwordHash!;
      for (const text of [...seen, ...s.logs]) {
        expect(text).not.toContain(PW);
        expect(text).not.toContain("wrong-password-123");
        expect(text).not.toContain("scrypt$");
        expect(text).not.toContain(stored.split("$").at(-1)!);
      }
      function replaceWithFolder() {
        const p = join(s.home, "sessions.json");
        rmSync(p, { force: true });
        mkdirSync(p);
      }
    });
  });
});

describe("sign-ins in the audit log", () => {
  const auditLines = (s: Srv) => {
    const file = join(s.home, "audit.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  const signIns = (s: Srv) => auditLines(s).filter((l) => l.action === "sign-in");
  const ann = { name: "Ann", email: "ann@example.com", password: PW };

  it("writes an ok line with by and userId set to the account id", () =>
    withServer(async (s) => {
      const u = await createUser({ ...ann, role: "user" });
      expect((await login(s, "ANN@example.com", PW)).status).toBe(200);
      const lines = signIns(s);
      expect(lines).toHaveLength(1);
      expect(Object.keys(lines[0]!)).toEqual(["time", "by", "action", "result", "userId"]);
      expect(lines[0]).toMatchObject({ by: u.id, userId: u.id, action: "sign-in", result: "ok" });
    }));

  it("writes one failed line for a wrong password (with userId) and one for an unknown e-mail (without)", () =>
    withServer(async (s) => {
      const u = await createUser({ ...ann, role: "user" });
      expect((await login(s, ann.email, "not-the-password-1")).status).toBe(401);
      expect((await login(s, "nobody@example.com", "not-the-password-1")).status).toBe(401);
      const [wrong, unknown] = signIns(s);
      expect(signIns(s)).toHaveLength(2);
      expect(Object.keys(wrong!)).toEqual(["time", "by", "action", "result", "userId"]);
      expect(wrong).toMatchObject({ by: "anonymous", result: "failed", userId: u.id });
      expect(Object.keys(unknown!)).toEqual(["time", "by", "action", "result"]);
      expect(unknown).toMatchObject({ by: "anonymous", result: "failed" });
    }));

  it("writes a failed line with userId for a blocked account", () =>
    withServer(async (s) => {
      const u = await createUser({ ...ann, role: "user" });
      await setStatus(u.id, "blocked");
      expect((await login(s, ann.email, PW)).status).toBe(403);
      expect((await login(s, ann.email, "not-the-password-1")).status).toBe(401);
      const lines = signIns(s);
      expect(lines).toHaveLength(2);
      for (const l of lines) expect(l).toMatchObject({ by: "anonymous", result: "failed", userId: u.id });
    }));

  it("writes no line for bad requests, an over-long e-mail or a 429", () =>
    withServer(async (s) => {
      await createUser({ ...ann, role: "user" });
      await post(s, "/api/session", { email: ann.email });
      await post(s, "/api/session", { email: ann.email, password: 5 });
      await login(s, "x".repeat(300) + "@example.com", PW);
      expect(signIns(s)).toHaveLength(0);
      for (let i = 0; i < 10; i++) await login(s, ann.email, "not-the-password-1");
      expect(signIns(s)).toHaveLength(10);
      expect((await login(s, ann.email, "not-the-password-1")).status).toBe(429);
      expect(signIns(s)).toHaveLength(10);
    }));

  it("writes a create line at setup, and no sign-in line", () =>
    withServer(async (s) => {
      const r = await post(s, "/api/setup", ann);
      expect(r.status).toBe(201);
      const body = (await r.json()) as { user: { id: string } };
      expect(auditLines(s)).toHaveLength(1);
      const line = auditLines(s)[0]!;
      expect(Object.keys(line)).toEqual(["time", "by", "action", "userId"]);
      expect(line).toMatchObject({ action: "create", by: body.user.id, userId: body.user.id });
      expect((await post(s, "/api/setup", ann)).status).toBe(409);
      expect(auditLines(s)).toHaveLength(1);
    }));

  it("lets a sign-in work when audit.jsonl cannot be written, and logs only file and kind", () =>
    withServer(async (s) => {
      await createUser({ ...ann, role: "admin" });
      mkdirSync(join(s.home, "audit.jsonl"));
      const ok = await login(s, ann.email, PW);
      expect(ok.status).toBe(200);
      const cookie = ok.headers.getSetCookie()[0]!.split(";")[0]!;
      expect((await fetch(s.base + "/api/info", { headers: { cookie } })).status).toBe(200);
      expect((await login(s, ann.email, "not-the-password-1")).status).toBe(401);
      expect(s.logs.filter((l) => l === "auth: audit.jsonl cannot-write")).toHaveLength(2);
      for (const l of s.logs) for (const bad of [s.home, ann.email, PW]) expect(l).not.toContain(bad);
    }));

  it("stops setup with a 500 when audit.jsonl cannot be opened", () =>
    withServer(async (s) => {
      mkdirSync(join(s.home, "audit.jsonl"));
      expect((await post(s, "/api/setup", ann)).status).toBe(500);
      expect(listUsers()).toEqual([]);
    }));

  it("holds no secret in any line", () =>
    withServer(async (s) => {
      await post(s, "/api/setup", ann);
      const u = await createUser({ name: "Bea", email: "bea@example.com", password: PW, role: "user" });
      await setStatus(u.id, "blocked");
      const ok = await login(s, ann.email, PW);
      const token = ok.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!;
      await login(s, ann.email, "not-the-password-1");
      await login(s, "nobody@example.com", "not-the-password-1");
      await login(s, "bea@example.com", PW);
      const text = readFileSync(join(s.home, "audit.jsonl"), "utf8");
      const allowed = new Set(["anonymous", "sign-in", "create", "ok", "failed"]);
      for (const line of text.split("\n").filter(Boolean)) {
        expect(AuditEntrySchema.safeParse(JSON.parse(line)).success).toBe(true);
        for (const [k, v] of Object.entries(JSON.parse(line) as Record<string, string>)) {
          if (k !== "time") expect(allowed.has(v) || /^[0-9a-f-]{36}$/.test(v), `${k}=${v}`).toBe(true);
        }
      }
      for (const bad of [PW, "scrypt$", token, sessionId(token), "ann@example.com", "bea@example.com", "nobody@example.com", "Ann", "Bea"]) {
        expect(text).not.toContain(bad);
      }
    }));
});
