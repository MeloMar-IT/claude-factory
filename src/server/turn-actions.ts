import type { User } from "../auth/users.js";
import { canWrite, commentOnIssue, commentsAfter, ghLogin, isBot, issueComments, mayWrite, repoPermission, setLabels } from "../github.js";
import { labelNames } from "../queue/watcher.js";
import { commentDigest, composeComment, findComment, parseProposal, parseQuestions, visibleText, type ComposeAction, type Proposal, type Question } from "../turn-actions.js";
import type { TurnAct, YourTurn } from "../your-turn.js";
import { HttpError, readJson, send, str } from "./http.js";
import type { ApiContext, Route } from "./server.js";
import { markActed, turnFor, wasActed, yourTurn } from "./your-turn.js";

/** Every call to GitHub from these routes gives up after this long. */
const GH_TIMEOUT_MS = 15_000;
/** The watcher checks this soon after an action. */
const KICK_MS = 1000;
/** GitHub's comment limit is 65 536 characters; the text also travels in a command line. */
const MAX_TEXT = 60_000;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const ACTIONS: readonly TurnAct[] = ["defaults", "answer", "approve", "reject", "retry", "retry_hint"];

export interface TurnDetail {
  /** Send this back with the action: the action is refused when the item changed meanwhile. */
  stamp: string;
  /** Identifies the comment shown; send it back with the action. */
  digest?: string;
  acts: TurnAct[];
  kind: string;
  /** The comment as text (always set; for questions it is the fallback when none could be parsed). */
  text: string;
  questions?: Question[];
  proposal?: Proposal;
}

export interface ActRequest {
  key: string;
  action: TurnAct;
  stamp?: string;
  digest?: string;
  text: string;
  answers: { n?: number; text: string }[];
}

/** Per server: keys being acted on right now, and hints already posted (for the stamp), so a retry never posts twice. */
interface Guards { busy: Set<string>; hinted: Map<string, { since: string; at: string }> }
const guards = new WeakMap<ApiContext, Guards>();
const guardsOf = (ctx: ApiContext) => guards.get(ctx) ?? guards.set(ctx, { busy: new Set(), hinted: new Map() }).get(ctx)!;

function findItem(ctx: ApiContext, key: string, now: Date) {
  const item = turnFor(ctx, now).all.find((i) => i.key === key);
  if (!item) throw new HttpError(404, "no such item");
  return item;
}

function target(item: { next: { repo: string; issue?: number } }) {
  const { repo, issue } = item.next;
  if (issue === undefined || !REPO_RE.test(repo)) throw new HttpError(409, "this item has no issue to act on");
  return { repo, issue };
}

const unreachable = (what: string, e: unknown) => new HttpError(502, `${what}: ${(e as Error).message.split("\n")[0]}`);

/** Reads the issue and finds the Foundry's comment. Only comments by the account the Foundry posts as count: the marker alone can be copied by anyone. */
async function foundryComment(repo: string, issue: number, kind: string, runId?: string) {
  let comments;
  try {
    const login = await ghLogin(GH_TIMEOUT_MS);
    comments = { login, list: await issueComments(repo, issue, GH_TIMEOUT_MS) };
  } catch (e) {
    throw unreachable("could not read the issue on GitHub", e);
  }
  const c = findComment(comments.list, kind, runId, comments.login);
  if (!c) throw new HttpError(409, "the Foundry's comment was not found on the issue; use the link to GitHub");
  return { c, list: comments.list };
}

/** The questions, plan or split of an item, read from its comment on the issue. */
export async function turnDetail(ctx: ApiContext, key: string, now = new Date()): Promise<TurnDetail> {
  const item = findItem(ctx, key, now);
  if (!item.acts.length) throw new HttpError(409, "there is nothing to show for this item here");
  const base = { stamp: item.stamp, acts: item.acts, kind: item.next.kind };
  if (item.next.kind === "failed") return { ...base, text: item.next.text };
  const { repo, issue } = target(item);
  const { c } = await foundryComment(repo, issue, item.next.kind, item.next.runId);
  if (item.next.kind === "questions" || item.next.kind === "planner_questions") {
    const questions = parseQuestions(c.body);
    return { ...base, digest: commentDigest(c), text: visibleText(c.body), questions };
  }
  return { ...base, digest: commentDigest(c), text: visibleText(c.body), proposal: parseProposal(c.body) };
}

