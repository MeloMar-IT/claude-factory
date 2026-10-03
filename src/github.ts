import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Marker in every comment the factory writes, e.g. <!-- claude-factory run=… --> */
export const BOT_MARKER = "<!-- claude-factory";
/** Markers that identify our own comments: the one we write, and the new product name's. */
export const BOT_MARKERS = [BOT_MARKER, "<!-- spaghetti-code-foundry"] as const;

/** `timeoutMs` kills the process and rejects; without it gh may take as long as it likes. */
export async function gh(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, input?: string): Promise<string> {
  const p = exec(process.env.FACTORY_GH_BIN ?? "gh", args, {
    maxBuffer: 20_000_000,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs,
  });
  if (input !== undefined) {
    p.child.stdin?.on("error", () => {}); // gh may exit before it reads everything; its exit code tells
    p.child.stdin?.end(input);
  }
  return (await p).stdout;
}

/** One resource of GitHub's request limit (`gh api rate_limit`). */
export interface RateResource { limit: number; used: number; remaining: number; reset: number }
/** What `gh api rate_limit` said, and when it was read. */
export interface RateReading { at: string; resources: Record<string, RateResource> }

/** The valid resources of a `rate_limit` answer. */
export function parseRateLimit(text: string, at = new Date(), prefix = ""): RateReading | undefined {
  try {
    const res = (JSON.parse(text) as { resources?: Record<string, Partial<RateResource>> }).resources ?? {};
    const resources: Record<string, RateResource> = {};
    // Every valid resource (core, graphql, search, …); `prefix` names another identity ("bot:").
    for (const [k, r] of Object.entries(res)) {
      if (r && [r.limit, r.used, r.remaining, r.reset].every((n) => typeof n === "number" && Number.isFinite(n)) && r.limit! > 0) {
        resources[`${prefix}${k}`] = { limit: r.limit!, used: r.used!, remaining: r.remaining!, reset: r.reset! };
      }
    }
    return Object.keys(resources).length ? { at: at.toISOString(), resources } : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the request limit (this call does not count against it). Never throws; undefined when it cannot be read. */
export async function readRateLimit(timeoutMs = 4_000, env?: NodeJS.ProcessEnv, prefix = ""): Promise<RateReading | undefined> {
  try {
    return parseRateLimit(await gh(["api", "rate_limit"], env, timeoutMs), new Date(), prefix);
  } catch {
    return undefined;
  }
}

export async function ghJson<T>(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<T> {
  const out = (await gh(args, env, timeoutMs)).trim();
  return (out ? JSON.parse(out) : []) as T;
}

export interface Comment {
  author: { login: string };
  body: string;
  createdAt: string;
  /** Link to the comment (…#issuecomment-<id>); gh reports it. */
  url?: string;
  /** Did the account `gh` acts as write it? */
  viewerDidAuthor?: boolean;
}

export interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
  body?: string;
  state?: string;
}

export const isBot = (c: { body: string }) => BOT_MARKERS.some((m) => c.body.includes(m));

/** Last line of the status comment: the one comment per issue the Foundry keeps up to date. */
export const STATUS_MARKER = "<!-- claude-factory status -->";
const STATUS_MARKERS: readonly string[] = [STATUS_MARKER, "<!-- spaghetti-code-foundry status -->"];

/** A status comment has its marker as the last line; a comment that only quotes the marker is not one. */
export function isStatusComment(c: { body: string }): boolean {
  const last = c.body.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last !== undefined && STATUS_MARKERS.includes(last);
}

/** The numeric id in a comment link (…#issuecomment-123). */
export function commentId(url: string | undefined): string | undefined {
  return /#issuecomment-(\d+)\s*$/.exec(url?.trim() ?? "")?.[1];
}

const normal = (t: string) => t.replace(/\r\n/g, "\n").trim();
/** Is this the same comment text? Line ends and trailing white space do not count; no text is never the same. */
export function sameBody(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normal(a) === normal(b);
}

export async function issueComments(repo: string, issue: number | string, timeoutMs?: number): Promise<Comment[]> {
  const r = await ghJson<{ comments: Comment[] }>(["issue", "view", String(issue), "--repo", repo, "--json", "comments,labels"], undefined, timeoutMs);
  return r.comments ?? [];
}

/** The permission GitHub reports for this user on the repo ("admin", "write", "read", …). Rejects when GitHub cannot tell. */
export async function repoPermission(repo: string, login: string, timeoutMs?: number): Promise<string> {
  return (await gh(["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"], undefined, timeoutMs)).trim();
}

/** Does this permission allow pushing? */
export const mayWrite = (perm: string) => ["admin", "maintain", "write"].includes(perm);

/** Can this user push to the repo? Used to trust /approve and /reject. A failing call counts as no. */
export async function canWrite(repo: string, login: string): Promise<boolean> {
  try {
    return mayWrite(await repoPermission(repo, login));
  } catch {
    return false;
  }
}

/** The login `gh` acts as. */
export async function ghLogin(timeoutMs?: number): Promise<string> {
  return (await gh(["api", "user", "--jq", ".login"], undefined, timeoutMs)).trim();
}

/** Posts a comment; the text goes through stdin (not a shell, not the process list). Returns the id of the new comment when gh prints its link. */
export async function commentOnIssue(repo: string, issue: number, body: string, timeoutMs?: number): Promise<string | undefined> {
  const out = await gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], undefined, timeoutMs, body);
  return commentId(out.split("\n").map((l) => l.trim()).filter(Boolean).at(-1));
}

