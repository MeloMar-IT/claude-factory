import type { WatcherConfig } from "./config.js";
import { explainError } from "./errors.js";
import type { RunSummary } from "./engine/state.js";
import { classifyFailure, failureSummary, type FailureCause, type FailureSummary } from "./failure.js";
import { statusHelp, statusName } from "./words.js";

/** Why something waits (or what it does now). One kind per waiting reason. */
export type NextKind =
  | "questions" | "planner_questions" | "approve_plan" | "approve_split" | "approval"
  | "dependency" | "one_at_a_time" | "area_lock" | "usage_limit" | "daily_budget" | "release"
  | "failed" | "restart" | "watcher_error" | "watcher_stale" | "closed_elsewhere"
  | "running" | "queued" | "checking" | "starting" | "interrupted" | "cancelled" | "stopped" | "done"
  | "superseded";

export type NextWho = "You" | "Foundry" | "Another story" | "A time limit" | "Something is wrong";

export interface NextStep {
  kind: NextKind;
  /** Short plain status name, e.g. "waiting for you — questions". */
  status: string;
  /** Two sentences: what it means, and what happens next or what to do. */
  help: string;
  who: NextWho;
  /** One plain sentence: why it waits. */
  why: string;
  /** One verb phrase: what to do. */
  action: string;
  /** The place to do it. */
  where: { label: string; url: string };
  /** When it continues by itself, if known. */
  until?: string;
  repo: string;
  /** The owning user; empty until users exist. */
  user: string;
  issue?: number;
  title: string;
  runId?: string;
  /** The whole record as one sentence (notifications, comments). */
  text: string;
  /** The run this record waits for (one run at a time, code area). */
  afterRun?: string;
  /** Progress and estimate of a run that is not finished. */
  timing?: RunTiming;
  /** Dependency: what it waits for. */
  blockers?: BlockerInfo[];
  /** Why a failed or interrupted run did not finish. */
  cause?: FailureCause;
  /** A failed run explained: what, why, what was tried and the four options. */
  failure?: FailureSummary;
}

/** How far a run is and how long it may take. Estimates come from earlier runs; see estimate.ts. */
export interface RunTiming {
  /** The step's number in the flow, and the number of steps. */
  step: number;
  of: number;
  stepId: string;
  /** "Step 2 of 3". */
  progress: string;
  /** Quartiles of the run total (ms) from earlier runs: [usual low, usual high]. */
  usualTotalMs?: [number, number];
  /** The current step takes much longer than usual. A hint, not an error. */
  slow?: boolean;
  note?: string;
  /** Estimated time left (ms). */
  leftMs?: number;
  /** The estimate as one labelled sentence. */
  estimate?: string;
}

export interface BlockerInfo {
  issue: number;
  /** The blocker's own record, when there is one. */
  next?: NextStep;
}

/** What the caller knows about a record. Every field is optional. */
export interface NextData {
  /** The issue is watched (labels, resume and retry work from GitHub). */
  watched?: boolean;
  failedLabel?: string;
  /** Link to the issue or pull request (default: none). */
  issueUrl?: string;
  questions?: number;
  /** Text of the approval request or the failure reason. */
  message?: string;
  reason?: string;
  blockers?: BlockerInfo[];
  blockingRun?: string;
  /** The pull request the release waits for. */
  pr?: { number: number; url?: string };
  maxPerTick?: number;
  /** Area lock: the run that holds the areas. */
  areaWait?: { runId: string; areas: string };
  /** Label of the schedule watcher's release, e.g. "17:00". */
  releaseAt?: string;
  /** When a usage limit is tried again. */
  finishedAt?: string;
  now?: Date;
  timeZone?: string;
  /** Text for `restart`. */
  restartWhy?: "new_version" | "data_folder";
  /** The run was replaced by a newer run on the same work. */
  superseded?: boolean;
  /** The run the record is about (when `base` has none). */
  runId?: string;
  /** `closed_elsewhere`: the run waits for approval (it is not working). */
  runWaits?: boolean;
  /** `failed`: false when the run has no step to resume at, so it must start over. */
  canResume?: boolean;
  /** `watcher_stale`: ISO time of the last finished check. */
  lastCheck?: string;
  /** `restart`: runs the server still waits for (without it the text is the one issue records use). */
  runsLeft?: number;
  /** `usage_limit`: the agent whose limit it is, e.g. "codex". */
  limitAgent?: string;
  /** `failed`: why the run did not finish; the factory wording is used for "factory". */
  cause?: FailureCause;
  /** The record is for a user: no money, no setup, no agent, no command, no raw reason. */
  forUser?: boolean;
  /** `usage_limit`: the AI service could not be reached. */
  unreachable?: boolean;
  /** `failed`: the explained failure (the card, the comment). */
  failure?: FailureSummary;
  /** `failed`: what went wrong, and the suggested fix. */
  what?: string;
  fix?: string;
}

