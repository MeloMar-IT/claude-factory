import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Marker in every comment the factory writes, e.g. <!-- claude-factory run=… --> */
export const BOT_MARKER = "<!-- claude-factory";
/** Markers that identify our own comments: the one we write, and the new product name's. */
export const BOT_MARKERS = [BOT_MARKER, "<!-- spaghetti-code-foundry"] as const;

export async function gh(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec(process.env.FACTORY_GH_BIN ?? "gh", args, {
    maxBuffer: 20_000_000,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}

export async function ghJson<T>(args: string[], env?: NodeJS.ProcessEnv): Promise<T> {
  const out = (await gh(args, env)).trim();
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

export async function issueComments(repo: string, issue: number | string): Promise<Comment[]> {
  const r = await ghJson<{ comments: Comment[] }>(["issue", "view", String(issue), "--repo", repo, "--json", "comments,labels"]);
  return r.comments ?? [];
}

/** Can this user push to the repo? Used to trust /approve and /reject. */
export async function canWrite(repo: string, login: string): Promise<boolean> {
  try {
    const perm = (await gh(["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"])).trim();
    return ["admin", "maintain", "write"].includes(perm);
  } catch {
    return false;
  }
}

/** The human comments posted after the latest comment matching `after` (or all, if none matches). */
export function commentsAfter(comments: Comment[], after: (c: Comment) => boolean): Comment[] {
  let idx = -1;
  comments.forEach((c, i) => {
    if (after(c)) idx = i;
  });
  return comments.slice(idx + 1).filter((c) => !isBot(c));
}

export async function setLabels(repo: string, issue: number, add: string | undefined, remove: string[]) {
  const args = ["issue", "edit", String(issue), "--repo", repo];
  for (const l of remove) if (l !== add) args.push("--remove-label", l);
  if (add) args.push("--add-label", add);
  await gh(args);
}

export async function ensureLabel(repo: string, name: string, color: string, description: string) {
  await gh(["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"]);
}
