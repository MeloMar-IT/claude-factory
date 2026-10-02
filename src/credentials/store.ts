import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { getUser } from "../auth/users.js";
import { KEYCHAIN_SERVICE, KeyError, addKey, deleteKey, findKey } from "./keychain.js";

export { KEYCHAIN_SERVICE };

export type CredentialErrorCode = "bad-type" | "bad-name" | "bad-secret" | "duplicate" | "not-found" | "no-owner";

/** A problem with what the caller asked for. The message is safe to show and never holds the secret. */
export class CredentialError extends Error {
  constructor(
    public code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export const credentialsPath = () => join(dataHome(), "credentials.json");

export const CREDENTIAL_TYPES = ["token", "ssh-key"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export const TOKEN_MIN = 8;
export const TOKEN_MAX = 4096;
export const SSH_KEY_MAX = 16384;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// ---- the file --------------------------------------------------------------------------------------

const b64 = (bytes: number) => z.string().refine((s) => {
  const b = Buffer.from(s, "base64");
  return b.length === bytes && b.toString("base64") === s;
});
const uuid = z.uuid();

const RecordSchema = z
  .object({
    id: uuid,
    userId: uuid,
    type: z.enum(CREDENTIAL_TYPES),
    name: z.string().refine((s) => s === s.trim() && s.length >= 1 && s.length <= 100 && !CONTROL.test(s)),
    created: z.iso.datetime(),
    lastUsed: z.iso.datetime().nullable(),
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
    iv: b64(12),
    tag: b64(16),
    data: z.string().min(1).refine((s) => Buffer.from(s, "base64").toString("base64") === s),
  })
  .strict();

const FileSchema = z
  .object({
    version: z.literal(1),
    keyId: uuid.nullable(),
    retiredKeyIds: z.array(uuid),
    credentials: z.array(RecordSchema),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.credentials.length && f.keyId === null) ctx.addIssue({ code: "custom", message: "no key", path: ["keyId"] });
    const ids = new Set<string>();
    f.credentials.forEach((c, i) => {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["credentials", i, "id"] });
      ids.add(c.id);
    });
  });

type Stored = z.infer<typeof RecordSchema>;
type CredFile = z.infer<typeof FileSchema>;

const EMPTY: CredFile = { version: 1, keyId: null, retiredKeyIds: [], credentials: [] };
const read = (): CredFile => readJsonFile(credentialsPath(), FileSchema, EMPTY);

/** What the API may show: never the secret, the key or the ciphertext. */
export interface PublicCredential {
  id: string;
  type: CredentialType;
  name: string;
  created: string;
  lastUsed: string | null;
  fingerprint: string;
}
export const publicCredential = (c: Stored): PublicCredential => ({
  id: c.id,
  type: c.type,
  name: c.name,
  created: c.created,
  lastUsed: c.lastUsed,
  fingerprint: c.fingerprint,
});

// ---- crypto ----------------------------------------------------------------------------------------

/** The fields that are bound to the ciphertext: changing one of them makes decryption fail. */
const aad = (c: Pick<Stored, "id" | "userId" | "type" | "name" | "created" | "fingerprint">) =>
  Buffer.from(JSON.stringify(["claude-factory-credential-v1", c.id, c.userId, c.type, c.name, c.created, c.fingerprint]));

export const fingerprintOf = (secret: string) => createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 16);

function seal(key: Buffer, meta: Omit<Stored, "iv" | "tag" | "data">, secret: string): Stored {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(meta));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ...meta, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function open(key: Buffer, c: Stored): string {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(c.iv, "base64"));
    d.setAAD(aad(c));
    d.setAuthTag(Buffer.from(c.tag, "base64"));
    const secret = Buffer.concat([d.update(Buffer.from(c.data, "base64")), d.final()]).toString("utf8");
    if (fingerprintOf(secret) !== c.fingerprint) throw new Error("fingerprint");
    return secret;
  } catch {
    throw new KeyError("wrong-key", "a stored credential cannot be decrypted (wrong key, or the file was changed)");
  }
}

const newKey = () => randomBytes(32).toString("hex");

/** The key of the file, from the Keychain. */
function keyOf(file: CredFile): Buffer {
  const hex = findKey(file.keyId!);
  if (!hex) throw new KeyError("missing", "the credential key is not in the Keychain (was the data folder copied from another Mac?)");
  return Buffer.from(hex, "hex");
}

// ---- checks ----------------------------------------------------------------------------------------

const PRIVATE_KEY = /^-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----\n[\s\S]*\n-----END \1PRIVATE KEY-----\n$/;

export function checkType(type: unknown): CredentialType {
  if (!CREDENTIAL_TYPES.includes(type as CredentialType)) throw new CredentialError("bad-type", `the type must be one of: ${CREDENTIAL_TYPES.join(", ")}`);
  return type as CredentialType;
}

