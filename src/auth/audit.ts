import { createReadStream, lstatSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, join } from "node:path";
import { z } from "zod";
import { dataHome, openAppendLocked, StoreError, withAuthLock } from "./store.js";

/**
 * The audit log: one JSON line per account change or event (a sign-in), in `audit.jsonl` (not `.json`, so the
 * data-folder move leaves it alone). The file is only appended; a reader skips lines that do not parse. A line never
 * holds a password, hash, token, key, name or e-mail. Lines also record actions made in the web interface; they never
 * hold a note, task text or setting value.
 */
export const auditPath = () => join(dataHome(), "audit.jsonl");

const Role = z.enum(["admin", "user"]);
const Base = { time: z.iso.datetime(), by: z.union([z.literal("cli"), z.uuid()]), userId: z.uuid() };

/** Actions of an event line. Later parts add names here. */
export const EVENT_ACTIONS = [
  "sign-in",
  "run-start",
  "run-cancel",
  "run-approve",
  "run-reject",
  "run-resume",
  "repo-add",
  "repo-change",
  "repo-remove",
  "repo-transfer",
  "credential-add",
  "credential-remove",
  "flow-publish",
  "settings-change",
  "turn-answer",
  "turn-approve",
  "turn-reject",
  "turn-retry",
] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];
export const TARGET_MAX = 255;
export const DETAIL_MAX = 500;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const short = (max: number) => z.string().refine((s) => s.length >= 1 && s.length <= max && s === s.trim() && !CONTROL.test(s));
const EventSchema = z
  .object({
    time: z.iso.datetime(),
    by: z.union([z.literal("cli"), z.literal("anonymous"), z.uuid()]),
    action: z.enum(EVENT_ACTIONS),
    result: z.enum(["ok", "failed"]),
    userId: z.uuid().optional(),
    target: short(TARGET_MAX).optional(),
    detail: short(DETAIL_MAX).optional(),
  })
  .strict()
  // one target at most, and a detail only as the second part of a `target`
  .refine((e) => (e.userId === undefined || e.target === undefined) && (e.detail === undefined || e.target !== undefined));

export const AuditEntrySchema = z.discriminatedUnion("action", [
  z.object({ ...Base, action: z.enum(["create", "password", "link", "edit", "unblock", "delete"]) }).strict(),
  z.object({ ...Base, action: z.literal("block"), stopWork: z.boolean().optional() }).strict(),
  z.object({ ...Base, action: z.literal("role"), oldRole: Role, newRole: Role }).strict(),
  EventSchema,
]);

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** What a store call tells the log: the entry without the time and the actor. */
export type AccountAuditEvent =
  | { action: "create" | "password" | "link" | "edit" | "unblock" | "delete"; userId: string }
  | { action: "block"; userId: string; stopWork?: boolean }
  | { action: "role"; userId: string; oldRole: "admin" | "user"; newRole: "admin" | "user" };
export interface ActionAuditEvent {
  action: (typeof EVENT_ACTIONS)[number];
  result: "ok" | "failed";
  userId?: string;
  target?: string;
  detail?: string;
}
export type AuditEvent = AccountAuditEvent | ActionAuditEvent;

export interface PreparedAudit {
  /** Adds the line. */
  write(): void;
  close(): void;
}

/**
 * Checks the entry and opens the log, so a log that cannot be written stops the action before it changes anything.
 * Only inside withAuthLock. Nothing is written until `write()`.
 */
export function prepareAuditLocked(by: string, event: AuditEvent): PreparedAudit {
  const time = new Date().toISOString();
  const entry =
    "result" in event
      ? {
          time,
          by,
          action: event.action,
          result: event.result,
          ...(event.userId !== undefined ? { userId: event.userId } : {}),
          ...(event.target !== undefined ? { target: event.target } : {}),
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
        }
      : {
          time,
          by,
          action: event.action,
          userId: event.userId,
          ...(event.action === "block" ? { stopWork: event.stopWork === true } : {}),
          ...("oldRole" in event ? { oldRole: event.oldRole, newRole: event.newRole } : {}),
        };
  if (!AuditEntrySchema.safeParse(entry).success) throw new Error("audit: the entry is not valid");
  const file = openAppendLocked(auditPath());
  return {
    write() {
      try {
        file.append(JSON.stringify(entry));
      } catch (e) {
        if (e instanceof StoreError) {
          throw new StoreError(e.kind, auditPath(), "could not be written; the account change was made but is not in the audit log");
        }
        throw e;
      }
    },
    close: () => file.close(),
  };
}

/** Adds one line now. Only inside withAuthLock. Throws when the entry is not valid or the file cannot be written. */
export function appendAuditLocked(by: string, event: AuditEvent): void {
  const log = prepareAuditLocked(by, event);
  try {
    log.write();
  } finally {
    log.close();
  }
}

/**
 * Adds one line now. Takes the lock itself, for callers that do not hold it (withAuthLock is not re-entrant).
 * The lock wait is synchronous: server code that must not hold the event loop passes `waitMs` 0.
 * Throws a StoreError when the lock or the file cannot be had.
 */
export function writeAudit(by: string, event: AuditEvent, waitMs?: number): void {
  withAuthLock(() => appendAuditLocked(by, event), waitMs);
}

