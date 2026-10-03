import { timingSafeEqual } from "node:crypto";
import { basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adoptRuns } from "../auth/run-owner.js";
import { createUser, checkSignIn, getUser, hasAdmin, redeemPasswordLink, startSession, UserError, type User } from "../auth/users.js";
import { SESSION_TTL_MS, csrfToken, findSession, revokeSession, sessionId } from "../auth/sessions.js";
import { StoreError } from "../auth/store.js";
import { homeMoved } from "../home.js";
import { HttpError, readJson, send, str } from "./http.js";
import { isLoopback, requestAccess } from "./net.js";
import type { ApiContext } from "./server.js";

/** How often an open response re-checks its session (it must be gone within 5 seconds). */
export const SESSION_RECHECK_MS = 4000;

const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_ENTRIES = 1000;

/** Counts failed sign-ins per e-mail, in memory. At most `cap` entries; the oldest go first. */
export class SignInLimiter {
  private entries = new Map<string, { count: number; since: number }>();
  constructor(
    private limit = FAIL_LIMIT,
    private windowMs = FAIL_WINDOW_MS,
    private cap = FAIL_ENTRIES,
    private now: () => number = Date.now,
  ) {}
  private live(key: string) {
    const e = this.entries.get(key);
    if (e && this.now() - e.since >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }
  blocked(key: string): boolean {
    return (this.live(key)?.count ?? 0) >= this.limit;
  }
  fail(key: string): void {
    const e = this.live(key);
    if (e) {
      e.count++;
      return;
    }
    this.entries.set(key, { count: 1, since: this.now() });
    while (this.entries.size > this.cap) this.entries.delete(this.entries.keys().next().value as string);
  }
  clear(key: string): void {
    this.entries.delete(key);
  }
}

const limiters = new WeakMap<ApiContext, SignInLimiter>();
const limiterOf = (ctx: ApiContext) => limiters.get(ctx) ?? limiters.set(ctx, new SignInLimiter()).get(ctx)!;
/** A second limit per client address (every try counts), so cycling e-mail addresses does not get around the per-e-mail one. */
const CLIENT_TRY_LIMIT = 60;
const clientLimiters = new WeakMap<ApiContext, SignInLimiter>();
const clientLimiterOf = (ctx: ApiContext) => clientLimiters.get(ctx) ?? clientLimiters.set(ctx, new SignInLimiter(CLIENT_TRY_LIMIT)).get(ctx)!;
/** At most this many password checks (scrypt) run at the same time. */
const MAX_CHECKS = 16;
let checking = 0;
const MAX_EMAIL = 254;

/** The caller's address. X-Forwarded-For counts only when the connection comes from the proxy on this Mac. */
function clientKey(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const fwd = req.headers["x-forwarded-for"];
  if (isLoopback(peer) && typeof fwd === "string") return fwd.split(",").pop()!.trim().slice(0, 64) || peer;
  return peer;
}
const BAD_LOGIN = "wrong e-mail or password";
const INTERNAL = "sign-in is not working; see the server log";

/**
 * Runs auth code. Input errors and HttpErrors pass through; everything else is logged (file and kind, never a value)
 * and answered with a plain 500.
 */
async function guarded<T>(ctx: ApiContext, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const log = ctx.opts.log;
    if (e instanceof StoreError) log?.(`auth: ${basename(e.file)} ${e.kind}`);
    else log?.(`auth: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

const cookieName = (ctx: ApiContext) => `scf_session_${ctx.opts.port}`;
const COOKIE_ATTRS = "HttpOnly; SameSite=Strict; Path=/";

function cookieToken(ctx: ApiContext, req: IncomingMessage): string | undefined {
  const name = cookieName(ctx);
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

const accessOf = (ctx: ApiContext, req: IncomingMessage) => requestAccess(req, ctx.config().server, ctx.opts.port);
/** `Secure` only when the browser reached us over HTTPS (through the proxy). */
const secure = (ctx: ApiContext, req: IncomingMessage) => (accessOf(ctx, req).https ? "; Secure" : "");

const setCookie = (ctx: ApiContext, req: IncomingMessage, res: ServerResponse, token: string) =>
  res.setHeader("set-cookie", `${cookieName(ctx)}=${token}; ${COOKIE_ATTRS}; Max-Age=${SESSION_TTL_MS / 1000}${secure(ctx, req)}`);
const clearCookie = (ctx: ApiContext, req: IncomingMessage, res: ServerResponse) =>
  res.setHeader("set-cookie", `${cookieName(ctx)}=; ${COOKIE_ATTRS}; Max-Age=0${secure(ctx, req)}`);

interface Current {
  token: string;
  user: User;
}

/** The signed-in account of a request, or undefined. A session of a missing or blocked account does not count. */
function currentSession(ctx: ApiContext, req: IncomingMessage): Current | undefined {
  const token = cookieToken(ctx, req);
  const session = findSession(token);
  if (!token || !session) return undefined;
  const user = getUser(session.userId);
  return user && user.status === "active" ? { token, user } : undefined;
}

/** What the browser may know about the account: never the hash. */
const publicFields = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const sessionBody = (c: Current) => ({ user: publicFields(c.user), csrfToken: csrfToken(c.token) });

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A password exactly as sent: no trimming, and spaces count. The password policy decides what is allowed. */
function passwordOf(body: Record<string, unknown>): string {
  const v = body.password;
  if (typeof v !== "string") throw new HttpError(400, `"password" must be a string`);
  return v;
}

/** Passes with a session (and a matching CSRF token unless the call only reads) and gives the account. Else 401 or 403. */
export async function requireSession(ctx: ApiContext, req: IncomingMessage, method: string): Promise<User> {
  const cur = await guarded(ctx, () => currentSession(ctx, req));
  if (!cur) throw new HttpError(401, "sign in first");
  if (method === "GET" || method === "HEAD") return cur.user;
  const sent = req.headers["x-csrf-token"];
  if (typeof sent !== "string" || !sameToken(sent, csrfToken(cur.token))) throw new HttpError(403, "bad CSRF token");
  return cur.user;
}

/** The signed-in account of a request (call after requireSession). */
export function sessionUser(ctx: ApiContext, req: IncomingMessage): User {
  const cur = currentSession(ctx, req);
  if (!cur) throw new HttpError(401, "sign in first");
  return cur.user;
}

/** True while the request still has a live session; false when it ended or the store cannot be read. */
export function sessionAlive(ctx: ApiContext, req: IncomingMessage): boolean {
  try {
    return currentSession(ctx, req) !== undefined;
  } catch {
    return false;
  }
}

function notMoved() {
  if (homeMoved()) throw new HttpError(503, "the data folder moved; the server restarts onto it — try again in a minute");
}

async function signIn(ctx: ApiContext, req: IncomingMessage, res: ServerResponse) {
  notMoved();
  const body = await readJson(req);
  const limiter = limiterOf(ctx);
  const email = str(body, "email").trim().toLowerCase();
  const password = passwordOf(body);
  // Nothing long is kept or hashed: an over-long address is simply a wrong sign-in.
  if (email.length > MAX_EMAIL) throw new HttpError(401, BAD_LOGIN);
  const clients = clientLimiterOf(ctx);
  const client = clientKey(req);
  if (clients.blocked(client)) throw new HttpError(429, "too many tries; wait 15 minutes");
  if (checking >= MAX_CHECKS) throw new HttpError(429, "the server is busy; try again in a moment");
  if (limiter.blocked(email)) throw new HttpError(429, "too many wrong tries; wait 15 minutes");
  // Count the try before the slow password check: requests that run at the same time must not all pass the limit.
  // A matching password gives the try back (below).
  limiter.fail(email);
  clients.fail(client);
  checking++;
  await guarded(ctx, async () => {
    const user = await checkSignIn(email, password).finally(() => checking--);
    if (!user) throw new HttpError(401, BAD_LOGIN);
    if (user.status === "blocked") {
      limiter.clear(email);
      throw new HttpError(403, "this account is blocked");
    }
    const old = cookieToken(ctx, req);
    const started = startSession(user.id, user.passwordHash, old ? sessionId(old) : undefined);
    if (!started) throw new HttpError(401, BAD_LOGIN);
    limiter.clear(email);
    setCookie(ctx, req, res, started.token);
    send(res, 200, sessionBody({ token: started.token, user: started.user }));
  });
}

const DEAD_LINK = "this link is not valid any more; ask your admin for a new one";

/** Sets the first password with a one-time link. No session. Every token that is not a live link gets the same answer. */
async function setPasswordWithLink(ctx: ApiContext, req: IncomingMessage, res: ServerResponse) {
  notMoved();
  const body = await readJson(req);
  const password = passwordOf(body);
  const token = typeof body.token === "string" ? body.token : "";
  const clients = clientLimiterOf(ctx);
  const client = clientKey(req);
  if (clients.blocked(client)) throw new HttpError(429, "too many tries; wait 15 minutes");
  if (checking >= MAX_CHECKS) throw new HttpError(429, "the server is busy; try again in a moment");
  clients.fail(client);
  checking++;
  await guarded(ctx, async () => {
    let user;
    try {
      user = await redeemPasswordLink(token, password).finally(() => checking--);
    } catch (e) {
      if (e instanceof UserError) throw new HttpError(400, e.message);
      throw e;
    }
    if (!user) throw new HttpError(400, DEAD_LINK);
    limiterOf(ctx).clear(user.email); // the wrong tries before the first password must not lock out the first sign-in
    send(res, 200, { ok: true });
  });
}

async function setup(ctx: ApiContext, req: IncomingMessage, res: ServerResponse) {
  notMoved();
  if (!accessOf(ctx, req).local) throw new HttpError(403, "the first account can only be created on the Mac itself");
  const body = await readJson(req);
  const name = str(body, "name");
  const email = str(body, "email");
  const password = passwordOf(body);
  const taken = new HttpError(409, "an admin account exists already");
  await guarded(ctx, async () => {
    if (hasAdmin()) throw taken;
    let user: User;
    try {
      user = await createUser({ name, email, password, role: "admin" }, { onlyIfNoAdmin: true });
    } catch (e) {
      if (e instanceof UserError) throw e.code === "admin-exists" ? taken : new HttpError(400, e.message);
      throw e;
    }
    const started = startSession(user.id, user.passwordHash);
    if (!started) throw new Error("no session after setup");
    setCookie(ctx, req, res, started.token);
    try {
      adoptRuns(ctx.opts.runsDir, ctx.opts.log); // runs of older versions have no owner: the first admin takes them
    } catch {
      ctx.opts.log?.("! could not give runs to the first admin; the server tries again later"); // the account exists: setup succeeded
    }
    send(res, 201, sessionBody({ token: started.token, user: started.user }));
  });
}

/** The routes that need no session: GET/POST/DELETE /api/session, POST /api/setup and POST /api/set-password. */
export async function authRoutes(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string): Promise<boolean> {
  if (seg.length !== 1) return false;
  // Readiness for the supervisor after an update: no session, answered only to a program on this machine, says nothing.
  if (seg[0] === "ready" && method === "GET") {
    if (!isLoopback(req.socket.remoteAddress) || req.headers["x-forwarded-for"] !== undefined) throw new HttpError(404, "not found");
    return send(res, 200, { ok: true }), true;
  }
  if (seg[0] === "setup" && method === "POST") return await setup(ctx, req, res), true;
  if (seg[0] === "set-password" && method === "POST") return await setPasswordWithLink(ctx, req, res), true;
  if (seg[0] !== "session") return false;
  if (method === "GET") {
    await guarded(ctx, () => {
      const cur = currentSession(ctx, req);
      send(res, 200, { user: cur ? publicFields(cur.user) : null, ...(cur ? { csrfToken: csrfToken(cur.token) } : {}), setupNeeded: !hasAdmin() });
    });
    return true;
  }
  if (method === "POST") return await signIn(ctx, req, res), true;
  if (method === "DELETE") {
    notMoved();
    await guarded(ctx, () => {
      const cur = currentSession(ctx, req);
      if (cur) {
        const sent = req.headers["x-csrf-token"];
        if (typeof sent !== "string" || !sameToken(sent, csrfToken(cur.token))) throw new HttpError(403, "bad CSRF token");
        revokeSession(sessionId(cur.token));
      }
      clearCookie(ctx, req, res);
      send(res, 200, { ok: true });
    });
    return true;
  }
  return false;
}
