import { basename } from "node:path";
import { RepoError, addRepo, listRepos, removeRepo } from "../auth/repos.js";
import { StoreError } from "../auth/store.js";
import { HttpError, readJson, send, str } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { sessionUser } from "./api-auth.js";

const INTERNAL = "the repository list is not working; see the server log";
const STATUS = { "bad-name": 400, duplicate: 409, limit: 400, "not-found": 404 } as const;

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
    else log?.(`repos: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

/** The caller's own repositories (GitHub names): list, add, remove. */
export const repoRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "repos") return false;
  const user = sessionUser(ctx, req);
  if (seg.length === 1 && method === "GET") return send(res, 200, guardedRepos(ctx, () => listRepos(user.id))), true;
  if (seg.length === 1 && method === "POST") {
    const body = await readJson(req);
    const name = guardedRepos(ctx, () => addRepo(user.id, str(body, "name")));
    return send(res, 201, { name }), true;
  }
  if (seg.length === 3 && method === "DELETE") {
    guardedRepos(ctx, () => removeRepo(user.id, `${seg[1]}/${seg[2]}`));
    return send(res, 200, { ok: true }), true;
  }
  return false;
};
