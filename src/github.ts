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

export async function ghJson<T>(args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number): Promise<T> {
  const out = (await gh(args, env, timeoutMs)).trim();
  return (out ? JSON.parse(out) : []) as T;
}

export interface Comment {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
  body?: string;
  state?: string;
}

export const isBot = (c: { body: string }) => BOT_MARKERS.some((m) => c.body.includes(m));

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

/** Posts a comment; the text goes through stdin (not a shell, not the process list). */
export async function commentOnIssue(repo: string, issue: number, body: string, timeoutMs?: number): Promise<void> {
  await gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], undefined, timeoutMs, body);
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
