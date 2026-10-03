import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CredentialError, addCredentialLocked, checkSecret, listCredentials, moveCredentialLocked, oldKeysLeft as credentialKeysLeft, removeCredentialsLocked } from "../credentials/store.js";
import { RepoSettingsSchema, checkRepoSettings } from "./repo-settings.js";
import { type ParsedRepoUrl, RepoError, type RepoErrorCode, githubKey, parseRepoUrl, tryParseRepoUrl, validGithubName } from "./repo-url.js";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "./store.js";
import { type User, UserError, checkEmail, findUserByEmail, getUser } from "./users.js";

export { RepoError };
export type { RepoErrorCode };

/** The record was saved, but its token could not be saved and the record could not be taken back. Change the token again to repair it. */
export class RepoHalfSaved extends Error {
  constructor() {
    super("the repository was saved without its token; set the token again");
    this.name = "RepoHalfSaved";
  }
}

export const reposPath = () => join(dataHome(), "repos.json");

/** At most this many repositories per account. */
export const REPO_LIMIT = 50;

export const REPO_METHODS = ["none", "github-token", "https-token"] as const;
export type RepoMethod = (typeof REPO_METHODS)[number];

const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,100}$/;
const GITHUB_TOKEN_PREFIX = "github_pat_";

// ---- the file --------------------------------------------------------------------------------------

/** An address as an old install stored it: https://github.com/<name>, where the name may end in ".git". */
const legacyUrl = (url: string) => url.startsWith("https://github.com/") && validGithubName(url.slice("https://github.com/".length));

const RecordSchema = z
  .object({
    id: z.uuid(),
    owner: z.uuid(),
    url: z.string(),
    method: z.enum(REPO_METHODS),
    credentialId: z.uuid().optional(),
    username: z.string().optional(),
    added: z.iso.datetime(),
    settings: RepoSettingsSchema.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: "custom", message: "invalid", path: [path] });
    const p = tryParseRepoUrl(r.url);
    if (!p || (p.url !== r.url && !legacyUrl(r.url))) issue("url");
    if (r.method === "none") {
      if (r.credentialId !== undefined) issue("credentialId");
      if (r.username !== undefined) issue("username");
      return;
    }
    if (!r.credentialId) issue("credentialId");
    if (p && (p.scheme !== "https" || (r.method === "github-token" && p.host !== "github.com"))) issue("method");
    if (r.method === "github-token" ? r.username !== undefined : r.username === undefined || !USERNAME_RE.test(r.username)) issue("username");
  });

const FileV2 = z
  .object({ version: z.literal(2), repos: z.array(RecordSchema) })
  .strict()
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    const per = new Map<string, number>();
    f.repos.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", message: "duplicate", path: ["repos", i, "id"] });
      ids.add(r.id);
      const n = (per.get(r.owner) ?? 0) + 1;
      per.set(r.owner, n);
      if (n > REPO_LIMIT) ctx.addIssue({ code: "custom", message: "too many", path: ["repos", i, "owner"] });
    });
  });

const FileV1 = z
  .object({
    version: z.literal(1),
    repos: z.record(z.uuid(), z.array(z.string().refine(validGithubName)).max(REPO_LIMIT)),
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const [id, names] of Object.entries(f.repos)) {
      const seen = new Set(names.map((n) => n.toLowerCase()));
      if (seen.size !== names.length) ctx.addIssue({ code: "custom", message: "duplicate", path: ["repos", id] });
    }
  });

export type RepoRecord = z.infer<typeof RecordSchema>;
type RepoFile = z.infer<typeof FileV2>;
/** What a user may see: the record without the admin's settings. */
export type PublicRepo = Omit<RepoRecord, "settings">;
const strip = ({ settings: _s, ...rest }: RepoRecord): PublicRepo => ({ ...rest });