export interface NextBase {
  repo?: string;
  issue?: number;
  title?: string;
  runId?: string;
}

const RUN_PAGE = (id: string) => `#/runs/${id}`;
const WATCHERS = { label: "Watchers page", url: "#/watchers" };
const RUNS = { label: "Runs page", url: "#/runs" };
const SETTINGS = { label: "Settings page", url: "#/settings" };

/** First sentence only, no amounts, one line. */
function clean(t: string | undefined): string {
  let s = (t ?? "").replace(/(?:\s+of)?\s*\$\s?\d+(?:\.\d+)?/g, "").replace(/\s+/g, " ").trim();
  const m = /^(.*?[.!?])(?:\s|$)/.exec(s);
  if (m) s = m[1]!;
  return s.replace(/[.!?:;,\s—-]+$/, "").trim();
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Number of questions (`**Q1.` …) in a Foundry comment. */
export function countQuestions(body: string | undefined): number {
  return new Set([...(body ?? "").matchAll(/\*\*Q(\d+)\./g)].map((m) => m[1])).size;
}

/** The wait for the reset in a usage-limit message, e.g. "3:50pm (Europe/Amsterdam)". */
function limitReset(reason: string | undefined): string | undefined {
  const m = /resets?\s+(?:at\s+)?(.+?)\s*(?:—|$|\n)/i.exec(reason ?? "");
  return m?.[1]?.trim() || undefined;
}

/** HH:MM of the retry time (30 minutes after the run stopped). */
function limitRetry(d: NextData, retryMs: number): string {
  const at = new Date(d.finishedAt ?? 0).getTime() + retryMs;
  const now = (d.now ?? new Date()).getTime();
  if (!d.finishedAt || at <= now) return "the next check";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: d.timeZone }).format(new Date(at));
}

/** HH:MM of an ISO time. */
function hhmm(iso: string | undefined, d: NextData): string {
  const t = new Date(iso ?? "");
  if (!iso || isNaN(t.getTime())) return "an unknown time";
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: d.timeZone }).format(t);
}

export const LIMIT_RETRY_MS = 30 * 60_000;
/** The health line shows a usage limit for an hour after the run stopped (two retry periods), and a Foundry failure for 7 days. */
export const LIMIT_SHOWN_MS = 2 * LIMIT_RETRY_MS;
export const FAILURE_SHOWN_MS = 7 * 86_400_000;

/** "#88, which is being coded" — what a blocker is doing, as one clause. */
function blockerClause(b: BlockerInfo): string {
  const n = b.next;
  if (!n) return "which is to be done";
  switch (n.kind) {
    case "questions": case "planner_questions": return "which waits for answers";
    case "approve_plan": return "which waits for your decision on its risky plan";
    case "approve_split": return "which waits for your decision on its split";
    case "approval": return "which waits for your decision";
    case "dependency": return "which waits for another story";
    case "running": return "which is being worked on";
    case "queued": case "one_at_a_time": case "starting": case "checking": return "which is queued";
    case "area_lock": return "which waits for a code area";
    case "usage_limit": case "daily_budget": return "which is paused by a limit";
    case "release": return n.until ? `which waits for the ${n.until}` : "which waits for the release pull request";
    case "failed": return "which failed";
    case "interrupted": case "stopped": case "cancelled": return "which is stopped";
    default: return "which is to be done";
  }
}

/** Kinds of a blocker that need the owner (an answer or a decision). */
const NEEDS_YOU = new Set<NextKind>(["questions", "planner_questions", "approve_plan", "approve_split", "approval"]);

/** The blockers that hold everything up: down every "waits for another story", each issue once. */
function rootBlockers(bs: BlockerInfo[] | undefined, seen = new Set<number>()): BlockerInfo[] {
  const out: BlockerInfo[] = [];
  for (const b of bs ?? []) {
    if (seen.has(b.issue) || b.next?.kind === "done") continue;
    seen.add(b.issue);
    if (b.next?.kind === "dependency" && b.next.blockers?.length) out.push(...rootBlockers(b.next.blockers, seen));
    else out.push(b);
  }
  return out;
}

