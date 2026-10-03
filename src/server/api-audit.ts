import { basename } from "node:path";
import { AUDIT_ACTIONS, auditTime, isAccountId, latestAudit, scanAudit, type AuditFilter, type AuditRecord } from "../auth/audit.js";
import { ownerNames } from "../auth/run-owner.js";
import { StoreError } from "../auth/store.js";
import { HttpError, send, sendCsv } from "./http.js";
import type { ApiContext, Route } from "./server.js";

export const AUDIT_PAGE = 500;
export const AUDIT_CSV_HEADER = ["time", "actor", "actor_name", "action", "target", "target_name", "result", "detail"];

const INTERNAL = "the audit log is not working; see the server log";
const GONE = "deleted user";
const FILTERS = ["user", "action", "from", "to"];

/** An error from the log is logged (file and kind, never a path or value) and answered with a plain 500. */
function fail(ctx: ApiContext, e: unknown): never {
  if (e instanceof HttpError) throw e;
  const log = ctx.diagLog;
  if (e instanceof StoreError) log?.(`audit: ${basename(e.file)} ${e.kind}`);
  else log?.(`audit: unexpected ${e instanceof Error ? e.name : "error"}`);
  throw new HttpError(500, INTERNAL);
}

/** The filters of the query. Strict: unknown, repeated and empty ones answer 400, and no message holds the given value. */
function filterOf(req: { url?: string }): AuditFilter {
  const q = new URL(req.url ?? "/", "http://x").searchParams;
  for (const k of new Set(q.keys())) if (!FILTERS.includes(k)) throw new HttpError(400, "the filters are user, action, from and to");
  for (const k of FILTERS) if (q.getAll(k).length > 1) throw new HttpError(400, `"${k}" is given more than once`);
  const filter: AuditFilter = {};
  const user = q.get("user");
  if (user !== null) {
    if (!isAccountId(user)) throw new HttpError(400, '"user" must be an account id');
    filter.user = user;
  }
  const action = q.get("action");
  if (action !== null) {
    if (!AUDIT_ACTIONS.includes(action)) throw new HttpError(400, '"action" is not an audit action');
    filter.action = action;
  }
  for (const k of ["from", "to"] as const) {
    const v = q.get(k);
    if (v === null) continue;
    const t = auditTime(v);
    if (t === undefined) throw new HttpError(400, `"${k}" must be an ISO time, such as 2026-10-02T09:00:00Z`);
    filter[k] = t;
  }
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) throw new HttpError(400, '"from" must not be after "to"');
  return filter;
}

function view(r: AuditRecord, names: Map<string, string>) {
  const account = (id: string) => ({ type: "account", id, name: names.get(id) ?? GONE });
  const actor = r.by === "cli" || r.by === "anonymous" ? { type: r.by } : account(r.by);
  const target = r.userId !== undefined ? account(r.userId) : r.target !== undefined ? { type: "text", text: r.target } : null;
  return { time: r.time, actor, action: r.action, target, result: r.result, ...(r.detail !== undefined ? { detail: r.detail } : {}) };
}

function row(r: AuditRecord, names: Map<string, string>): string[] {
  const named = (id: string) => names.get(id) ?? GONE;
  return [
    r.time,
    r.by,
    r.by === "cli" || r.by === "anonymous" ? "" : named(r.by),
    r.action,
    r.userId ?? r.target ?? "",
    r.userId !== undefined ? named(r.userId) : "",
    r.result,
    r.detail ?? "",
  ];
}

async function* rows(filter: AuditFilter, names: Map<string, string>): AsyncGenerator<string[]> {
  for await (const r of scanAudit(filter)) yield row(r, names);
}

/** The audit log API, for admins (the permission table decides who gets here). */
export const auditRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "audit" || method !== "GET") return false;
  const exporting = seg.length === 2 && seg[1] === "export";
  if (seg.length !== 1 && !exporting) return false;
  const filter = filterOf(req);
  try {
    const names = ownerNames();
    if (exporting) {
      await sendCsv(res, "audit.csv", AUDIT_CSV_HEADER, rows(filter, names));
      return true;
    }
    const { records, more } = await latestAudit(filter, AUDIT_PAGE);
    return send(res, 200, { entries: records.map((r) => view(r, names)), more }), true;
  } catch (e) {
    return fail(ctx, e);
  }
};
