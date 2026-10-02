import { join } from "node:path";
import { z } from "zod";
import { dataHome, openAppendLocked, StoreError } from "./store.js";

/**
 * The audit log: one JSON line per account change, in `audit.jsonl` (not `.json`, so the data-folder move leaves it
 * alone). The file is only appended; a reader skips lines that do not parse. A line never holds a password, hash,
 * token, name or e-mail.
 */
export const auditPath = () => join(dataHome(), "audit.jsonl");

const Role = z.enum(["admin", "user"]);
const Base = { time: z.iso.datetime(), by: z.union([z.literal("cli"), z.uuid()]), userId: z.uuid() };

export const AuditEntrySchema = z.discriminatedUnion("action", [
  z.object({ ...Base, action: z.enum(["create", "password", "block", "unblock", "delete"]) }).strict(),
  z.object({ ...Base, action: z.literal("role"), oldRole: Role, newRole: Role }).strict(),
]);

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** What a store call tells the log: the entry without the time and the actor. */
export type AuditEvent =
  | { action: "create" | "password" | "block" | "unblock" | "delete"; userId: string }
  | { action: "role"; userId: string; oldRole: "admin" | "user"; newRole: "admin" | "user" };

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
  const entry = {
    time: new Date().toISOString(),
    by,
    action: event.action,
    userId: event.userId,
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
