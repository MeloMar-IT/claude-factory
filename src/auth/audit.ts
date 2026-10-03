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

/** The names of the top-level keys whose values differ, sorted. Names only, never a value. */
export function changedKeys(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !isDeepStrictEqual(before[k], after[k])).sort();
}
