import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { listRepos } from "../auth/repos.js";
import { githubKey, tryParseRepoUrl, validGithubName } from "../auth/repo-url.js";
import { authLockHeld, dataHome, readJsonFile, withAuthLock, writeJsonFile } from "../auth/store.js";
import { getUser } from "../auth/users.js";

export type RefinementErrorCode = "bad-idea" | "bad-title" | "bad-repo" | "no-owner" | "not-yours" | "limit" | "not-found" | "not-owner" | "bad-state";

/** A problem with what the caller asked for (not with the file). The message is safe to show. */
export class RefinementError extends Error {
  constructor(
    public code: RefinementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RefinementError";
  }
}

export const refinementsPath = () => join(dataHome(), "refinements.json");

/** At most this many sessions per account; dropped sessions count until they are removed. */
export const SESSION_LIMIT = 200;
export const IDEA_MAX = 10_000;
export const TITLE_MAX = 120;
/** A session keeps at most this many log entries; the last one is kept free so the session can still be dropped. */
export const LOG_LIMIT = 1000;
/** A dropped session is removed after this long. */
export const DROP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export const STATES = ["exploring", "drafting", "ready", "published", "dropped"] as const;
export type SessionState = (typeof STATES)[number];
const OPEN_STATES = STATES.filter((s) => s !== "dropped") as Exclude<SessionState, "dropped">[];

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_IN_IDEA = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const LogEntry = z
  .object({ at: z.iso.datetime(), by: z.uuid(), what: z.enum(["created", "renamed", "dropped", "restored"]), detail: z.string().max(TITLE_MAX).optional() })
  .strict();

const SessionSchema = z
  .object({
    id: z.uuid(),
    owner: z.uuid(),
    repo: z.string().refine(validGithubName),
    title: z.string().min(1).max(TITLE_MAX),
    idea: z.string().min(1).max(IDEA_MAX),
    state: z.enum(STATES),
    stateBefore: z.enum(OPEN_STATES as [string, ...string[]]).optional(),
    droppedAt: z.iso.datetime().optional(),
    drafts: z.array(z.never()).max(0),
    log: z.array(LogEntry).min(1).max(LOG_LIMIT),
    created: z.iso.datetime(),
    updated: z.iso.datetime(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = (path: string) => ctx.addIssue({ code: "custom", message: "invalid", path: [path] });
    if (s.state === "dropped") {
      if (s.droppedAt === undefined) issue("droppedAt");
      if (s.stateBefore === undefined) issue("stateBefore");
    } else {
      if (s.droppedAt !== undefined) issue("droppedAt");
      if (s.stateBefore !== undefined) issue("stateBefore");
    }
  });

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
export type LogItem = z.infer<typeof LogEntry>;
type FileData = z.infer<typeof FileSchema>;

const EMPTY: FileData = { version: 1, sessions: [] };
const read = (): FileData => readJsonFile(refinementsPath(), FileSchema, EMPTY);
const save = (sessions: Session[]) => writeJsonFile(refinementsPath(), { version: 1, sessions });
const copy = (s: Session): Session => structuredClone(s);

export interface StoreOptions {
  now?: () => Date;
}

const clock = (opts: StoreOptions) => (opts.now ?? (() => new Date()))();
const expired = (s: Session, now: Date) => s.droppedAt !== undefined && now.getTime() - Date.parse(s.droppedAt) >= DROP_KEEP_MS;

// ---- checking input --------------------------------------------------------------------------------

function checkIdea(input: unknown): string {
  const bad = (m: string) => new RefinementError("bad-idea", m);
  if (typeof input !== "string") throw bad("describe your idea");
  const idea = input.replace(/\r\n/g, "\n").trim();
  if (!idea) throw bad("describe your idea");
  if (idea.length > IDEA_MAX) throw bad(`the idea can have at most ${IDEA_MAX} characters`);
  if (CONTROL_IN_IDEA.test(idea)) throw bad("the idea has characters that are not allowed");
  return idea;
}

function checkTitle(input: unknown): string {
  const bad = (m: string) => new RefinementError("bad-title", m);
  if (typeof input !== "string") throw bad("the title must be text");
  const title = input.trim();
  if (!title) throw bad("give a title");
  if (title.length > TITLE_MAX) throw bad(`the title can have at most ${TITLE_MAX} characters`);
  if (CONTROL.test(title)) throw bad("the title has characters that are not allowed");
  return title;
}

/** The first non-empty line of the idea, tabs as spaces, cut to the title length. */
function titleFromIdea(idea: string): string {
  const line = idea.split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/\t/g, " ").replace(CONTROL, " ").trim().slice(0, TITLE_MAX).trim() || "Untitled";
}

// ---- default checks (under the lock) ---------------------------------------------------------------

const defaultOwnerOk = (id: string) => getUser(id) !== undefined;

/** The name of the account's GitHub repository (from its record), or undefined when the account has no such one. */
function defaultRepoName(owner: string, name: string): string | undefined {
  const key = githubKey(name);
  for (const r of listRepos(owner)) {
    const p = tryParseRepoUrl(r.url);
    if (p?.github !== undefined && p.key === key) return key.slice("github.com/".length);
  }
  return undefined;
}

export interface CreateOptions extends StoreOptions {
  ownerOk?: (userId: string) => boolean;
  repoName?: (userId: string, name: string) => string | undefined;
}

export interface NewSession {
  repo: unknown;
  idea: unknown;
  title?: unknown;
}

// ---- reading ---------------------------------------------------------------------------------------

/** The sessions that are not expired, newest change first; of one account when `owner` is given. */
export function listSessions(owner?: string, opts: StoreOptions = {}): Session[] {
  const now = clock(opts);
  return read()
    .sessions.filter((s) => !expired(s, now) && (owner === undefined || s.owner === owner))
    .sort((a, b) => b.updated.localeCompare(a.updated))
    .map(copy);
}