export interface UpsertOptions {
  /** The comment id from an earlier call: edit it without reading the issue. */
  id?: string;
  /** Post a new comment when the issue has none of ours. */
  create: boolean;
  timeoutMs?: number;
  /** Time (ms since epoch) after which no call is made: the call rejects with "out of time". */
  deadline?: number;
  /** The login gh acts as, when known (saves a call). */
  login?: string;
}
export interface UpsertResult {
  id?: string;
  /** Created or edited. */
  changed: boolean;
  /** A new comment was posted. */
  created?: boolean;
  /** Extra status comments of ours that were deleted. */
  removed: number;
  /** Extra status comments of ours that could not be deleted. */
  left: number;
  login?: string;
}

const MAX_REMOVE = 5;

/**
 * Keeps one status comment of ours on an issue: edits it, or creates it. Ours means: marker on the last line and
 * written by the account gh acts as. Extra ones of ours (an older one exists) are deleted, best effort.
 * Rejects when a needed call fails, the comment has no link, or the deadline has passed.
 */
export async function upsertStatusComment(repo: string, issue: number, body: string, o: UpsertOptions): Promise<UpsertResult> {
  let login = o.login;
  const limit = () => {
    const left = o.deadline === undefined ? undefined : o.deadline - Date.now();
    if (left !== undefined && left <= 0) throw new Error("out of time");
    return left === undefined ? o.timeoutMs : Math.min(o.timeoutMs ?? left, left);
  };
  const edit = async (id: string) => {
    await gh(["api", `repos/${repo}/issues/comments/${id}`, "-X", "PATCH", "--input", "-"], undefined, limit(), JSON.stringify({ body }));
  };
  if (o.id) {
    await edit(o.id);
    return { id: o.id, changed: true, removed: 0, left: 0, login };
  }
  const comments = await issueComments(repo, issue, limit());
  const ours: Comment[] = [];
  for (const c of comments) {
    if (!isStatusComment(c)) continue;
    if (c.viewerDidAuthor === undefined) login ??= await ghLogin(limit());
    if (c.viewerDidAuthor === true || (c.viewerDidAuthor === undefined && c.author.login === login)) ours.push(c);
  }
  if (!ours.length) {
    if (!o.create) return { changed: false, removed: 0, left: 0, login };
    const id = await commentOnIssue(repo, issue, body, limit());
    return { id, changed: true, created: true, removed: 0, left: 0, login };
  }
  const first = ours[0]!;
  const id = commentId(first.url);
  if (!id) throw new Error("the status comment has no link, so it cannot be edited");
  const changed = !sameBody(first.body, body);
  if (changed) await edit(id);
  let removed = 0;
  let left = 0;
  for (const extra of ours.slice(1)) {
    const eid = commentId(extra.url);
    if (!eid || removed + left >= MAX_REMOVE) { left++; continue; }
    try {
      await gh(["api", `repos/${repo}/issues/comments/${eid}`, "-X", "DELETE"], undefined, limit());
      removed++;
    } catch {
      left++;
    }
  }
  return { id, changed, removed, left, login };
}

/** The human comments posted after the latest comment matching `after` (or all, if none matches). */
export function commentsAfter(comments: Comment[], after: (c: Comment) => boolean): Comment[] {
  let idx = -1;
  comments.forEach((c, i) => {
    if (after(c)) idx = i;
  });
  return comments.slice(idx + 1).filter((c) => !isBot(c));
}

export async function setLabels(repo: string, issue: number, add: string | undefined, remove: string[], timeoutMs?: number) {
  const args = ["issue", "edit", String(issue), "--repo", repo];
  for (const l of remove) if (l !== add) args.push("--remove-label", l);
  if (add) args.push("--add-label", add);
  await gh(args, undefined, timeoutMs);
}

export async function ensureLabel(repo: string, name: string, color: string, description: string) {
  await gh(["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"]);
}
