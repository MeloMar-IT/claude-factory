import { basename } from "node:path";
import { StoreError } from "../auth/store.js";
import { KeyError } from "../credentials/keychain.js";
import { CredentialError, addCredential, listCredentials, removeCredential } from "../credentials/store.js";
import { sessionUser } from "./api-auth.js";
import { HttpError, readJson, send } from "./http.js";
import type { Route } from "./server.js";

const INTERNAL = "the credential store is not working; see the server log";
const STATUS = { "bad-type": 400, "bad-name": 400, "bad-secret": 400, duplicate: 409, "not-found": 404, "no-owner": 404 } as const;

/** Runs store code. Input errors become 4xx; everything else is logged (file and kind, never a value) and answered with a plain 500. */
function guarded<T>(log: ((m: string) => void) | undefined, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof CredentialError) throw new HttpError(STATUS[e.code], e.message);
    if (e instanceof StoreError) log?.(`credentials: ${basename(e.file)} ${e.kind}`);
    else if (e instanceof KeyError) log?.(`credentials: keychain ${e.code === "wrong-key" ? "wrong-key" : "failed"}`);
    else log?.(`credentials: unexpected ${e instanceof Error ? e.name : "error"}`);
    throw new HttpError(500, INTERNAL);
  }
}

/** The caller's own stored credentials: list, add, delete. A secret is only ever accepted, never returned. */
export const credentialRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "credentials" || seg.length > 2) return false;
  const log = ctx.diagLog; // fixed-word diagnostics only (see ApiContext.diagLog)
  const user = sessionUser(ctx, req);

  if (seg.length === 1) {
    if (method === "GET") {
      send(res, 200, guarded(log, () => listCredentials(user.id)));
    } else if (method === "POST") {
      const body = await readJson(req);
      const created = guarded(log, () => addCredential({ userId: user.id, type: body.type, name: body.name, secret: body.secret }));
      send(res, 201, created);
    } else throw new HttpError(405, "method not allowed");
    return true;
  }

  if (method !== "DELETE") throw new HttpError(405, "method not allowed");
  const r = guarded(log, () => removeCredential(user.id, seg[1]!));
  if (r.oldKeysLeft) {
    log?.(`credentials: ${r.oldKeysLeft} old key(s) still in the Keychain; run scf credential rotate-key`);
    // the wipe is not complete: say so, and let a retry of this call clean up
    throw new HttpError(500, `${r.removed ? "the credential was removed, but " : ""}an old key is still in the Keychain, so older copies of the data could be read; try again, or run scf credential rotate-key`);
  }
  if (!r.removed) throw new HttpError(404, "no such credential");
  send(res, 200, { ok: true });
  return true;
};
