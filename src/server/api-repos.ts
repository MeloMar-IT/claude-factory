import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { type RepoRecord, RepoError, addRepo, listAllRepos, listRepos, removeGithubRepo, removeRepo, setRepoAuth, setRepoSettings, transferRepo } from "../auth/repos.js";
import { StoreError } from "../auth/store.js";
import { type User, getUser, listUsers } from "../auth/users.js";
import { KeyError } from "../credentials/keychain.js";
import { HttpError, readJson, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { sessionUser } from "./api-auth.js";

const INTERNAL = "the repository list is not working; see the server log";
const STATUS = { "bad-name": 400, "bad-url": 400, "bad-auth": 400, duplicate: 409, taken: 409, limit: 400, "not-found": 404, "no-owner": 404, "bad-settings": 400, "bad-owner": 400, blocked: 409, "no-credential": 409 } as const;

/**
 * Runs repository-list code. Input errors become 4xx; everything else is logged (the file name and the kind, never
 * a path or a value) and answered with a plain 500.
 */
export function guardedRepos<T>(ctx: ApiContext, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof RepoError) throw new HttpError(STATUS[e.code], e.message);
    if (e instanceof HttpError) throw e;
    const log = ctx.diagLog;
    if (e instanceof StoreError) log?.(`repos: ${basename(e.file)} ${e.kind}`);
    else if (e instanceof KeyError) log?.(`repos: keychain ${e.code === "wrong-key" ? "wrong-key" : "failed"}`);
    else log?.(`repos: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

/** A value of the body: missing or null is "not given"; anything else goes to the store, which checks it. */
const given = (body: Record<string, unknown>, key: string): unknown => (body[key] === null ? undefined : body[key]);

/** After a wipe: an old key that is still in the Keychain is reported, like the credentials API does. */
function oldKeys(ctx: ApiContext, left: number, done: string): void {
  if (!left) return;
  ctx.diagLog?.(`repos: ${left} old key(s) still in the Keychain; run scf credential rotate-key`);
  throw new HttpError(500, `${done}, but an old key is still in the Keychain, so older copies of the data could be read; try again, or run scf credential rotate-key`);
}

/** A record for the admin page: with its settings (`{}` when none) and the owner's name, e-mail, role and status (null when the account is gone). */
function adminRow(rec: RepoRecord, users?: Map<string, User>) {
  const u = users ? users.get(rec.owner) : getUser(rec.owner);
  return { ...rec, settings: rec.settings ?? {}, account: u ? { name: u.name, email: u.email, role: u.role, status: u.status } : null };
}

/** The admin calls (the permission table lets only an admin through): all repositories, their settings, and transfer. */
async function adminRepos(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string): Promise<boolean> {
  if (seg[1] !== "repos") return false;
  if (seg.length === 2 && method === "GET") return send(res, 200, guardedRepos(ctx, () => {
    const users = new Map(listUsers().map((u) => [u.id, u]));
    return listAllRepos().map((r) => adminRow(r, users));
  })), true;
  if (seg.length === 4 && seg[3] === "settings" && method === "PUT") {
    const body = await readJson(req);
    return send(res, 200, adminRow(guardedRepos(ctx, () => setRepoSettings(seg[2]!, body)))), true;
  }
  if (seg.length === 4 && seg[3] === "transfer" && method === "POST") {
    const body = await readJson(req);
    const r = guardedRepos(ctx, () => transferRepo(seg[2]!, given(body, "email")));
    oldKeys(ctx, r.oldKeysLeft, "the repository was transferred");
    return send(res, 200, adminRow(r.repo)), true;
  }
  return false;
}

/** The caller's own repositories: list, add, change how to reach one, remove. A token is only ever accepted, never returned. */
export const repoRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] === "admin") return adminRepos(ctx, req, res, seg, method);
  if (seg[0] !== "repos") return false;
  const user = sessionUser(ctx, req);
  const noServerAccess = (m: unknown) => {
    if (m === "none" && user.role !== "admin") throw new HttpError(403, 'only an admin may choose "none" (the server\'s own access)');
  };
  if (seg.length === 1 && method === "GET") return send(res, 200, guardedRepos(ctx, () => listRepos(user.id))), true;
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    noServerAccess(body.method);
    const repo = guardedRepos(ctx, () =>
      addRepo(user.id, { url: given(body, "url") ?? given(body, "name"), method: given(body, "method"), username: given(body, "username"), token: given(body, "token") }),
    );
    return send(res, 201, repo), true;
  }
  if (seg.length === 3 && seg[2] === "auth" && method === "PUT") {
    const body = await readJson(req);
    noServerAccess(body.method);
    const r = guardedRepos(ctx, () =>
      setRepoAuth(user.id, seg[1]!, { method: given(body, "method"), username: given(body, "username"), token: given(body, "token"), url: given(body, "url") }),
    );
    oldKeys(ctx, r.oldKeysLeft, "the repository was changed");
    return send(res, 200, r.repo), true;
  }
  if (seg.length === 2 && method === "DELETE") {
    oldKeys(ctx, guardedRepos(ctx, () => removeRepo(user.id, seg[1]!)).oldKeysLeft, "the repository was removed");
    return send(res, 200, { ok: true }), true;
  }
  if (seg.length === 3 && method === "DELETE") {
    oldKeys(ctx, guardedRepos(ctx, () => removeGithubRepo(user.id, `${seg[1]}/${seg[2]}`)).oldKeysLeft, "the repository was removed");
    return send(res, 200, { ok: true }), true;
  }
  return false;
};