/** Checks the body of POST your-turn/act. */
export function readAct(body: Record<string, unknown>): ActRequest {
  const key = str(body, "key");
  const action = str(body, "action") as TurnAct;
  if (!ACTIONS.includes(action)) throw new HttpError(400, `"action" must be one of ${ACTIONS.join(", ")}`);
  if (body.stamp !== undefined && typeof body.stamp !== "string") throw new HttpError(400, `"stamp" must be a string`);
  const stamp = body.stamp as string | undefined;
  if (stamp === undefined && action !== "retry") throw new HttpError(400, `"stamp" is required: ask for the item first`);
  const text = str(body, "text", false);
  let answers: ActRequest["answers"] = [];
  if (body.answers !== undefined) {
    if (!Array.isArray(body.answers) || body.answers.length > 100) throw new HttpError(400, `"answers" must be a list`);
    answers = body.answers.map((a: unknown) => {
      const x = a as { n?: unknown; text?: unknown } | null;
      if (!x || typeof x.text !== "string" || !x.text.trim() || (x.n !== undefined && !Number.isInteger(x.n))) throw new HttpError(400, "each answer needs a text");
      return { ...(x.n === undefined ? {} : { n: x.n as number }), text: x.text };
    });
  }
  const all = [text, ...answers.map((a) => a.text)];
  if (all.some((t) => t.length > MAX_TEXT || isBot({ body: t }))) throw new HttpError(400, `the text is too long or holds a Foundry marker`);
  if ((action === "reject" || action === "retry_hint") && !text.trim()) throw new HttpError(400, action === "reject" ? "say what to change" : "write the hint");
  if (action === "answer" && !answers.length) throw new HttpError(400, "write at least one answer");
  if (body.digest !== undefined && typeof body.digest !== "string") throw new HttpError(400, `"digest" must be a string`);
  const digest = body.digest as string | undefined;
  if (digest === undefined && action !== "retry" && action !== "retry_hint") throw new HttpError(400, `"digest" is required: ask for the item first`);
  return { key, action, stamp, digest, text, answers };
}

