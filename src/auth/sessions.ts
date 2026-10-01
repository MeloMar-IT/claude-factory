import { createHash, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { StoreError, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "./store.js";

/** A session lasts 7 days from sign-in. It is never renewed, so reading never writes. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const sessionsPath = () => join(dataHome(), "sessions.json");

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const newToken = () => randomBytes(32).toString("base64url");
export const sessionId = (token: string) => createHash("sha256").update(token).digest("hex");
/** The CSRF token of a session: HMAC-SHA256 with the session token as the key. */
export const csrfToken = (token: string) => createHmac("sha256", token).update("csrf").digest("base64url");

const SessionSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    userId: z.uuid(),
    created: z.iso.datetime(),
    expires: z.iso.datetime(),
  })
  .strict()
  .refine((s) => Date.parse(s.expires) > Date.parse(s.created));

const FileSchema = z
  .object({ version: z.literal(1), sessions: z.array(SessionSchema) })
  .strict()
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    f.sessions.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["sessions", i, "id"] });
      ids.add(s.id);
    });
  });

export type Session = z.infer<typeof SessionSchema>;

/** All stored sessions. A missing, corrupt or invalid file counts as no sessions; an unreadable one throws. */
export function readSessions(): Session[] {
  try {
    return readJsonFile(sessionsPath(), FileSchema, { version: 1 as const, sessions: [] }).sessions;
  } catch (e) {
    if (e instanceof StoreError && (e.kind === "not-json" || e.kind === "wrong-format")) return [];
    throw e;
  }
}

/** The live session for a token, or undefined (malformed, unknown or expired). */
export function findSession(token: string | undefined, now = Date.now()): Session | undefined {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return undefined;
  const id = sessionId(token);
  return readSessions().find((s) => s.id === id && Date.parse(s.expires) > now);
}

const save = (sessions: Session[]) => writeJsonFile(sessionsPath(), { version: 1, sessions });

/** Adds a session for `userId` and returns its token. Only inside withAuthLock. Drops expired entries and `replaces` (an id). */
export function addSessionLocked(userId: string, replaces?: string, now = Date.now()): string {
  const token = newToken();
  const kept = readSessions().filter((s) => Date.parse(s.expires) > now && s.id !== replaces);
  const session: Session = {
    id: sessionId(token),
    userId,
    created: new Date(now).toISOString(),
    expires: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  save([...kept, session]);
  return token;
}

/** Removes the sessions that match. Only inside withAuthLock. Writes nothing when none match. */
export function removeSessionsLocked(match: (s: Session) => boolean): number {
  const all = readSessions();
  const kept = all.filter((s) => !match(s));
  if (kept.length !== all.length) save(kept);
  return all.length - kept.length;
}

export const addSession = (userId: string, replaces?: string): string => withAuthLock(() => addSessionLocked(userId, replaces));
export const revokeSession = (id: string): number => withAuthLock(() => removeSessionsLocked((s) => s.id === id));
export const revokeUserSessions = (userId: string): number => withAuthLock(() => removeSessionsLocked((s) => s.userId === userId));