/** Every issue in the tree, with repeats (a shared blocker shows up once per path). */
function treeIssues(bs: BlockerInfo[] | undefined): number[] {
  return (bs ?? []).flatMap((b) => [b.issue, ...(b.next?.kind === "dependency" ? treeIssues(b.next.blockers) : [])]);
}

/** "#88, which is being worked on" — blockers that are done are not described. */
function chain(bs: BlockerInfo[] | undefined, depth = 0): string {
  const list = bs ?? [];
  if (!list.length) return "";
  if (list.length > 1 && list.every((b) => !b.next)) return `${list.map((b) => `#${b.issue}`).join(", ")} (to be done first)`;
  // A short, straight chain reads well spelled out; a long or branching one names each issue once:
  // the stories it waits for, then what holds them up at the root.
  const all = treeIssues(list);
  if (depth > 0 || (all.length <= 4 && new Set(all).size === all.length)) {
    const one = (b: BlockerInfo): string => {
      if (b.next?.kind === "done") return `#${b.issue}`; // done work is not described
      if (b.next?.kind === "dependency" && depth < 3) return `#${b.issue}, which waits for ${chain(b.next.blockers, depth + 1) || "another story"}`;
      return `#${b.issue}, ${blockerClause(b)}`;
    };
    return list.map(one).join(" and ");
  }
  const short = (b: BlockerInfo) => blockerClause(b).replace(/^which /, "");
  const direct = list.filter((b) => b.next?.kind !== "done");
  const shown = new Set(direct.map((b) => b.issue));
  const parts = direct.map((b) => (b.next?.kind === "dependency" ? `#${b.issue}` : `#${b.issue} (${short(b)})`));
  const roots = rootBlockers(direct.filter((b) => b.next?.kind === "dependency").flatMap((b) => b.next!.blockers ?? []), new Set(shown));
  return roots.length ? `${parts.join(", ")}; held up by ${roots.map((r) => `#${r.issue} (${short(r)})`).join(", ")}` : parts.join(", ");
}

const sentence = (why: string, say: string) => `${why} — ${say}.`;

/**
 * The record for one reason. Pure: the caller passes in everything it knows.
 * `text` is one sentence: "<why> — <what to do>."
 */