/** Posts what the user decided as a normal comment on the issue (or removes the failed label); returns nothing: the page reloads. */
export async function turnAct(ctx: ApiContext, user: Pick<User, "id" | "name">, req: ActRequest, now = new Date()): Promise<void> {
  const item = findItem(ctx, req.key, now);
  if (!item.acts.includes(req.action)) throw new HttpError(409, "that is not possible for this item");
  if (wasActed(ctx, item.key, item.stamp, now)) throw new HttpError(409, "this is done already — it is continuing");
  if (req.stamp !== undefined && req.stamp !== item.stamp) throw new HttpError(409, "this item changed meanwhile — look at it again");
  const name = (user.name ?? "").replace(/\s+/g, " ").trim() || "a Foundry user";
  if (isBot({ body: name })) throw new HttpError(400, "the account name holds a Foundry marker");
  const { repo, issue } = target(item);
  const tracked = ctx.watchers.tracked().find((t) => t.watcher.id === item.watcher);
  const hold = tracked?.status.holds?.find((h) => h.issue === issue && h.next.kind === item.next.kind && (h.next.runId ?? "") === (item.next.runId ?? ""));
  if (!tracked || !hold) throw new HttpError(409, "the watcher no longer waits for this — look again in a moment");

  // The whole comment must fit GitHub's limit (65 536); checked before anything is sent.
  const body = req.action === "retry" ? "" : composeComment(req.action as ComposeAction, { name, text: req.text, answers: req.answers });
  if (body.length > MAX_TEXT) throw new HttpError(400, "the text is too long for one comment");

  const g = guardsOf(ctx);
  if (g.busy.has(item.key)) throw new HttpError(409, "this is already being done — look again in a moment");
  g.busy.add(item.key);
  try {
    // Someone may have answered or decided on GitHub since the watcher's last check: then the watcher takes that, not this.
    if (req.action !== "retry" && req.action !== "retry_hint") {
      const { c, list } = await foundryComment(repo, issue, item.next.kind, item.next.runId);
      const approval = item.next.kind === "approve_plan" || item.next.kind === "approve_split" || item.next.kind === "approval";
      if (req.digest !== commentDigest(c)) throw new HttpError(409, "the comment on the issue changed since you opened it — look at it again");
      let later = commentsAfter(list, (x) => x === c);
      if (approval) {
        // Like the watcher: a /approve or /reject only counts from someone with write access.
        later = later.filter((x) => /^\s*\/(approve|reject)\b/im.test(x.body));
        const ok: typeof later = [];
        for (const x of later) if (await canWrite(repo, x.author.login)) ok.push(x);
        later = ok;
      }
      if (later.length) throw new HttpError(409, `${approval ? "this was decided" : "this was answered"} on GitHub already — look again in a moment`);
    }
    if (req.action === "approve" || req.action === "reject") {
      let login: string;
      try {
        login = await ghLogin(GH_TIMEOUT_MS);
      } catch (e) {
        throw unreachable("could not find out which GitHub account the Foundry uses", e);
      }
      try {
        if (!mayWrite(await repoPermission(repo, login, GH_TIMEOUT_MS))) throw new Error("no write access");
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === "no write access" || /\(HTTP 40[34]\)/.test(msg)) {
          throw new HttpError(409, `the GitHub account "${login}" the Foundry uses has no write access to ${repo}, so its /approve or /reject would be ignored`);
        }
        throw unreachable("could not check the write access on GitHub", e);
      }
    }
    const hintedBefore = g.hinted.get(item.key)?.since === item.stamp;
    if (body && !(req.action === "retry_hint" && hintedBefore)) {
      try {
        await commentOnIssue(repo, issue, body, GH_TIMEOUT_MS);
      } catch (e) {
        throw unreachable("could not post on the issue", e);
      }
      if (req.action === "retry_hint") g.hinted.set(item.key, { since: item.stamp, at: now.toISOString() });
    }
    if (req.action === "retry" || req.action === "retry_hint") {
      try {
        await setLabels(repo, issue, undefined, [labelNames(tracked.watcher).failed], GH_TIMEOUT_MS);
      } catch (e) {
        const first = (e as Error).message.split("\n")[0];
        throw g.hinted.get(item.key)?.since === item.stamp
          ? new HttpError(502, `the hint was posted, but the label could not be removed: ${first} — press Retry again; the hint is not posted twice`)
          : unreachable("could not remove the failed label", e);
      }
    }
    markActed(ctx, item.key, item.stamp, now);
    g.hinted.delete(item.key);
    ctx.opts.log?.(`your turn: ${req.action} ${repo}#${issue} by account ${user.id}`);
    ctx.watchers.kickRepo(repo, KICK_MS);
  } finally {
    g.busy.delete(item.key);
  }
}

export const turnActionRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "your-turn") return false;
  if (seg[1] === "detail" && !seg[2] && method === "GET") {
    const key = new URL(req.url ?? "/", "http://x").searchParams.get("key");
    if (!key) throw new HttpError(400, `"key" is required`);
    return send(res, 200, await turnDetail(ctx, key)), true;
  }
  if (seg[1] === "act" && !seg[2] && method === "POST") {
    await turnAct(ctx, user, readAct(await readJson(req)));
    const data: YourTurn = yourTurn(ctx);
    return send(res, 200, data), true;
  }
  return false;
};