/** The same id for the same old entry on every read, so a link to it keeps working until the file is rewritten. */
function legacyId(owner: string, name: string): string {
  const h = createHash("sha256").update(`${owner}\n${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Reads the file. Version 1 (a list of names per account) becomes records with the method "none". */
function read(): RepoFile {
  const f = readJsonFile(reposPath(), z.union([FileV2, FileV1]), { version: 2, repos: [] } as z.infer<typeof FileV2> | z.infer<typeof FileV1>);
  if (f.version === 2) return f;
  let added = new Date(0).toISOString();
  try {
    added = statSync(reposPath()).mtime.toISOString();
  } catch {
    // keep the fallback
  }
  const repos: RepoRecord[] = [];
  for (const [owner, names] of Object.entries(f.repos)) {
    for (const name of names) repos.push({ id: legacyId(owner, name), owner, url: `https://github.com/${name}`, method: "none", added });
  }
  return { version: 2, repos };
}

const save = (repos: RepoRecord[]) => writeJsonFile(reposPath(), { version: 2, repos });
const keyOfRecord = (r: RepoRecord) => tryParseRepoUrl(r.url)?.key ?? r.url;
const pathOfRecord = (r: RepoRecord) => r.url.replace(/^https:\/\/github\.com\//, "");

// ---- reading ---------------------------------------------------------------------------------------

/** The repositories of an account, in the order they were added. A record never holds a secret. */
export const listRepos = (userId: string): PublicRepo[] => read().repos.filter((r) => r.owner === userId).map(strip);

/** Every repository of every account, with the admin settings. Only for an admin's call. */
export const listAllRepos = (): RepoRecord[] => read().repos.map((r) => ({ ...r }));

/** True when the account has this GitHub repository (any case, with or without ".git", https or ssh). */
export function ownsRepo(userId: string, name: string): boolean {
  const key = githubKey(name);
  return read().repos.some((r) => r.owner === userId && tryParseRepoUrl(r.url)?.github !== undefined && keyOfRecord(r) === key);
}

// ---- checks ----------------------------------------------------------------------------------------

const badAuth = (message: string) => new RepoError("bad-auth", message);

function checkToken(input: unknown): string {
  if (typeof input !== "string") throw badAuth("a token is needed");
  try {
    return checkSecret("token", input);
  } catch (e) {
    if (e instanceof CredentialError) throw badAuth(e.message);
    throw e;
  }
}

interface AuthInput {
  method: unknown;
  username?: unknown;
  token?: unknown;
}
interface Checked {
  method: RepoMethod;
  username?: string;
  token?: string;
}

/** Checks a method with its user name and token for a URL. A token is only read when `needToken` is set or one is given. */
function checkAuth(url: ParsedRepoUrl, a: AuthInput, needToken: boolean): Checked {
  const method = a.method;
  if (!REPO_METHODS.includes(method as RepoMethod)) throw badAuth(`the method must be one of: ${REPO_METHODS.join(", ")}`);
  if (method === "none") {
    if (a.username !== undefined || a.token !== undefined) throw badAuth('a token and a user name need a method ("github-token" or "https-token")');
    return { method };
  }
  if (url.scheme !== "https") throw badAuth(`"${method as string}" works only with an https address`);
  const out: Checked = { method: method as RepoMethod };
  if (method === "github-token") {
    if (url.host !== "github.com") throw badAuth('"github-token" works only for a repository on github.com');
    if (a.username !== undefined) throw badAuth('"github-token" has no user name');
  } else {
    if (typeof a.username !== "string" || !USERNAME_RE.test(a.username)) throw badAuth('"https-token" needs a user name (letters, digits and "._@+-", no spaces or ":")');
    out.username = a.username;
  }
  if (needToken || a.token !== undefined) {
    out.token = checkToken(a.token);
    if (method === "github-token" && !out.token.startsWith(GITHUB_TOKEN_PREFIX)) throw badAuth(`a GitHub fine-grained token starts with "${GITHUB_TOKEN_PREFIX}"`);
  }
  return out;
}

const ownerExists = (opts: { ownerOk?: (userId: string) => boolean }, userId: string) => {
  if (!(opts.ownerOk ?? ((id: string) => getUser(id) !== undefined))(userId)) throw new RepoError("no-owner", "no such account");
};

const secretName = (r: Pick<RepoRecord, "id">) => `repo:${r.id}`;

/** Removes the token a record names, only when it is the record's own (right id, owner and name). Returns the old keys left. */
function wipeToken(r: RepoRecord): number {
  const c = r.credentialId ? listCredentials(r.owner).find((x) => x.id === r.credentialId && x.name === secretName(r)) : undefined;
  return cleanKeys(r.owner, c?.id);
}

/** Removes a token (when `id` is given) and always retries old Keychain keys that could not be removed before. */
const cleanKeys = (owner: string, id?: string) => removeCredentialsLocked(owner, id ?? "").oldKeysLeft;

// ---- changing --------------------------------------------------------------------------------------

export interface NewRepo {
  url: unknown;
  method?: unknown;
  username?: unknown;
  token?: unknown;
}

/**
 * Adds a repository. The record is written first and the token second, and a failed second write takes the record back,
 * so no token exists without a record. `ownerOk` says whether the account exists (default: it is in users.json).
 */
export function addRepo(userId: string, given: NewRepo | string, opts: { ownerOk?: (userId: string) => boolean } = {}): PublicRepo {
  const input: NewRepo = typeof given === "string" ? { url: given } : given;
  const url = parseRepoUrl(input.url);
  const auth = checkAuth(url, { method: input.method ?? "none", username: input.username, token: input.token }, input.method !== undefined && input.method !== "none");
  return withAuthLock(() => {
    ownerExists(opts, userId);
    const file = read();
    if (file.repos.some((r) => r.owner === userId && keyOfRecord(r) === url.key)) throw new RepoError("duplicate", "you have that repository already");
    if (file.repos.some((r) => keyOfRecord(r) === url.key)) throw new RepoError("taken", "that repository belongs to another account");
    if (file.repos.filter((r) => r.owner === userId).length >= REPO_LIMIT) throw new RepoError("limit", `at most ${REPO_LIMIT} repositories`);
    const id = randomUUID();
    const credentialId = auth.token ? randomUUID() : undefined;
    const record: RepoRecord = {
      id,
      owner: userId,
      url: url.url,
      method: auth.method,
      ...(credentialId ? { credentialId } : {}),
      ...(auth.username ? { username: auth.username } : {}),
      added: new Date().toISOString(),
    };
    save([...file.repos, record]);
    if (credentialId) {
      try {
        addCredentialLocked({ id: credentialId, userId, type: "token", name: secretName(record), secret: auth.token });
      } catch (e) {
        try {
          save(file.repos);
        } catch {
          throw new RepoHalfSaved();
        }
        throw e;
      }
    }
    return strip(record);
  });
}

export interface AuthChange {
  method?: unknown;
  username?: unknown;
  token?: unknown;
  /** Another form of the same repository. */
  url?: unknown;
}

/**
 * Changes the method, user name, token or address of a record; what is not given keeps its value. The old token is wiped
 * first, then the record is written, then the new token is saved. A failure in between leaves a record that names a missing
 * token (never a token without a record); giving the token again repairs it.
 */
export function setRepoAuth(userId: string, id: string, input: AuthChange, opts: { ownerOk?: (userId: string) => boolean } = {}): { repo: PublicRepo; oldKeysLeft: number } {
  if ([input.method, input.username, input.token, input.url].every((v) => v === undefined)) throw badAuth("give a method, a user name, a token or an address");
  return withAuthLock(() => {
    ownerExists(opts, userId);
    const file = read();
    const rec = file.repos.find((r) => r.id === id && r.owner === userId);
    if (!rec) throw new RepoError("not-found", "no such repository");
    let url = parseRepoUrl(rec.url);
    if (input.url !== undefined) {
      const given = parseRepoUrl(input.url);
      if (given.key !== keyOfRecord(rec)) throw new RepoError("bad-url", "that is another repository; the address can only change to another form of the same one");
      url = given;
    }
    const method = input.method ?? rec.method;
    const changed = method !== rec.method;
    const username = input.username ?? (changed ? undefined : rec.username);
    if (changed && method !== "none" && input.token === undefined) throw badAuth("a new method needs a token");
    const auth = checkAuth(url, { method, username, token: input.token }, false);
    if (auth.token !== undefined && listCredentials(userId).some((c) => c.name === secretName(rec) && c.id !== rec.credentialId)) {
      throw badAuth("a credential with the reserved name of this repository exists already");
    }
    const credentialId = auth.method === "none" ? undefined : auth.token !== undefined ? randomUUID() : rec.credentialId;
    const next: RepoRecord = {
      id: rec.id,
      owner: rec.owner,
      url: input.url !== undefined ? url.url : rec.url,
      method: auth.method,
      ...(credentialId ? { credentialId } : {}),
      ...(auth.username ? { username: auth.username } : {}),
      added: rec.added,
      ...(rec.settings ? { settings: rec.settings } : {}),
    };
    let oldKeysLeft = 0;
    // a change to none also on a record that is none already: a retry cleans an old key left by the first try
    if (auth.token !== undefined || auth.method === "none") oldKeysLeft = wipeToken(rec);
    if (JSON.stringify(next) !== JSON.stringify(rec) || auth.token !== undefined) save(file.repos.map((r) => (r === rec ? next : r)));
    if (auth.token !== undefined) {
      addCredentialLocked({ id: credentialId!, userId, type: "token", name: secretName(rec), secret: auth.token });
      // saving retries old keys too, so the count from the wipe may be out of date
      oldKeysLeft = credentialKeysLeft();
    }
    return { repo: strip(next), oldKeysLeft };
  });
}

/** Removes the record picked by `pick` from the account's own records, wiping its token first. */
function removeWhere(userId: string, pick: (mine: RepoRecord[]) => RepoRecord | undefined): { oldKeysLeft: number } {
  return withAuthLock(() => {
    const file = read();
    const rec = pick(file.repos.filter((r) => r.owner === userId));
    if (!rec) {
      // a retry of a removal that left an old key: finish the cleanup, and report it while it is not done
      const left = cleanKeys(userId);
      if (left) return { oldKeysLeft: left };
      throw new RepoError("not-found", "no such repository");
    }
    const oldKeysLeft = wipeToken(rec);
    save(file.repos.filter((r) => r !== rec));
    return { oldKeysLeft };
  });
}

/** Removes one of the account's repositories by its id, and its token. */
export const removeRepo = (userId: string, id: string) => removeWhere(userId, (mine) => mine.find((r) => r.id === id));

/**
 * Removes a GitHub repository by its name (the old form of the call). The record written exactly like the name goes first;
 * otherwise the first one that is the same repository.
 */
export const removeGithubRepo = (userId: string, name: string) =>
  removeWhere(userId, (mine) => {
    const key = githubKey(name);
    const same = mine.filter((r) => tryParseRepoUrl(r.url)?.github !== undefined && keyOfRecord(r) === key);
    return same.find((r) => pathOfRecord(r).toLowerCase() === name.toLowerCase()) ?? same[0];
  });

/** Removes the records of an account (their tokens go with the account's credentials). Only inside withAuthLock; writes nothing when there are none. */
export function removeReposLocked(userId: string): number {
  if (!authLockHeld()) throw new Error("removeReposLocked must run inside withAuthLock");
  const file = read();
  const mine = file.repos.filter((r) => r.owner === userId);
  if (!mine.length) return 0;
  save(file.repos.filter((r) => r.owner !== userId));
  return mine.length;
}

// ---- admin: settings and transfer ------------------------------------------------------------------

/** Sets (or, with {}, clears) the admin settings of any repository. Returns the record with its settings. */
export function setRepoSettings(id: string, input: unknown): RepoRecord {
  const settings = checkRepoSettings(input);
  return withAuthLock(() => {
    const file = read();
    const rec = file.repos.find((r) => r.id === id);
    if (!rec) throw new RepoError("not-found", "no such repository");
    const { settings: _old, ...rest } = rec;
    const next: RepoRecord = Object.keys(settings).length ? { ...rest, settings } : rest;
    if (JSON.stringify(next) !== JSON.stringify(rec)) save(file.repos.map((r) => (r === rec ? next : r)));
    return { ...next };
  });
}

/** Methods whose secret is a personal token: it is wiped when the repository changes owner. */
export const PERSONAL_METHODS: readonly RepoMethod[] = ["github-token", "https-token"];
/** Methods whose secret belongs to the repository (a deploy key, a GitHub App installation): it moves with the repository. */
export const REPO_BOUND_METHODS: readonly RepoMethod[] = [];

export interface TransferOptions {
  /** Finds the new owner by e-mail (default: users.json). */
  findOwner?: (email: string) => Pick<User, "id" | "status"> | undefined;
}

const EMAIL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Moves a repository to the account with the given e-mail. A personal token is wiped and the record reads "none"; a
 * repository-bound secret is re-encrypted for the new owner. The secret goes first and the record second, so a failure in
 * between leaves the record with the old owner, and repeating the transfer finishes it.
 */
export function transferRepo(id: string, emailInput: unknown, opts: TransferOptions = {}): { repo: RepoRecord; oldKeysLeft: number } {
  if (typeof emailInput !== "string" || !emailInput.trim()) throw new RepoError("bad-owner", "give the e-mail of the new owner");
  let email = "";
  try {
    email = checkEmail(emailInput);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
  }
  if (!email || EMAIL_CONTROL.test(email)) throw new RepoError("bad-owner", "that is not a valid e-mail address");
  return withAuthLock(() => {
    const owner = (opts.findOwner ?? findUserByEmail)(email);
    if (!owner) throw new RepoError("no-owner", "no account has that e-mail");
    if (owner.status === "blocked") throw new RepoError("blocked", "that account is blocked");
    const file = read();
    const rec = file.repos.find((r) => r.id === id);
    if (!rec) throw new RepoError("not-found", "no such repository");
    // a repeat after a failed first try: the record is moved already, so only old keys are cleaned
    if (rec.owner === owner.id) return { repo: { ...rec }, oldKeysLeft: cleanKeys(owner.id) };
    if (file.repos.some((r) => r.owner === owner.id && keyOfRecord(r) === keyOfRecord(rec))) throw new RepoError("duplicate", "that account has that repository already");
    if (file.repos.filter((r) => r.owner === owner.id).length >= REPO_LIMIT) throw new RepoError("limit", `that account has ${REPO_LIMIT} repositories already`);
    let next: RepoRecord = { ...rec, owner: owner.id };
    let oldKeysLeft = 0;
    if (REPO_BOUND_METHODS.includes(rec.method)) {
      if (!rec.credentialId || moveCredentialLocked(rec.owner, owner.id, rec.credentialId, secretName(rec)) === "missing") {
        throw new RepoError("no-credential", "the sign-in of this repository is missing; set it again before the transfer");
      }
    } else if (rec.method !== "none") {
      oldKeysLeft = wipeToken(rec);
      const { credentialId: _c, username: _u, ...bare } = next;
      next = { ...bare, method: "none" };
    }
    save(file.repos.map((r) => (r === rec ? next : r)));
    return { repo: { ...next }, oldKeysLeft };
  });
}
