import { basename } from "node:path";
import { StoreError } from "../auth/store.js";
import {
  UserError, checkEmail, checkName, createUserWithLink, deleteUser, listUsers, newPasswordLink, setStatus, updateUser, type PublicUser, type UserErrorCode,
} from "../auth/users.js";
import { KeyError } from "../credentials/keychain.js";
import { cancelAccountNow } from "./account-work.js";
import { OLD_KEY_LEFT } from "./api-credentials.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

const INTERNAL = "the account list is not working; see the server log";
const STATUS: Record<UserErrorCode, number> = {
  "bad-name": 400, "bad-email": 400, "bad-password": 400, "bad-role": 400, "email-taken": 409, "admin-exists": 409, "not-found": 404, "last-admin": 409, "has-password": 409,
};

/** Turns an error into a 4xx for input problems; anything else is logged (file and kind, never a path or value) and answered with a plain 500. */
function fail(ctx: ApiContext, e: unknown): never {
  if (e instanceof UserError) throw new HttpError(STATUS[e.code], e.message);
  if (e instanceof HttpError) throw e;
  const log = ctx.diagLog;
  if (e instanceof StoreError) log?.(`users: ${basename(e.file)} ${e.kind}`);
  else if (e instanceof KeyError) log?.(`users: keychain ${e.code === "wrong-key" ? "wrong-key" : "failed"}`);
  else log?.(`users: unexpected ${e instanceof Error ? e.name : "error"}`);
  throw new HttpError(500, INTERNAL);
}

/** Runs account-store code (see `fail`). */
function guardedUsers<T>(ctx: ApiContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    return fail(ctx, e);
  }
}

/** The same for an async store call. */
async function guardedUsersAsync<T>(ctx: ApiContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return fail(ctx, e);
  }
}

/** The number of runs of each account. */
function runCounts(ctx: ApiContext): Map<string, number> {
  const counts = new Map<string, number>();
  try {
    for (const b of ctx.scheduler.briefs()) if (b.owner) counts.set(b.owner, (counts.get(b.owner) ?? 0) + 1);
  } catch {
    // fixed words only: a run-store error can hold a path
    ctx.diagLog?.("users: runs cannot-read");
    throw new HttpError(500, INTERNAL);
  }
  return counts;
}

/** The account as the API shows it: nine fields picked one by one, never a hash or a token. */
function view(u: PublicUser, runs: number, hasPassword: boolean) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, created: u.created, lastSignIn: u.lastSignIn, runs, hasPassword };
}

/** Cancels the account's work at once; a queue.json that cannot be written is logged in fixed words only. */
function cancelNow(ctx: ApiContext, id: string, why: "blocked" | "deleted", stopWork = false) {
  try {
    return cancelAccountNow(ctx.scheduler, ctx.diagLog, id, why, stopWork);
  } catch (e) {
    if (e instanceof UserError || e instanceof StoreError || e instanceof HttpError) return fail(ctx, e);
    ctx.diagLog?.("users: queue.json cannot-write");
    throw new HttpError(500, INTERNAL);
  }
}

const hasPassword = (u: object): boolean => "passwordHash" in u && (u as { passwordHash?: unknown }).passwordHash !== undefined;

/** The accounts API, for admins (the permission table decides who gets here). */
export const userRoutes: Route = async (ctx, req, res, seg, method, caller) => {
  if (seg[0] !== "users") return false;
  const by = caller.id;
  const log = ctx.diagLog;
  const runsOf = (id: string) => runCounts(ctx).get(id) ?? 0;

  if (seg.length === 1 && method === "GET") {
    const runs = runCounts(ctx);
    return send(res, 200, guardedUsers(ctx, () => listUsers()).map((u) => view(u, runs.get(u.id) ?? 0, hasPassword(u)))), true;
  }

  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    const r = await guardedUsersAsync(ctx, async () => {
      const name = checkName(body.name as string);
      const email = checkEmail(body.email as string);
      if (body.role !== "admin" && body.role !== "user") throw new UserError("bad-role", "the role must be admin or user");
      return createUserWithLink({ name, email, role: body.role }, { by });
    });
    return send(res, 201, { user: view(r.user, 0, false), token: r.token, expires: r.expires }), true;
  }

  const id = seg[1];
  if (id === undefined) return false;

  if (seg.length === 2 && method === "PUT") {
    const body = await readJson(req);
    const u = await guardedUsersAsync(ctx, () => updateUser(id, { name: body.name as string, email: body.email as string, role: body.role as "admin" }, { by }));
    return send(res, 200, { user: view(u, runsOf(id), hasPassword(u)) }), true;
  }

  if (seg.length === 3 && seg[2] === "block" && method === "POST") {
    const body = await readJson(req);
    if (body.stopWork !== undefined && typeof body.stopWork !== "boolean") throw new HttpError(400, "stopWork must be true or false");
    const stopWork = body.stopWork === true;
    const u = await guardedUsersAsync(ctx, () => setStatus(id, "blocked", { by, stopWork }));
    const cancelled = cancelNow(ctx, id, "blocked", stopWork);
    return send(res, 200, { user: view(u, runsOf(id), hasPassword(u)), cancelled }), true;
  }

  if (seg.length === 3 && seg[2] === "unblock" && method === "POST") {
    const u = await guardedUsersAsync(ctx, () => setStatus(id, "active", { by }));
    return send(res, 200, { user: view(u, runsOf(id), hasPassword(u)) }), true;
  }

  if (seg.length === 3 && seg[2] === "link" && method === "POST") {
    const r = await guardedUsersAsync(ctx, () => newPasswordLink(id, { by }));
    return send(res, 200, { user: view(r.user, runsOf(id), false), token: r.token, expires: r.expires }), true;
  }

  if (seg.length === 2 && method === "DELETE") {
    const r = guardedUsers(ctx, () => deleteUser(id, { by }));
    const cancelled = cancelNow(ctx, id, "deleted");
    if (r.oldKeysLeft) {
      log?.(`users: ${r.oldKeysLeft} old key(s) still in the Keychain; run scf credential rotate-key`);
      throw new HttpError(500, `the account was deleted, but ${OLD_KEY_LEFT}`);
    }
    return send(res, 200, { ok: true, credentials: r.credentials, cancelled }), true;
  }

  return false;
};