export function checkCredentialName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (name.length < 1 || name.length > 100 || CONTROL.test(name)) {
    throw new CredentialError("bad-name", "the name must be 1 to 100 characters, without control characters");
  }
  return name;
}

/** The secret as it is stored: a token trimmed, a key with LF line ends and one final newline. */
export function checkSecret(type: CredentialType, input: unknown): string {
  if (typeof input !== "string") throw new CredentialError("bad-secret", "the secret must be text");
  if (type === "token") {
    const s = input.trim();
    if (s.length < TOKEN_MIN) throw new CredentialError("bad-secret", `a token must be at least ${TOKEN_MIN} characters`);
    if (s.length > TOKEN_MAX) throw new CredentialError("bad-secret", `a token must be at most ${TOKEN_MAX} characters`);
    if (!/^[\x20-\x7e]+$/.test(s)) throw new CredentialError("bad-secret", "a token must be one line of printable ASCII characters");
    return s;
  }
  if (input.length > SSH_KEY_MAX) throw new CredentialError("bad-secret", `a key must be at most ${SSH_KEY_MAX} characters`);
  const s = input.replace(/\r\n/g, "\n").trim() + "\n";
  if (!/^[\x20-\x7e\n]+$/.test(s) || !PRIVATE_KEY.test(s)) throw new CredentialError("bad-secret", "an ssh-key must be a private key in PEM form (-----BEGIN … PRIVATE KEY-----)");
  return s;
}

// ---- writing ---------------------------------------------------------------------------------------

/** Removes the retired key items that can be removed; returns the ones that are still there. */
function dropRetired(ids: string[]): string[] {
  return ids.filter((id) => {
    try {
      deleteKey(id);
      return false;
    } catch {
      return true;
    }
  });
}

const attempt = (fn: () => void) => {
  try {
    fn();
  } catch {
    // best effort
  }
};

/** Writes the file; when that fails the key that was just added is removed again. */
function writeFile(next: CredFile, addedKeyId?: string) {
  try {
    writeJsonFile(credentialsPath(), next);
  } catch (e) {
    if (addedKeyId) attempt(() => deleteKey(addedKeyId));
    throw e;
  }
}

/**
 * Re-encrypts `keep` under a new key (or drops the key when nothing is kept), writes the file and removes the old key.
 * An old key that cannot be removed is kept in `retiredKeyIds` and retried later.
 */
function replaceKey(file: CredFile, keep: Stored[]): { next: CredFile; oldKeysLeft: number } {
  const oldKeyId = file.keyId;
  const retired = dropRetired(file.retiredKeyIds);
  let keyId: string | null = null;
  let credentials: Stored[] = [];
  if (keep.length) {
    const oldKey = keyOf(file);
    const plain = keep.map((c) => ({ c, secret: open(oldKey, c) }));
    keyId = randomUUID();
    const hex = newKey();
    addKey(keyId, hex);
    const key = Buffer.from(hex, "hex");
    credentials = plain.map(({ c, secret }) => {
      const { iv: _i, tag: _t, data: _d, ...meta } = c;
      return seal(key, meta, secret);
    });
  }
  // The old key is recorded as retired in the same write that replaces the ciphertext, so a crash cannot orphan it.
  const next: CredFile = { version: 1, keyId, retiredKeyIds: oldKeyId ? [...retired, oldKeyId] : retired, credentials };
  writeFile(next, keyId ?? undefined);
  if (oldKeyId) {
    try {
      deleteKey(oldKeyId);
      next.retiredKeyIds = retired;
      // a failed write here only leaves an id of an item that is already gone, which the next write cleans up
      attempt(() => writeFile(next));
    } catch {
      // the id stays in retiredKeyIds and is retried later
    }
  }
  return { next, oldKeysLeft: next.retiredKeyIds.length };
}

// ---- API -------------------------------------------------------------------------------------------

export interface NewCredential {
  userId: string;
  type: unknown;
  name: unknown;
  secret: unknown;
}

