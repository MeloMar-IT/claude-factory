import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { auditAction } from "../auth/audit.js";
import { type RepoRecord, RepoError, addRepo, getRepo, listAllRepos, listRepos, readRepoSecret, removeGithubRepo, removeRepo, setRepoAuth, setRepoConnection, setRepoSettings, transferRepo } from "../auth/repos.js";
import { ConnectError, testConnection } from "../repos/connect.js";
import { StoreError } from "../auth/store.js";
import { type User, getUser, listUsers } from "../auth/users.js";
import { KeyError } from "../credentials/keychain.js";
import { KeygenError } from "../credentials/ssh-keygen.js";
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
    if (e instanceof KeygenError) {
      log?.(`repos: ssh-keygen ${e.code}`);
      throw new HttpError(500, "the SSH key could not be made; see the server log");
    }
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

/** The public keys of deploy-key records; `send` keeps them readable (a public key is not a secret). */
const publicKeys = (repos: Pick<RepoRecord, "publicKey">[]) => repos.flatMap((r) => (r.publicKey ? [r.publicKey] : []));

/** A record for the admin page: with its settings (`{}` when none) and the owner's name, e-mail, role and status (null when the account is gone). */
function adminRow(rec: RepoRecord, users?: Map<string, User>) {
  const u = users ? users.get(rec.owner) : getUser(rec.owner);
  return { ...rec, settings: rec.settings ?? {}, account: u ? { name: u.name, email: u.email, role: u.role, status: u.status } : null };
}

/** The admin calls (the permission table lets only an admin through): all repositories, their settings, and transfer. */
async function adminRepos(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, seg: string[], method: string, by: string): Promise<boolean> {
  if (seg[1] !== "repos") return false;
  if (seg.length === 2 && method === "GET") {
    const rows = guardedRepos(ctx, () => {
      const users = new Map(listUsers().map((u) => [u.id, u]));
      return listAllRepos().map((r) => adminRow(r, users));
    });
    return send(res, 200, rows, publicKeys(rows)), true;
  }
  if (seg.length === 4 && seg[3] === "settings" && method === "PUT") {
    const body = await readJson(req);
    const r = guardedRepos(ctx, () => setRepoSettings(seg[2]!, body));
    if (r.changed.length) auditAction(ctx.diagLog, by, "repo-change", r.repo.id, `settings: ${r.changed.join(", ")}`);
    const row = adminRow(r.repo);
    return send(res, 200, row, publicKeys([row])), true;
  }
  if (seg.length === 4 && seg[3] === "transfer" && method === "POST") {
    const body = await readJson(req);
    const r = guardedRepos(ctx, () => transferRepo(seg[2]!, given(body, "email")));
    if (r.moved) auditAction(ctx.diagLog, by, "repo-transfer", r.repo.id, r.repo.owner);
    oldKeys(ctx, r.oldKeysLeft, "the repository was transferred");
    const row = adminRow(r.repo);
    return send(res, 200, row, publicKeys([row])), true;
  }
  return false;
}

/** The repositories whose connection test is running now. A second test of the same one answers 409. */
const testing = new Set<string>();

/** `POST /api/repos/<id>/test`: runs the checks, saves the result as the connection status and answers with it. */
async function testRepo(ctx: ApiContext, user: User, id: string): Promise<{ at: string; ok: boolean; checks: unknown[] }> {
  const rec = guardedRepos(ctx, () => getRepo(id));
  if (!rec || (rec.owner !== user.id && user.role !== "admin")) throw new HttpError(404, "no such repository");
  if (testing.has(rec.id)) throw new HttpError(409, "a test of this repository is running already; wait for it to finish");
  testing.add(rec.id);
  try {
    if (rec.method === "none" && user.role !== "admin") {
      throw new HttpError(409, "this repository has no sign-in yet; choose one with Change authentication");
    }
    const secret = rec.method === "none" ? undefined : guardedRepos(ctx, () => readRepoSecret(rec));
    let result;
    try {
      result = await testConnection({ url: rec.url, method: rec.method, username: rec.username, secret });
    } catch (e) {
      if (!(e instanceof ConnectError)) throw e;
      ctx.diagLog?.(`repos: test ${e.code}`);
      throw new HttpError(500, "the connection test could not run; see the server log");
    }
    const saved = guardedRepos(ctx, () => setRepoConnection(rec, result));
    if (saved === "gone") throw new HttpError(404, "no such repository");
    if (saved === "changed") throw new HttpError(409, "the repository was changed while the test ran; test again");
    for (const c of result.checks) if (!c.ok) ctx.diagLog?.(`repos: test ${c.check} ${c.code}`);
    return result;
  } finally {
    testing.delete(rec.id);
  }
}

/** The caller's own repositories: list, add, change how to reach one, remove. A token is only ever accepted, a private key never leaves the server. */
export const repoRoutes: Route = async (ctx, req, res, seg, method, caller) => {
  if (seg[0] === "admin") return adminRepos(ctx, req, res, seg, method, caller.id);
  if (seg[0] !== "repos") return false;
  const user = sessionUser(ctx, req);
  const noServerAccess = (m: unknown) => {
    if (m === "none" && user.role !== "admin") throw new HttpError(403, 'only an admin may choose "none" (the server\'s own access)');
  };
  if (seg.length === 1 && method === "GET") {
    const repos = guardedRepos(ctx, () => listRepos(user.id));
    return send(res, 200, repos, publicKeys(repos)), true;
  }
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    noServerAccess(body.method);
    const repo = guardedRepos(ctx, () =>
      addRepo(user.id, { url: given(body, "url") ?? given(body, "name"), method: given(body, "method"), username: given(body, "username"), token: given(body, "token") }),
    );
    auditAction(ctx.diagLog, user.id, "repo-add", repo.id, repo.url);
    return send(res, 201, repo, publicKeys([repo])), true;
  }
  if (seg.length === 3 && seg[2] === "auth" && method === "PUT") {
    const body = await readJson(req);
    noServerAccess(body.method);
    const r = guardedRepos(ctx, () =>
      setRepoAuth(user.id, seg[1]!, { method: given(body, "method"), username: given(body, "username"), token: given(body, "token"), url: given(body, "url"), newKey: given(body, "newKey") }),
    );
    if (r.changed) auditAction(ctx.diagLog, user.id, "repo-change", r.repo.id, r.repo.url);
    oldKeys(ctx, r.oldKeysLeft, "the repository was changed");
    return send(res, 200, r.repo, publicKeys([r.repo])), true;
  }
  if (seg.length === 3 && seg[2] === "test" && method === "POST") {
    return send(res, 200, await testRepo(ctx, user, seg[1]!)), true;
  }
  if (seg.length === 2 && method === "DELETE") {
    const r = guardedRepos(ctx, () => removeRepo(user.id, seg[1]!));
    if (r.removed) auditAction(ctx.diagLog, user.id, "repo-remove", r.removed.id, r.removed.url);
    oldKeys(ctx, r.oldKeysLeft, "the repository was removed");
    return send(res, 200, { ok: true }), true;
  }
  if (seg.length === 3 && method === "DELETE") {
    const r = guardedRepos(ctx, () => removeGithubRepo(user.id, `${seg[1]}/${seg[2]}`));
    if (r.removed) auditAction(ctx.diagLog, user.id, "repo-remove", r.removed.id, r.removed.url);
    oldKeys(ctx, r.oldKeysLeft, "the repository was removed");
    return send(res, 200, { ok: true }), true;
  }
  return false;
};
