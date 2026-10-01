import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { addSessionLocked, removeSessionsLocked } from "./sessions.js";
import { dataHome, readJsonFile, withAuthLock, writeJsonFile } from "./store.js";

export type UserErrorCode = "bad-name" | "bad-email" | "bad-password" | "email-taken" | "admin-exists" | "not-found";

/** A problem with what the caller asked for (not with the file). The message is safe to show. */
export class UserError extends Error {
  constructor(
    public code: UserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export const usersPath = () => join(dataHome(), "users.json");

// ---- password hash: scrypt$N=32768,r=8,p=3$<salt b64>$<key b64> -----------------------------------

const N = 32768;
const R = 8;
const P = 3;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024; // Node's default of 32 MiB is too small for these parameters
const PARAMS = `N=${N},r=${R},p=${P}`;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** The salt and key of a hash in exactly our form, or undefined. Base64 must be canonical and padded. */
function parseHash(hash: string): { salt: Buffer; key: Buffer } | undefined {
  const parts = hash.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== PARAMS) return undefined;
  const salt = Buffer.from(parts[2]!, "base64");
  const key = Buffer.from(parts[3]!, "base64");
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return undefined;
  if (salt.toString("base64") !== parts[2] || key.toString("base64") !== parts[3]) return undefined;
  return { salt, key };
}

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAXMEM }, (e, key) => (e ? reject(e) : resolve(key))),
  );

export function checkPassword(password: string): void {
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new UserError("bad-password", `the password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  checkPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt);
  return `scrypt$${PARAMS}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** False for a wrong password and for any stored string that is not a hash in our form. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = typeof stored === "string" ? parseHash(stored) : undefined;
  if (!h || typeof password !== "string") return false;
  try {
    return timingSafeEqual(await derive(password, h.salt), h.key);
  } catch {
    return false;
  }
}

// ---- the file --------------------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function checkName(input: string): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (name.length < 1 || name.length > 100 || CONTROL.test(name)) {
    throw new UserError("bad-name", "the name must be 1 to 100 characters, without control characters");
  }
  return name;
}

export function checkEmail(input: string): string {
  const email = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new UserError("bad-email", "that is not a valid e-mail address");
  return email;
}

const UserSchema = z
  .object({
    id: z.uuid(),
    name: z.string().refine((s) => s === s.trim() && s.length >= 1 && s.length <= 100 && !CONTROL.test(s)),
    email: z.string().refine((s) => s === s.trim().toLowerCase() && s.length <= 254 && EMAIL_RE.test(s)),
    role: z.enum(["admin", "user"]),
    status: z.enum(["active", "blocked"]),
    passwordHash: z.string().refine((s) => parseHash(s) !== undefined),
    created: z.iso.datetime(),
    lastSignIn: z.iso.datetime().nullable(),
  })
  .strict();

const FileSchema = z
  .object({ version: z.literal(1), users: z.array(UserSchema) })
  .strict()
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    const emails = new Set<string>();
    f.users.forEach((u, i) => {
      if (ids.has(u.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["users", i, "id"] });
      if (emails.has(u.email)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["users", i, "email"] });
      ids.add(u.id);
      emails.add(u.email);
    });
  });

export type User = z.infer<typeof UserSchema>;
export type PublicUser = Omit<User, "passwordHash">;
type UsersFile = z.infer<typeof FileSchema>;

const read = (): UsersFile => readJsonFile(usersPath(), FileSchema, { version: 1, users: [] });

export function listUsers(): User[] {
  return read().users;
}

export const getUser = (id: string): User | undefined => listUsers().find((u) => u.id === id);

export const findUserByEmail = (email: string): User | undefined => {
  const e = String(email).trim().toLowerCase();
  return listUsers().find((u) => u.email === e);
};

/** True when any admin exists, blocked or not. */
export const hasAdmin = (): boolean => listUsers().some((u) => u.role === "admin");

export function publicUser(u: User): PublicUser {
  const { passwordHash: _hash, ...rest } = u;
  return rest;
}

export interface NewUser {
  name: string;
  email: string;
  password: string;
  role?: "admin" | "user";
}

/** Hashes first (slow), then checks and writes under the lock. */
export async function createUser(input: NewUser, opts: { onlyIfNoAdmin?: boolean } = {}): Promise<User> {
  const name = checkName(input.name);
  const email = checkEmail(input.email);
  const passwordHash = await hashPassword(input.password);
  const user: User = {
    id: randomUUID(),
    name,
    email,
    role: input.role ?? "user",
    status: "active",
    passwordHash,
    created: new Date().toISOString(),
    lastSignIn: null,
  };
  return withAuthLock(() => {
    const file = read();
    if (opts.onlyIfNoAdmin && file.users.some((u) => u.role === "admin")) throw new UserError("admin-exists", "an admin account exists already");
    if (file.users.some((u) => u.email === email)) throw new UserError("email-taken", "an account with that e-mail exists already");
    writeJsonFile(usersPath(), { ...file, users: [...file.users, user] });
    return user;
  });
}

function change(id: string, apply: (u: User) => User, endSessions = false): User {
  return withAuthLock(() => {
    const file = read();
    const i = file.users.findIndex((u) => u.id === id);
    if (i < 0) throw new UserError("not-found", "no such account");
    const next = apply(file.users[i]!);
    // sessions first: if the user file cannot be written, the account is only signed out too early
    if (endSessions) removeSessionsLocked((s) => s.userId === id);
    writeJsonFile(usersPath(), { ...file, users: file.users.map((u, j) => (j === i ? next : u)) });
    return next;
  });
}

export async function setPassword(id: string, password: string): Promise<User> {
  const passwordHash = await hashPassword(password);
  return change(id, (u) => ({ ...u, passwordHash }), true);
}

export async function setStatus(id: string, status: "active" | "blocked"): Promise<User> {
  return change(id, (u) => ({ ...u, status }), status === "blocked");
}

// ---- sign-in ---------------------------------------------------------------------------------------

// A valid hash in our form that no password is known for: checking against it costs exactly one scrypt.
const DUMMY_HASH = `scrypt$${PARAMS}$${Buffer.alloc(SALT_BYTES, 1).toString("base64")}$${Buffer.alloc(KEY_BYTES, 2).toString("base64")}`;

/**
 * The account for an e-mail and password, or undefined. An unknown e-mail still costs one scrypt, so the
 * time does not tell whether the account exists. The account may be blocked: the caller decides.
 */
export async function checkSignIn(email: string, password: string): Promise<User | undefined> {
  const user = findUserByEmail(email);
  const fits = typeof password === "string" && password.length <= PASSWORD_MAX;
  if (!user || !fits) {
    await verifyPassword(fits ? password : "", DUMMY_HASH);
    return undefined;
  }
  return (await verifyPassword(password, user.passwordHash)) ? user : undefined;
}

/**
 * Creates the session once the password was checked. Reads the user again under the lock: the hash must be the one
 * that was checked and the account must be active, else there is no session (a password change or block in between wins).
 * `replaces` is the id of the session the sign-in came with.
 */
export function startSession(userId: string, verifiedHash: string, replaces?: string): { user: User; token: string } | undefined {
  return withAuthLock(() => {
    const file = read();
    const i = file.users.findIndex((u) => u.id === userId);
    const current = file.users[i];
    if (!current || current.passwordHash !== verifiedHash || current.status !== "active") return undefined;
    const user: User = { ...current, lastSignIn: new Date().toISOString() };
    writeJsonFile(usersPath(), { ...file, users: file.users.map((u, j) => (j === i ? user : u)) });
    return { user, token: addSessionLocked(userId, replaces) };
  });
}