/** Encrypts and saves a credential. `ownerOk` says whether the account exists (default: it is in users.json). */
export function addCredential(input: NewCredential, opts: { ownerOk?: (userId: string) => boolean } = {}): PublicCredential {
  const type = checkType(input.type);
  const name = checkCredentialName(input.name);
  const secret = checkSecret(type, input.secret);
  const ownerOk = opts.ownerOk ?? ((id: string) => getUser(id) !== undefined);
  return withAuthLock(() => {
    if (!ownerOk(input.userId)) throw new CredentialError("no-owner", "no such account");
    const file = read();
    if (file.credentials.some((c) => c.userId === input.userId && c.name === name)) {
      throw new CredentialError("duplicate", "you have a credential with that name already");
    }
    let keyId = file.keyId;
    let key: Buffer;
    let added: string | undefined;
    if (keyId) key = keyOf(file);
    else {
      keyId = added = randomUUID();
      const hex = newKey();
      addKey(keyId, hex);
      key = Buffer.from(hex, "hex");
    }
    const record = seal(
      key,
      { id: randomUUID(), userId: input.userId, type, name, created: new Date().toISOString(), lastUsed: null, fingerprint: fingerprintOf(secret) },
      secret,
    );
    const retired = dropRetired(file.retiredKeyIds);
    writeFile({ version: 1, keyId, retiredKeyIds: retired, credentials: [...file.credentials, record] }, added);
    return publicCredential(record);
  });
}

/** The credentials of one user, without any Keychain call. */
export function listCredentials(userId: string): PublicCredential[] {
  return read()
    .credentials.filter((c) => c.userId === userId)
    .map(publicCredential);
}

/** The secret of one of the user's credentials; sets `lastUsed`. */
export function readSecret(userId: string, id: string): string {
  return withAuthLock(() => {
    const file = read();
    const c = file.credentials.find((x) => x.id === id && x.userId === userId);
    if (!c) throw new CredentialError("not-found", "no such credential");
    const secret = open(keyOf(file), c);
    writeFile({ ...file, credentials: file.credentials.map((x) => (x === c ? { ...x, lastUsed: new Date().toISOString() } : x)) });
    return secret;
  });
}

export interface Removed {
  removed: number;
  keyId: string | null;
  oldKeysLeft: number;
}

/**
 * Removes one credential (`id`) or all of a user's, then replaces the key so older copies of the file are useless.
 * Only inside withAuthLock. With no file nothing is created.
 */
export function removeCredentialsLocked(userId: string, id?: string): Removed {
  if (!authLockHeld()) throw new Error("removeCredentialsLocked must run inside withAuthLock");
  const file = read();
  const gone = file.credentials.filter((c) => c.userId === userId && (id === undefined || c.id === id));
  if (!gone.length) {
    // nothing to remove, but a retry still cleans old keys that could not be removed before
    if (!file.retiredKeyIds.length) return { removed: 0, keyId: file.keyId, oldKeysLeft: 0 };
    const retired = dropRetired(file.retiredKeyIds);
    if (retired.length !== file.retiredKeyIds.length) writeFile({ ...file, retiredKeyIds: retired });
    return { removed: 0, keyId: file.keyId, oldKeysLeft: retired.length };
  }
  const keep = file.credentials.filter((c) => !gone.includes(c));
  if (file.keyId && keep.length && findKey(file.keyId) === undefined) {
    // the key was removed by hand: nothing left can be read, so only the entries go
    writeFile({ ...file, credentials: keep });
    return { removed: gone.length, keyId: file.keyId, oldKeysLeft: file.retiredKeyIds.length };
  }
  const { next, oldKeysLeft } = replaceKey(file, keep);
  return { removed: gone.length, keyId: next.keyId, oldKeysLeft };
}

export const removeCredential = (userId: string, id: string): Removed => withAuthLock(() => removeCredentialsLocked(userId, id));

export interface Rotated {
  rotated: boolean;
  count: number;
  keyId: string | null;
  oldKeysLeft: number;
}

/** Re-encrypts every credential under a new key. */
export function rotateKey(): Rotated {
  return withAuthLock(() => {
    const file = read();
    if (!file.credentials.length) {
      if (file.retiredKeyIds.length) {
        const retired = dropRetired(file.retiredKeyIds);
        if (retired.length !== file.retiredKeyIds.length) writeFile({ ...file, retiredKeyIds: retired });
        return { rotated: false, count: 0, keyId: file.keyId, oldKeysLeft: retired.length };
      }
      return { rotated: false, count: 0, keyId: file.keyId, oldKeysLeft: 0 };
    }
    const { next, oldKeysLeft } = replaceKey(file, file.credentials);
    return { rotated: true, count: next.credentials.length, keyId: next.keyId, oldKeysLeft };
  });
}

/** Every stored secret, for redaction. Reads the Keychain once. Throws StoreError or KeyError. */
export function allSecrets(): string[] {
  const file = read();
  if (!file.credentials.length) return [];
  const key = keyOf(file);
  return file.credentials.map((c) => open(key, c));
}

/** Adds and removes a probe item to prove the Keychain works. Throws KeyError. */
export function checkKeychain(): void {
  const id = randomUUID();
  const hex = newKey();
  addKey(id, hex);
  try {
    if (findKey(id) !== hex) throw new KeyError("failed", "the Keychain did not give back what was stored");
  } finally {
    deleteKey(id);
  }
}