export function getSession(id: string, opts: StoreOptions = {}): Session | undefined {
  const now = clock(opts);
  const s = read().sessions.find((x) => x.id === id && !expired(x, now));
  return s ? copy(s) : undefined;
}

/** Throws when the file cannot be read; writes nothing. */
export function checkRefinements(): void {
  read();
}

// ---- changing --------------------------------------------------------------------------------------

export function createSession(owner: string, input: NewSession, opts: CreateOptions = {}): Session {
  const idea = checkIdea(input.idea);
  const title = input.title === undefined || input.title === null || (typeof input.title === "string" && !input.title.trim()) ? undefined : checkTitle(input.title);
  if (typeof input.repo !== "string" || !validGithubName(input.repo)) throw new RefinementError("bad-repo", "give a GitHub repository as owner/name");
  const given = input.repo;
  return withAuthLock(() => {
    if (!(opts.ownerOk ?? defaultOwnerOk)(owner)) throw new RefinementError("no-owner", "no such account");
    const repo = (opts.repoName ?? defaultRepoName)(owner, given);
    if (repo === undefined) throw new RefinementError("not-yours", "that is not one of your GitHub repositories");
    const now = clock(opts);
    const file = read();
    const kept = file.sessions.filter((s) => !expired(s, now));
    if (kept.filter((s) => s.owner === owner).length >= SESSION_LIMIT) {
      throw new RefinementError("limit", `at most ${SESSION_LIMIT} sessions; dropped sessions count until they are removed after 30 days`);
    }
    const at = now.toISOString();
    const session: Session = {
      id: randomUUID(),
      owner,
      repo,
      title: title ?? titleFromIdea(idea),
      idea,
      state: "exploring",
      drafts: [],
      log: [{ at, by: owner, what: "created" }],
      created: at,
      updated: at,
    };
    save([...kept, session]);
    return copy(session);
  });
}

export interface Actor {
  id: string;
  admin: boolean;
}

/**
 * Finds the session for an actor, changes it under the lock and writes the file. Expired sessions are removed on the way.
 * `fn` returns the changed session, or undefined when nothing changes.
 */
function change(actor: Actor, id: string, opts: StoreOptions, mayAdmin: boolean, fn: (s: Session, at: string) => Session | undefined): Session {
  return withAuthLock(() => {
    const now = clock(opts);
    const file = read();
    const kept = file.sessions.filter((s) => !expired(s, now));
    const cur = kept.find((s) => s.id === id);
    if (!cur || (cur.owner !== actor.id && !actor.admin)) throw new RefinementError("not-found", "no such refinement session");
    if (cur.owner !== actor.id && !mayAdmin) throw new RefinementError("not-owner", "only the owner can change this session");
    const next = fn(cur, now.toISOString());
    if (!next && kept.length === file.sessions.length) return copy(cur);
    save(next ? kept.map((s) => (s === cur ? next : s)) : kept);
    return copy(next ?? cur);
  });
}

const room = (s: Session, last: number) => {
  if (s.log.length + 1 > last) throw new RefinementError("limit", "the log of this session is full; it can only be dropped");
};

export function renameSession(actor: Actor, id: string, title: unknown, opts: StoreOptions = {}): Session {
  return change(actor, id, opts, false, (s, at) => {
    if (s.state === "dropped") throw new RefinementError("bad-state", "a dropped session cannot be renamed; restore it first");
    const t = checkTitle(title);
    if (s.title === t) return undefined;
    room(s, LOG_LIMIT - 1);
    return { ...s, title: t, updated: at, log: [...s.log, { at, by: actor.id, what: "renamed", detail: t }] };
  });
}

export function dropSession(actor: Actor, id: string, opts: StoreOptions = {}): Session {
  return change(actor, id, opts, true, (s, at) => {
    if (s.state === "dropped") throw new RefinementError("bad-state", "that session is dropped already");
    room(s, LOG_LIMIT);
    return { ...s, state: "dropped", stateBefore: s.state, droppedAt: at, updated: at, log: [...s.log, { at, by: actor.id, what: "dropped" }] };
  });
}

export function restoreSession(actor: Actor, id: string, opts: StoreOptions = {}): Session {
  return change(actor, id, opts, false, (s, at) => {
    if (s.state !== "dropped" || s.stateBefore === undefined) throw new RefinementError("bad-state", "that session is not dropped");
    room(s, LOG_LIMIT - 1);
    const { stateBefore, droppedAt: _droppedAt, ...rest } = s;
    return { ...rest, state: stateBefore as SessionState, updated: at, log: [...s.log, { at, by: actor.id, what: "restored" }] };
  });
}

/** Removes the dropped sessions that are past their 30 days. Returns how many. A missing file is not created. */
export function purgeDropped(opts: StoreOptions = {}): number {
  try {
    lstatSync(refinementsPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
  }
  return withAuthLock(() => {
    const now = clock(opts);
    const file = read();
    const kept = file.sessions.filter((s) => !expired(s, now));
    if (kept.length === file.sessions.length) return 0;
    save(kept);
    return file.sessions.length - kept.length;
  });
}

/** Removes the sessions of an account. Only inside withAuthLock; writes nothing when there are none. */
export function removeRefinementsLocked(owner: string): number {
  if (!authLockHeld()) throw new Error("removeRefinementsLocked must run inside withAuthLock");
  const file = read();
  const mine = file.sessions.filter((s) => s.owner === owner);
  if (!mine.length) return 0;
  save(file.sessions.filter((s) => s.owner !== owner));
  return mine.length;
}