export function nextStep(kind: NextKind, base: NextBase = {}, d: NextData = {}): NextStep {
  const issue = base.issue;
  base = { ...base, runId: base.runId ?? d.runId };
  const ref = issue ? `#${issue}` : "this";
  const issueWhere = d.issueUrl ? { label: issue ? `Issue #${issue}` : "Issue", url: d.issueUrl } : undefined;
  const runWhere = base.runId ? { label: "Run page", url: RUN_PAGE(base.runId) } : undefined;
  const where = issueWhere ?? runWhere ?? WATCHERS;
  let who: NextWho = "Foundry";
  let why = "";
  let action = "Nothing — it continues by itself";
  let say = "";
  let w = where;
  let limit = false;
  let until: string | undefined;
  const q = d.questions;

  switch (kind) {
    case "questions": case "planner_questions": {
      who = "You";
      why = kind === "questions" ? "It has questions before it starts" : "The planner has questions";
      action = q ? `Answer ${plural(q, "question")}` : "Answer the questions";
      say = kind === "questions" ? `${action.toLowerCase()} on the issue, or reply /defaults to go with the recommendations` : `${action.toLowerCase()} on the issue and it continues`;
      if (kind === "planner_questions" && !d.watched) w = runWhere ?? where;
      break;
    }
    case "approve_plan":
      who = "You"; why = "The plan is risky and waits for your decision";
      if (d.watched) {
        action = "Reply /approve or /reject";
        say = "reply /approve to start coding (optionally with notes), or /reject followed by what to change — it then plans again";
      } else {
        action = "Approve or reject it on the run page";
        say = "approve it on the run page to start coding (optionally with notes), or reject it with what to change — it then plans again";
        w = runWhere ?? where;
      }
      break;
    case "approve_split":
      who = "You"; why = "The issue is split into smaller ones and waits for your decision";
      if (d.watched) {
        action = "Reply /approve or /reject";
        say = "reply /approve and the Foundry creates these issues and closes this one, or /reject followed by what to change";
      } else {
        action = "Approve or reject it on the run page";
        say = "approve it on the run page and the Foundry creates these issues and closes this one, or reject it with what to change";
        w = runWhere ?? where;
      }
      break;
    case "approval": {
      who = "You";
      const m = clean(d.message);
      why = m ? `It waits for your approval: ${m}` : "It waits for your approval";
      action = !d.watched || !issueWhere ? "Approve or reject it on the run page" : "Reply /approve or /reject";
      say = action.charAt(0).toLowerCase() + action.slice(1);
      if (!d.watched) w = runWhere ?? where;
      break;
    }
    case "dependency": {
      who = "Another story";
      const c = chain(d.blockers) || "another story";
      why = `${ref} waits for ${c}`;
      const all = (d.blockers ?? []).map((b) => `#${b.issue}`);
      until = all.length ? `after ${all.join(", ")}` : undefined;
      // Somewhere down the chain a story waits for the owner: say which, so it's clear where to act.
      const yours = rootBlockers(d.blockers).filter((b) => b.next && NEEDS_YOU.has(b.next.kind)).map((b) => `#${b.issue}`);
      say = yours.length ? `nothing to do here, it starts by itself once you've handled ${yours.join(", ")}` : "nothing to do, it starts by itself";
      break;
    }
    case "one_at_a_time": {
      who = "Another story";
      why = "It runs one at a time and another run is active";
      if (d.blockingRun) w = { label: "Run page", url: RUN_PAGE(d.blockingRun) };
      else if (!issueWhere) w = runWhere ?? WATCHERS;
      say = "nothing to do, it starts when that run is finished";
      break;
    }
    case "area_lock": {
      who = "Another story";
      why = `It waits for a code area${d.areaWait ? ` (${clean(d.areaWait.areas)})` : ""} that another run uses`;
      if (d.areaWait) w = { label: "Run page", url: RUN_PAGE(d.areaWait.runId) };
      say = "nothing to do, it continues when that run is finished";
      break;
    }
    case "usage_limit": {
      if (d.unreachable) {
        who = "Foundry";
        why = "The AI service could not be reached";
        until = limitRetry(d, LIMIT_RETRY_MS);
        say = "nothing to do, it is tried again later";
        break;
      }
      if (/signed out/.test(d.reason ?? "") && d.forUser) {
        // Only the administrator can sign in again; the run is retried by itself.
        why = "The Foundry is signed out of its AI account";
        until = limitRetry(d, LIMIT_RETRY_MS);
        action = "Ask the administrator to sign in again";
        say = "ask the administrator to sign in again. It continues by itself after that";
        break;
      }
      if (/signed out/.test(d.reason ?? "")) {
        // The agent CLI lost its login: only the owner can fix that; the run is retried by itself.
        const codex = /Codex login/.test(d.reason ?? "");
        who = "You";
        why = `${codex ? "Codex" : "Claude Code"} is signed out (its login has expired)`;
        until = limitRetry(d, LIMIT_RETRY_MS);
        say = `sign in again: ${codex ? 'run "codex login"' : 'run "claude" in a terminal and type /login'}. It continues by itself after that`;
        break;
      }
      who = "A time limit";
      if (d.forUser) {
        why = "The usage limit is reached";
        until = limitRetry(d, LIMIT_RETRY_MS);
        say = "nothing to do, it is tried again after the limit resets";
        break;
      }
      why = d.limitAgent ? `The ${upperFirst(d.limitAgent)} usage limit is reached` : "The usage limit is reached";
      until = limitReset(d.reason) ?? limitRetry(d, LIMIT_RETRY_MS);
      say = "nothing to do, it is tried again after the limit resets";
      if (d.limitAgent) w = RUNS;
      break;
    }
    case "daily_budget":
      who = "A time limit"; why = d.forUser ? "The administrator's limit was reached" : "The daily budget is used up"; until = "tomorrow";
      say = "nothing to do, it starts tomorrow";
      if (!d.forUser && !issueWhere && !runWhere) {
        action = "Raise the daily budget in Settings, or wait until tomorrow";
        say = "raise the daily budget in Settings, or wait until tomorrow";
        w = SETTINGS;
      }
      break;
    case "release": {
      if (!d.pr && d.releaseAt) {
        // Finished work that ships with the scheduled release: nobody has to do anything.
        why = `It is finished and waits for the ${d.releaseAt} release`;
        action = `Nothing — it ships with the ${d.releaseAt} release`;
        say = `nothing to do, it ships with the ${d.releaseAt} release`;
        until = `${d.releaseAt} release`;
        break;
      }
      who = "You";
      const n = d.pr?.number;
      why = n ? `Release pull request #${n} is not merged yet` : "The release pull request is not merged yet";
      action = n ? `Merge the release pull request #${n}` : "Merge the release pull request";
      say = `${action.charAt(0).toLowerCase()}${action.slice(1)} to continue`;
      if (d.pr?.url) w = { label: `Release pull request #${n}`, url: d.pr.url };
      break;
    }
    case "failed": {
      who = "Something is wrong";
      const e = explainError(d.reason, "run", d.forUser);
      const factory = d.cause === "factory";
      limit = !!e.limit;
      const startOver = (!factory && e.startOver) || d.canResume === false;
      if (factory && d.forUser) {
        why = "The Foundry failed, not the code";
      } else if (factory) {
        const what = clean(d.what) || clean(d.reason);
        why = `The Foundry failed, not the code${what ? `: ${what}` : ""}`;
      } else {
        why = d.failure?.byModel ? `${e.what}: ${d.failure.why.replace(/[.!?]+$/, "")}` : `${e.what}: ${e.why}`;
        // A blocked command is only a hint for a code failure.
        const hint = d.forUser ? "" : [clean(d.what), clean(d.fix)].filter(Boolean).join(", ");
        if (hint) why += ` (${hint})`;
      }
      let retry: string;
      if (d.watched) {
        const lbl = d.failedLabel ?? "factory:failed";
        retry = startOver
          ? `then remove the \`${lbl}\` label to start over`
          : `then remove the \`${lbl}\` label to start over, or resume the run on its page${factory ? "" : " to continue at the failed step"}`;
      } else {
        retry = startOver ? "then start a new run" : "then resume the run on its page";
        w = runWhere ?? where;
      }
      const todo = factory ? (d.forUser ? "ask the administrator" : clean(d.fix)) : lowerFirst(e.todo);
      say = todo ? `${todo}, ${retry}` : retry.replace(/^then /, "");
      action = upperFirst(say);
      break;
    }
    case "restart": {
      who = "Foundry";
      if (d.runsLeft !== undefined) {
        why = d.restartWhy === "data_folder" ? "The data folder moved" : "A new version is waiting";
        say = d.runsLeft > 0 ? `it restarts after ${plural(d.runsLeft, "run")}` : "it restarts in a moment";
        w = RUNS;
        break;
      }
      why = d.restartWhy === "data_folder" ? "The server waits to restart onto a moved data folder" : "The server waits to restart on a new version";
      say = "nothing to do, it restarts when the active runs are done";
      w = WATCHERS;
      break;
    }
    case "watcher_error": {
      who = "Something is wrong";
      const e = explainError(d.reason, "watcher");
      const what = base.repo ? e.what.replace(/^The watcher /, `The watcher for ${base.repo} `) : e.what;
      why = `${what}: ${e.why}`;
      action = e.todo;
      say = lowerFirst(e.todo);
      w = WATCHERS;
      break;
    }
    case "watcher_stale": {
      who = "Something is wrong";
      why = `The watcher for ${base.repo || "this repository"} has not checked since ${hhmm(d.lastCheck, d)}`;
      action = "Press Check now on the Watchers page";
      say = "press Check now on the Watchers page";
      w = WATCHERS;
      break;
    }
    case "closed_elsewhere": {
      who = "You";
      why = `${ref} was closed on GitHub but its run ${d.runWaits ? "still waits for approval" : "is still working"}`;
      action = "Cancel the run if the work is no longer wanted";
      say = "cancel the run if the work is no longer wanted";
      w = runWhere ?? WATCHERS;
      break;
    }
    case "running":
      why = "It is being worked on"; say = "nothing to do, it continues by itself";
      break;
    case "queued":
      why = "It is in the queue"; say = "nothing to do, it starts when a slot is free";
      break;
    case "checking":
      why = "It is being checked for open questions"; say = "nothing to do, it starts after the check";
      break;
    case "starting":
      why = d.maxPerTick ? `It starts at the next check (${d.maxPerTick} per check)` : "It starts at the next check";
      say = "nothing to do, it starts by itself";
      until = "the next check";
      break;
    case "interrupted":
      why = "The run was interrupted";
      if (d.watched) say = "nothing to do, it resumes at the next check";
      else { who = "You"; action = "Resume the run on its page"; say = "resume the run on its page"; w = runWhere ?? where; }
      break;
    case "cancelled":
      why = "The run was cancelled";
      if (d.watched) say = "nothing to do, it resumes at the next check";
      else { who = "You"; action = "Resume the run on its page if you want it"; say = "resume the run on its page if you want it"; w = runWhere ?? where; }
      break;
    case "stopped":
      who = "You"; why = "The run stopped and needs attention";
      action = "Look at the run and resume it"; say = "look at the run and resume it";
      w = runWhere ?? where;
      break;
    case "superseded":
      why = "A newer run took over this work"; say = "nothing to do";
      action = "Nothing — a newer run took over";
      break;
    case "done":
      why = "It is done";
      say = "nothing to do";
      action = "Nothing — it is done";
      break;
  }

  const facts = { releaseAt: kind === "release" && !d.pr ? d.releaseAt : undefined, blockers: (d.blockers ?? []).map((b) => b.issue), factory: kind === "failed" && d.cause === "factory", user: d.forUser, limit, signedOut: kind === "usage_limit" && !d.unreachable && /signed out/.test(d.reason ?? ""), unreachable: kind === "usage_limit" && d.unreachable };
  return {
    kind, status: statusName(kind, facts), help: statusHelp(kind, facts), who, why, action, where: w, until,
    repo: base.repo ?? "", user: "", issue, title: base.title ?? "", runId: base.runId,
    text: sentence(why.replace(/[.!?]+$/, ""), say.replace(/[.!?]+$/, "")),
    ...(kind === "one_at_a_time" && d.blockingRun ? { afterRun: d.blockingRun } : {}),
    ...(kind === "area_lock" && d.areaWait ? { afterRun: d.areaWait.runId } : {}),
    ...(kind === "dependency" ? { blockers: d.blockers ?? [] } : {}),
    ...(d.cause ? { cause: d.cause } : {}),
    ...(kind === "failed" && d.failure ? { failure: d.failure } : {}),
  };
}