/**
 * Adds one `ok` line for an action made in the web interface. Best effort: never throws, never waits for the lock.
 * A line that cannot be written is named in `log` (fixed words only).
 */
export function auditAction(log: ((msg: string) => void) | undefined, by: string, action: EventAction, target: string, detail?: string): void {
  try {
    writeAudit(by, { action, result: "ok", target, ...(detail !== undefined ? { detail } : {}) }, 0);
  } catch (e) {
    try {
      log?.(e instanceof StoreError ? `audit: ${basename(e.file)} ${e.kind} (${action})` : `audit: audit.jsonl not-valid (${action})`);
    } catch {
      /* the log itself must not fail the action */
    }
  }
}

// ---- reading -----------------------------------------------------------------------------------------

export const ACCOUNT_ACTIONS = ["create", "password", "link", "edit", "unblock", "delete", "block", "role"] as const;
/** Every action a reader can see: the account actions and the event actions. */
export const AUDIT_ACTIONS: readonly string[] = [...ACCOUNT_ACTIONS, ...EVENT_ACTIONS];

/** True for an account id as stored (a UUID, either case). */
export const isAccountId = (s: string): boolean => z.uuid().safeParse(s).success;

/** The time of an ISO text (with seconds and `Z` or an offset), as milliseconds; undefined for anything else. */
export function auditTime(s: string): number | undefined {
  if (!z.iso.datetime({ offset: true }).safeParse(s).success) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

/** One line of either kind, in one shape. */
export interface AuditRecord {
  time: string;
  by: string;
  action: string;
  result: "ok" | "failed";
  userId?: string;
  target?: string;
  detail?: string;
}

export interface AuditFilter {
  user?: string;
  action?: string;
  from?: number;
  to?: number;
}

/** Maps a valid line of either kind to the view. Old account lines are `ok` and name the account as target. */
export function auditRecord(e: AuditEntry): AuditRecord {
  if ("result" in e) {
    return {
      time: e.time,
      by: e.by,
      action: e.action,
      result: e.result,
      ...(e.userId !== undefined ? { userId: e.userId } : {}),
      ...(e.target !== undefined ? { target: e.target } : {}),
      ...(e.detail !== undefined ? { detail: e.detail } : {}),
    };
  }
  const base = { time: e.time, by: e.by, action: e.action, result: "ok" as const, userId: e.userId };
  if (e.action === "role") return { ...base, detail: `${e.oldRole} -> ${e.newRole}` };
  if (e.action === "block" && e.stopWork === true) return { ...base, detail: "stop work" };
  return base;
}

const MAX_LINE = 64 * 1024;

/** The lines of audit.jsonl, read in chunks. A missing file has none; anything else that cannot be read is a StoreError. */
async function* auditLines(): AsyncGenerator<string> {
  const file = auditPath();
  const unreadable = () => new StoreError("unreadable", file, "cannot be read");
  let regular: boolean;
  try {
    regular = lstatSync(file).isFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw unreadable();
  }
  if (!regular) throw unreadable();
  const stream = createReadStream(file);
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        const end = nl === -1 ? chunk.length : nl;
        if (!skipping) {
          size += end - start;
          if (size > MAX_LINE) {
            skipping = true;
            parts = [];
          } else parts.push(chunk.subarray(start, end));
        }
        if (nl === -1) break;
        if (!skipping) yield Buffer.concat(parts).toString("utf8");
        parts = [];
        size = 0;
        skipping = false;
        start = nl + 1;
      }
    }
  } catch (e) {
    if (e instanceof StoreError) throw e;
    throw unreadable();
  } finally {
    stream.destroy();
  }
  if (!skipping && size > 0) yield Buffer.concat(parts).toString("utf8");
}

/** The matching records in file order (oldest first). Lines that do not parse are skipped. Throws a StoreError. */
export async function* scanAudit(filter: AuditFilter = {}): AsyncGenerator<AuditRecord> {
  for await (const line of auditLines()) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = AuditEntrySchema.safeParse(json);
    if (!parsed.success) continue;
    const r = auditRecord(parsed.data);
    if (filter.user !== undefined && r.by !== filter.user && r.userId !== filter.user) continue;
    if (filter.action !== undefined && r.action !== filter.action) continue;
    if (filter.from !== undefined || filter.to !== undefined) {
      const t = Date.parse(r.time);
      if (filter.from !== undefined && t < filter.from) continue;
      if (filter.to !== undefined && t > filter.to) continue;
    }
    yield r;
  }
}

/** The last `limit` matches, newest first (by the order of the lines), and whether there were more. */
export async function latestAudit(filter: AuditFilter, limit: number): Promise<{ records: AuditRecord[]; more: boolean }> {
  let kept: AuditRecord[] = [];
  let count = 0;
  for await (const r of scanAudit(filter)) {
    count++;
    kept.push(r);
    if (kept.length >= 2 * limit) kept = kept.slice(-limit);
  }
  return { records: kept.slice(-limit).reverse(), more: count > limit };
}

/** The names of the top-level keys whose values differ, sorted. Names only, never a value. */
export function changedKeys(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !isDeepStrictEqual(before[k], after[k])).sort();
}
