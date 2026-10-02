import { listFlows, type FlowListing } from "../flow/load.js";
import type { User } from "../auth/users.js";
import { HttpError, NAME_RE } from "./http.js";
import type { ApiContext } from "./server.js";

/**
 * Who may make which API call. An admin may make every call in the table; a user only the calls marked `yes`,
 * and the calls marked `own` on runs the user started (any other run answers 404, like an unknown one). A call that is not in the table is answered with 404.
 * The routes /api/session and /api/setup need no session and are not in the table.
 */
export type UserAccess = "yes" | "no" | "own";

export interface Rule {
  method: string;
  /** Segments after /api; `:id` matches exactly one segment. */
  path: string;
  user: UserAccess;
  /** One short line for the table in the guide. */
  note: string;
}

const r = (method: string, path: string, user: UserAccess, note: string): Rule => ({ method, path, user, note });

export const RULES: Rule[] = [
  r("GET", "info", "no", "server settings and today's cost"),
  r("GET", "config", "no", "read the settings"),
  r("PUT", "config", "no", "change the settings"),
  r("GET", "watchers", "no", "list the watchers"),
  r("POST", "watchers/:id/tick", "no", "run a watcher now"),
  r("POST", "clean", "no", "clean up old runs"),
  r("GET", "providers", "no", "agent providers"),
  r("POST", "providers/test", "no", "test a provider"),
  r("GET", "evals", "no", "eval reports"),
  r("GET", "stats", "no", "statistics"),
  r("GET", "flows", "yes", "list flows (a user sees the published flows only)"),
  r("GET", "flows/:name", "no", "read a flow"),
  r("PUT", "flows/:name", "no", "save a flow"),
  r("DELETE", "flows/:name", "no", "delete a flow"),
  r("GET", "blocks", "no", "list blocks"),
  r("PUT", "blocks/:id", "no", "save a block"),
  r("DELETE", "blocks/:id", "no", "delete a block"),
  r("POST", "validate", "no", "check a flow"),
  r("POST", "generate", "no", "write a flow with AI"),
  r("GET", "queue", "yes", "the queue (a user sees their own queued runs and how many are ahead)"),
  r("GET", "runs", "yes", "list runs (a user sees their own)"),
  r("GET", "run-owners", "no", "the accounts that have runs, for the owner filter"),
  r("POST", "runs", "yes", "start a run (a user: a published flow and own repositories)"),
  r("GET", "runs/:id", "own", "read a run"),
  r("POST", "runs/:id/cancel", "own", "cancel a run"),
  r("POST", "runs/:id/resume", "own", "resume a run"),
  r("POST", "runs/:id/approve", "own", "approve a run, with a note"),
  r("POST", "runs/:id/reject", "own", "reject a run, with a note"),
  r("GET", "runs/:id/events", "own", "follow a run live"),
  r("GET", "runs/:id/diff", "own", "the changes of a run"),
  r("GET", "runs/:id/transcript/:n", "own", "the transcript of a step"),
  r("GET", "next", "no", "what happens next, for all runs"),
  r("GET", "health", "no", "server health"),
  r("GET", "board", "no", "the board of all work"),
  r("GET", "since", "no", "what changed since a time"),
  r("GET", "your-turn", "no", "what waits for you"),
  r("POST", "your-turn/dismiss", "no", "dismiss an item"),
  r("POST", "your-turn/restore", "no", "restore dismissed items"),
  r("GET", "credentials", "yes", "your stored credentials"),
  r("POST", "credentials", "yes", "store a credential"),
  r("DELETE", "credentials/:id", "yes", "remove a credential"),
  r("GET", "repos", "yes", "your repositories"),
  r("POST", "repos", "yes", "add a repository (a URL, and a token for it)"),
  r("PUT", "repos/:id/auth", "yes", "change the method, user name, token or address of your repository"),
  r("DELETE", "repos/:id", "yes", "remove your repository and its stored token"),
  r("DELETE", "repos/:owner/:name", "yes", "remove a GitHub repository by name (old form)"),
];

/** The key of a rule, e.g. "POST runs/:id/approve". */
export const ruleKey = (rule: Rule) => `${rule.method} ${rule.path}`;

/** The rule for a call: the exact method and number of segments, and `:x` matches one segment. */
export function findRule(method: string, seg: string[]): Rule | undefined {
  return RULES.find((rule) => {
    if (rule.method !== method) return false;
    const parts = rule.path.split("/");
    return parts.length === seg.length && parts.every((p, i) => p.startsWith(":") || p === seg[i]);
  });
}

/**
 * Throws 403 when the user may not make the call, and 404 for a run that is not theirs. An admin always passes. Ownership is read from the run (or its
 * queue entry), never from the request.
 */
export function authorize(ctx: ApiContext, user: User, rule: Rule, seg: string[]): void {
  if (user.role === "admin" || rule.user === "yes") return;
  if (rule.user === "no") throw new HttpError(403, "not allowed for your role");
  // The same answer as for a run that does not exist: a guessed id tells nothing.
  if (ctx.scheduler.ownerOf(seg[1] ?? "") !== user.id) throw new HttpError(404, "run not found");
}

/** The flows a user may see and start: valid, published ones whose name a run can use. The list and the start check both use this. */
export function publishedFlows(repo: string): FlowListing[] {
  return listFlows(repo).filter((f) => !f.error && NAME_RE.test(f.name) && f.published === true);
}

/** The table for the guide, in Markdown. */
export function permissionTable(): string {
  const cell = (a: UserAccess) => (a === "yes" ? "yes" : a === "own" ? "own runs" : "no");
  return [
    "| Call | Admin | User | What it does |",
    "|---|---|---|---|",
    ...RULES.map((rule) => `| \`${rule.method} /api/${rule.path}\` | yes | ${cell(rule.user)} | ${rule.note} |`),
  ].join("\n");
}