/**
 * A Foundry failure for a page that must not show raw reasons (they can hold paths and settings):
 * the reason and the title are left out, the fix and the link stay. Other records are unchanged.
 */
export function briefFailure(n: NextStep): NextStep {
  if (n.kind !== "failed" || n.cause !== "factory") return n;
  const why = "The Foundry failed, not the code";
  const { failure: _failure, ...rest } = n;
  return { ...rest, why, title: "", text: sentence(why, lowerFirst(n.action).replace(/[.!?]+$/, "")) };
}

/** The reasons a flow asks for in a comment on the issue. */
export type CommentKind = Extract<NextKind, "questions" | "planner_questions" | "approve_plan" | "approve_split" | "approval">;
export const COMMENT_KINDS: readonly CommentKind[] = ["questions", "planner_questions", "approve_plan", "approve_split", "approval"];

/** The fixed record of a comment kind, without per-run details. */
function commentRecord(kind: CommentKind): NextStep {
  // issueUrl is set only so "approval" does not fall back to "on the run page"; it never appears in text.
  return nextStep(kind, {}, { watched: true, issueUrl: "issue" });
}

/** The sentence a Foundry comment on an issue ends with: the record's text for an issue that is answered on GitHub, without per-run details (number of questions, approval message). */
export function commentText(kind: CommentKind): string { return commentRecord(kind).text; }

/** One line, no end punctuation. */
const tidy = (t: string) => t.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");

/**
 * The bold first line of a Foundry comment: what to do when the next move is yours or something
 * is wrong, else that nothing is needed and why. Markdown; print it, never put it in a command.
 */
export function firstLine(n: Pick<NextStep, "who" | "action" | "why">): string {
  if (n.who === "You" || n.who === "Something is wrong") return `**What you need to do:** ${tidy(n.action)}.`;
  const why = lowerFirst(tidy(n.why));
  return why ? `**Nothing needed from you** — ${why}.` : "**Nothing needed from you**";
}

/** firstLine() of the fixed record of a comment kind. */
export function commentFirst(kind: CommentKind): string { return firstLine(commentRecord(kind)); }

/** Comments that report something (plan, result, split, daily report): the fixed first line of each. */
export const REPORT_KINDS = ["info", "merge_pr", "open_pr", "start_coding", "ships", "look", "merge_release", "draft", "start_parts", "fixed", "merge_back"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const you = (action: string) => ({ who: "You" as const, action, why: "" });
const foundry = (why = "") => ({ who: "Foundry" as const, action: "", why });
const REPORTS: Record<ReportKind, Pick<NextStep, "who" | "action" | "why">> = {
  info: foundry(),
  merge_pr: you("Review and merge the pull request"),
  open_pr: you("Open a pull request from the branch"),
  start_coding: you("Add the code label to start coding"),
  ships: foundry("It goes to main with the release pull request"),
  look: you("Look at the changes"),
  merge_release: you("Merge the release pull request when you like"),
  draft: foundry("It stays a draft until the checks pass"),
  start_parts: you("Start the new issues when you want them built"),
  fixed: foundry("The fix is on main and in develop"),
  merge_back: you("Merge main into develop, because the fix is not there yet"),
};

/** firstLine() of the fixed record of a report kind. */
export function reportFirst(kind: ReportKind): string { return firstLine(REPORTS[kind]); }

/** Step environment: FACTORY_NEXT_<KIND> and FACTORY_FIRST_<KIND> for every comment kind, plus FACTORY_FIRST_<REPORT> for every report kind and FACTORY_FIRST_NOTHING. */
export function nextStepEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(COMMENT_KINDS.flatMap((k) => [
      [`FACTORY_NEXT_${k.toUpperCase()}`, commentText(k)],
      [`FACTORY_FIRST_${k.toUpperCase()}`, commentFirst(k)],
    ])),
    ...Object.fromEntries(REPORT_KINDS.map((k) => [`FACTORY_FIRST_${k.toUpperCase()}`, reportFirst(k)])),
    FACTORY_FIRST_NOTHING: firstLine(nextStep("running")),
  };
}

/** Last "stopped at step" id of a reason, without sub-flow prefix. */
function stoppedStep(reason: string | undefined): string | undefined {
  const m = /stopped at step "((?:[\w-]+\/)*)([\w-]+)"/.exec(reason ?? "");
  return m?.[2];
}

export interface RunNextOptions extends NextData {
  /** Pending-job info from Scheduler.queue(). */
  queued?: { waitingFor?: string };
  title?: string;
}

/** The record for a run. Reads `status`, `reason`, `waiting`, `state.next`; never throws on missing parts. */
export function runNextStep(run: RunSummary, o: RunNextOptions = {}): NextStep {
  const v = run.vars ?? {};
  const issue = v.issue && /^\d+$/.test(v.issue) ? Number(v.issue) : undefined;
  const base: NextBase = { repo: v.github_repo ?? run.repo, issue, title: o.title ?? (run.task ?? "").split("\n")[0] ?? "", runId: run.runId };
  const gh = v.github_repo && issue ? `https://github.com/${v.github_repo}/issues/${issue}` : undefined;
  const d: NextData = { ...o, issueUrl: o.issueUrl ?? (o.watched ? gh : undefined), reason: o.reason ?? run.reason, finishedAt: o.finishedAt ?? run.finishedAt ?? run.startedAt };
  const make = (k: NextKind, extra: NextData = {}) => nextStep(k, base, { ...d, ...extra });
  const reason = run.reason ?? "";

  if (o.queued) return o.queued.waitingFor ? make("one_at_a_time", { blockingRun: o.queued.waitingFor }) : make("queued");
  if (o.superseded && run.status !== "running" && run.status !== "succeeded") return make("superseded");
  switch (run.status) {
    case "succeeded": return o.releaseAt ? make("release") : make("done");
    case "running": {
      if (o.areaWait && run.state?.next === "claim_areas") return make("area_lock");
      return make("running");
    }
    case "waiting": {
      const id = run.waiting?.stepId;
      const k: NextKind = id === "approve_plan" ? "approve_plan" : id === "approve_split" ? "approve_split" : "approval";
      return make(k, { message: run.waiting?.message });
    }
    case "cancelled": return make("cancelled");
    case "stopped": {
      if (/daily budget/.test(reason)) return make("daily_budget");
      if (/usage limit reached|signed out —/.test(reason)) return make("usage_limit", { unreachable: !/signed out —/.test(reason) && !!run.history?.at(-1)?.unreachable });
      if (/interrupted/.test(reason)) return make("interrupted");
      const step = stoppedStep(reason);
      if (step === "send_back" || step === "ask_for_info") return make("planner_questions", { questions: o.questions });
      if (step === "wait_for_area") return make("area_lock");
      if (step?.startsWith("wait_")) return make("release");
      return make("stopped");
    }
    default: {
      const f = classifyFailure(run);
      if (/interrupted/.test(reason)) return make("interrupted", { cause: f.cause });
      const canResume = o.canResume ?? (run.state ? run.state.next != null : undefined);
      const failure = failureSummary(run, { watched: o.watched, failedLabel: o.failedLabel, canResume, forUser: o.forUser });
      return make("failed", { ...f, canResume, failure });
    }
  }
}

/** The enabled issues watcher that handles a run: same repo, flow and (when the run has one) trigger label. */
export function trackingWatcher<W extends WatcherConfig>(watchers: W[], run: RunSummary): W | undefined {
  const repo = run.vars?.github_repo;
  if (!repo || !run.vars?.issue) return undefined;
  const label = run.vars.trigger_label;
  return watchers.find((w) => w.enabled && w.source === "issues" && w.github_repo === repo && w.flow === run.flow && (!label || w.label === label));
}

/** A run's delivery steps → the flow the schedule watcher runs to release them. */
const RELEASE_PAIRS: { needs: string[]; flow: string }[] = [
  { needs: ["push_develop"], flow: "release-daily" },
  { needs: ["daily_branch", "push"], flow: "daily-pr" },
];

/**
 * "HH:MM" of the schedule watcher that releases this run's work. Only a succeeded run waits for a
 * release, and only until a release run has succeeded after it.
 */
export function releaseAtFor(watchers: WatcherConfig[], run: RunSummary, runs: RunSummary[] = []): string | undefined {
  if (run.status !== "succeeded") return undefined;
  const steps = new Set((run.history ?? []).map((h) => h.id));
  const repo = run.vars?.github_repo;
  for (const p of RELEASE_PAIRS) {
    if (!p.needs.every((id) => steps.has(id))) continue;
    const w = watchers.find((x) => x.enabled && x.source === "schedule" && x.flow === p.flow && x.at && x.github_repo === repo);
    if (!w) continue;
    const released = runs.some((r) => r.flow === p.flow && r.status === "succeeded" && r.vars?.github_repo === repo && r.startedAt > (run.finishedAt ?? run.startedAt)); // a release that began before the work was pushed missed it
    if (!released) return w.at;
  }
  return undefined;
}

/**
 * The enabled schedule watchers that would release the work of a run, judged by the delivery steps
 * its flow has (not the steps it ran, so it also works for a run that is still going).
 */
export function releaseWatchersFor<W extends WatcherConfig>(watchers: W[], run: RunSummary): W[] {
  const ids = new Set((run.flowDef?.steps ?? []).map((s) => s.id));
  const repo = run.vars?.github_repo;
  if (!repo) return [];
  return RELEASE_PAIRS.filter((p) => p.needs.every((id) => ids.has(id)))
    .flatMap((p) => watchers.filter((w) => w.enabled && w.source === "schedule" && !!w.at && w.flow === p.flow && w.github_repo === repo));
}

/** Does a step id (with optional sub-flow prefix) end in one of `ids`? */
const stepIs = (id: string | null | undefined, ids: string[]) => !!id && ids.includes(id.split("/").at(-1)!);

/**
 * The run closed its issue itself (gitflow report, split, merge): a finished `report`, `merge` or
 * `create_split` step, or one of them as the step that runs next.
 */
export function runClosedIssue(run: RunSummary | undefined): boolean {
  if (!run) return false;
  if ((run.history ?? []).some((x) => x.ok && (stepIs(x.id, ["merge", "create_split"]) || (stepIs(x.id, ["report"]) && /closed #\d+/.test(x.output ?? "")) || (stepIs(x.id, ["push_main"]) && /^PUSHED:/m.test(x.output ?? ""))))) return true;
  const next = run.state?.next;
  if (stepIs(next, ["merge", "create_split"])) return true;
  if (stepIs(next, ["report"])) {
    const step = (run.flowDef?.steps ?? []).find((x) => x.id === next) as { run?: string } | undefined;
    return /gh issue close/.test(step?.run ?? "");
  }
  return false;
}
