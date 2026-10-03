import { explainError } from "./errors.js";
import type { RunSummary, StepRecord } from "./engine/state.js";

/** Why a run did not finish: the code, the Foundry (or its environment), a limit, or a person's decision. */
export type FailureCause = "code" | "factory" | "limit" | "decision";

export interface Failure {
  cause: FailureCause;
  /** What went wrong, in a few words (factory), or a hint about a blocked command (code). */
  what?: string;
  /** The suggested fix, without the retry. */
  fix?: string;
}

/**
 * Only the tool and the program of a blocked command: the agent wrote the rest, and it may hold a
 * URL, a header or a token.
 */
export function shortDenied(entry: string): string {
  const i = entry.indexOf(": ");
  const tool = i < 0 ? entry : entry.slice(0, i);
  if (!/^[\w-]+$/.test(tool)) return "a tool";
  if (tool !== "Bash" || i < 0) return tool;
  const cmd = entry.slice(i + 2).trim().replace(/^(?:\w+=\S*\s+)+/, "");
  const prog = (/^\S+/.exec(cmd)?.[0] ?? "").split("/").pop() ?? "";
  return /^[\w.+-]+$/.test(prog) ? `Bash: ${prog}` : "Bash";
}

const MARKERS: { line: string; what: string }[] = [
  { line: "planning failed: no PLAN_STATUS line", what: "the plan had no PLAN_STATUS line" },
  { line: "planning failed (no questions to ask)", what: "the plan had no questions to ask" },
  { line: "no SUBTASK lines", what: "the triage had no SUBTASK lines" },
];
const RETRY_STEP = "resume the run to try the step again";
const PUSH_FIX = "change Protected branches in Settings or the flow's branch";
const PUSH_GUARD = /^(?:Spaghetti Code Foundry|claude-factory): pushing to protected branch '.+' is blocked$/;
const NOT_FEATURE = /^refusing to push .+: not a feature branch$/;

const SETTINGS_FIX = "check the provider and model in Settings or in the flow";
const SETUP_ERRORS: { re: RegExp; what: string; fix: string }[] = [
  { re: /^unknown provider "/, what: "the flow names a provider that is not set up", fix: SETTINGS_FIX },
  { re: /^Claude Code can't use the /, what: "the model and provider settings do not fit together", fix: SETTINGS_FIX },
  { re: /^Codex can't use the /, what: "the model and provider settings do not fit together", fix: SETTINGS_FIX },
  { re: /^provider \S+ needs (?:a model|base_url)/, what: "a provider is missing a model or an address", fix: SETTINGS_FIX },
  { re: /^claude CLI not found/, what: "the Claude Code tool is not installed", fix: "install Claude Code on the computer that runs the Foundry" },
  { re: /^codex CLI not found/, what: "the Codex tool is not installed", fix: "install Codex on the computer that runs the Foundry" },
];
const LOGIN_FIX = "log in again with `gh auth login`, or check the token the Foundry uses";
const NETWORK_FIX = "check the network connection of the computer that runs the Foundry";
const NET_LINES: { re: RegExp; what: string; fix: string }[] = [
  { re: /^fatal: Authentication failed for /, what: "git could not log in to the remote", fix: LOGIN_FIX },
  { re: /^remote: (?:Invalid username or password|Permission to \S+ denied|Support for password authentication was removed)/, what: "git could not log in to the remote", fix: LOGIN_FIX },
  { re: /^fatal: could not read (?:Username|Password) for /, what: "git could not log in to the remote", fix: LOGIN_FIX },
  { re: /^(?:gh: )?To get started with GitHub CLI, please run:/, what: "gh is not logged in", fix: LOGIN_FIX },
  { re: /^gh: .*\(HTTP 401\)$/, what: "gh is not logged in", fix: LOGIN_FIX },
  { re: /^fatal: unable to access .*: (?:Could not resolve host|Failed to connect|Connection (?:timed out|refused))/i, what: "the network was not reachable", fix: NETWORK_FIX },
  { re: /^(?:error connecting to |ssh: Could not resolve hostname )/, what: "the network was not reachable", fix: NETWORK_FIX },
];

const lastFailed =(h: StepRecord[], before: number, ok: (r: StepRecord) => boolean = () => true): number => {
  for (let i = before - 1; i >= 0; i--) if (!h[i]!.ok && ok(h[i]!)) return i;
  return -1;
};

/** The failed step that explains the run: a failed `flow` or `parallel` record points at its failed child. */
export function failedIndex(h: StepRecord[]): number {
  let idx = lastFailed(h, h.length);
  for (let depth = 0; idx >= 0 && depth < 8; depth++) {
    const rec = h[idx]!;
    let next = -1;
    if (rec.type === "flow" && /^sub-flow /.test(rec.error ?? "")) {
      next = lastFailed(h, idx, (r) => r.parent === rec.id);
    } else if (rec.type === "parallel" && /^failed: /.test(rec.error ?? "")) {
      const ids = (rec.error ?? "").slice("failed: ".length).split(", ");
      const prefix = rec.id.slice(0, rec.id.lastIndexOf("/") + 1);
      if (ids.length === 1) next = lastFailed(h, idx, (r) => r.id === prefix + ids[0]);
    }
    if (next < 0) break;
    idx = next;
  }
  return idx;
}

function evidence(h: StepRecord[]): Failure | undefined {
  const idx = failedIndex(h);
  if (idx < 0) return undefined;
  const rec = h[idx]!;
  // A composite record that could not be traced to one child holds several outputs: that is doubt.
  if (rec.type === "flow" || rec.type === "parallel") return undefined;
  if (rec.denied?.length) {
    return { cause: "factory", what: `the agent was not allowed to run ${shortDenied(rec.denied[0]!)}`, fix: "allow it in the flow (the step's allowed tools or permission mode)" };
  }
  // A limit inside a parallel or sub-flow step is only on the child's record, not in the wrapper's reason.
  if (rec.unreachable) return factory("the AI service could not be reached", "check the network connection, then resume the run");
  if (rec.limited) return /^signed out —/.test(rec.error ?? "") ? factory("the agent is signed out of its AI account", "sign in again, then resume the run") : { cause: "limit" };
  if (/^claude result: error_max_budget_usd\b/.test(rec.error ?? "")) return { cause: "limit" };
  // A step that could not even start: wrong model or provider settings, a missing tool. The text is the Foundry's own.
  const setup = SETUP_ERRORS.find((s) => s.re.test(rec.error ?? ""));
  if (setup) return { cause: "factory", what: setup.what, fix: setup.fix };
  const lines = (rec.output ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  // Login and network errors count only in a command's own output, at the start of a line: an agent may quote them.
  if (rec.type === "shell") {
    const net = lines.map((l) => NET_LINES.find((n) => n.re.test(l))).find(Boolean);
    if (net) return { cause: "factory", what: net.what, fix: net.fix };
  }
  const marker = MARKERS.find((m) => m.line === lines.at(-1));
  if (marker) return { cause: "factory", what: marker.what, fix: RETRY_STEP };
  if (lines.some((l) => PUSH_GUARD.test(l))) return { cause: "factory", what: "a push to a protected branch was blocked", fix: PUSH_FIX };
  if (lines.some((l) => NOT_FEATURE.test(l))) return { cause: "factory", what: "a push to a branch that is not a feature branch was blocked", fix: PUSH_FIX };
  return undefined;
}

/** A hint for a code failure: a command was blocked in this step or the one before it. */
function hint(h: StepRecord[]): Failure | undefined {
  const idx = failedIndex(h);
  if (idx < 0) return undefined;
  const rec = h[idx]!;
  const composite = rec.type === "flow" || rec.type === "parallel";
  const denied = rec.denied?.[0] ?? (composite ? undefined : h[idx - 1]?.denied?.[0]);
  return denied ? { cause: "code", what: `a command was blocked: ${shortDenied(denied)}`, fix: "allow it in the flow if it was needed" } : undefined;
}

const factory = (what: string, fix: string): Failure => ({ cause: "factory", what, fix });
const oneLine = (s: string) => s.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * Why a run did not finish. Pure. Factory is chosen only on known messages and structural facts;
 * when in doubt the cause is code.
 */
export function classifyFailure(run: Pick<RunSummary, "status" | "reason" | "history" | "failureNote">): Failure {
  const f = rulesFailure(run);
  const note = run.failureNote;
  // A model's reading may turn a code failure into an environment one; it never changes the other causes.
  if (run.status === "failed" && f.cause === "code" && note?.kind === "environment") {
    return { cause: "factory", what: note.why, fix: f.fix ?? "fix what the reason says, then retry" };
  }
  return f;
}

function rulesFailure(run: Pick<RunSummary, "status" | "reason" | "history">): Failure {
  const reason = (run.reason ?? "").trim();
  const history = Array.isArray(run.history) ? run.history : undefined;
  if ((run.status === "failed" || run.status === "stopped") && /^interrupted\b/.test(reason)) return factory("the run was interrupted", "resume the run");
  switch (run.status) {
    case "waiting": case "cancelled": return { cause: "decision" };
    case "stopped":
      if (/^signed out —/.test(reason)) return factory("the agent is signed out of its AI account", "sign in again; the run continues by itself");
      if (/daily budget/.test(reason)) return { cause: "limit" };
      if (/usage limit reached/.test(reason)) {
        return history?.at(-1)?.unreachable
          ? factory("the AI service could not be reached", "check the network connection; the run continues by itself")
          : { cause: "limit" };
      }
      return { cause: "decision" };
    case "failed": break;
    default: return { cause: "code" };
  }
  if (/^run budget of/.test(reason) || /failed: claude result: error_max_budget_usd\b/.test(reason)) return { cause: "limit" };
  if (/^step "[\w./-]+" failed: rejected\b/.test(reason)) return { cause: "decision" };
  if (/exceeded max_visits/.test(reason)) {
    // The loop ran out of tries: the cause is the record that failed last, not the step that was visited too often.
    if (history && history[failedIndex(history)]?.error === "rejected") return { cause: "decision" };
    return (history && hint(history)) || { cause: "code" };
  }
  if (/^internal error:/.test(reason) || /^unknown step "/.test(reason)) return factory(oneLine(reason), "restart or update the Foundry");
  if (reason && !reason.startsWith('step "')) {
    const fix = /^bot\.gh_token_env/.test(reason) ? "set that environment variable or change bot.gh_token_env in the config"
      : /^GitHub App token/.test(reason) ? "check the GitHub App settings in the config"
      : /^workspace "/.test(reason) ? "check the repository of the run"
      : "check the Foundry's settings and log";
    return factory(oneLine(reason), fix);
  }
  if (!reason && history?.length === 0) return factory("the run failed before any step ran", "check the Foundry's settings and log");
  if (history) return evidence(history) ?? hint(history) ?? { cause: "code" };
  return { cause: "code" };
}

// ── the summary: what happened, why, what was tried, what you can do ──

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const upperFirst = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * One safe line of plain text from text that may hold Markdown, HTML or a mention (output of
 * a step, an answer of a model): no formatting, no marker comment, no link, no mention. At most 240 characters.
 */
export function safeSentence(text: string, max = 240): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/(^|[\s(])_+([^_\s](?:[^_]*[^_\s])?)_+(?=$|[\s).,;:!?])/g, "$1$2")
    .replace(/@(?=\w)/g, "@​")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

/** Replaces the folders of a run (and the repository) with "(folder)", the longest first. */
export function hideFolders(text: string, folders: (string | undefined)[]): string {
  const list = [...new Set(folders.filter((f): f is string => !!f && f.length > 1))].sort((a, b) => b.length - a.length);
  return list.reduce((t, f) => t.split(f).join("(folder)"), text);
}

/** What the factory already tried for the failing step. */
export interface Tried { attempts: number; fixes: number; blips: number; models: number; resumes: number }

export function triedOf(run: Pick<RunSummary, "history" | "resumes"> & Partial<Pick<RunSummary, "flowDef">>): Tried {
  const out: Tried = { attempts: 0, fixes: 0, blips: 0, models: 0, resumes: run.resumes ?? 0 };
  const h = Array.isArray(run.history) ? run.history : [];
  const idx = failedIndex(h);
  const rec = idx >= 0 ? h[idx] : undefined;
  if (!rec) return out;
  out.blips = rec.retried?.blips ?? 0;
  out.models = rec.retried?.models ?? 0;
  out.attempts = h.filter((r) => r.id === rec.id && !r.ok).length;
  if (!rec.parent) {
    const steps = run.flowDef?.steps ?? [];
    const failTo = steps.find((s) => s.id === rec.id)?.on_failure;
    const handler = failTo ? steps.find((s) => s.id === failTo) : undefined;
    // The failed step may be the fix handler itself: then the steps that jump to it count as its rounds.
    const isHandler = rec.type === "claude" && steps.some((s) => s.on_failure === rec.id);
    if (handler?.type === "claude") out.fixes = h.filter((r) => r.id === handler.id).length;
    else if (isHandler) out.fixes = h.filter((r) => r.id === rec.id).length;
  }
  return out;
}

/** "3 fix attempts; the run was resumed once", or that nothing else was tried. For a user the inner tries are one count. */
export function triedText(run: Pick<RunSummary, "history" | "resumes"> & Partial<Pick<RunSummary, "flowDef">>, forUser = false): string {
  const t = triedOf(run);
  const parts: string[] = [];
  if (t.fixes) parts.push(plural(t.fixes, "fix attempt"));
  else if (t.attempts > 1) parts.push(`${t.attempts} attempts`);
  if (forUser) {
    if (t.blips + t.models) parts.push(`${t.blips + t.models} more tries inside the step`);
  } else {
    if (t.blips) parts.push(`${t.blips} more ${t.blips === 1 ? "try" : "tries"} after the AI service was briefly unavailable`);
    if (t.models) parts.push(`${t.models} other ${t.models === 1 ? "model" : "models"}`);
  }
  if (t.resumes) parts.push(t.resumes === 1 ? "the run was resumed once" : `the run was resumed ${t.resumes} times`);
  return parts.length ? parts.join("; ") : "Nothing else — it failed at the first attempt";
}

export const KIND_TEXT: Record<FailureCause, string> = {
  code: "A problem in the code",
  factory: "A problem with the environment or the Foundry",
  limit: "A limit",
  decision: "A person's decision",
};

export interface FailureSummary {
  cause: FailureCause;
  /** The kind of problem, in words. */
  kind: string;
  /** What failed. */
  what: string;
  /** Why it failed. One plain sentence. */
  why: string;
  /** What the factory already tried. */
  tried: string;
  /** Four options, in this order: Retry, Retry with a hint, Change the plan, Close. Each starts with its name and " — ". */
  options: string[];
  /** The sentence in `why` was written by a model. */
  byModel?: boolean;
}

export interface SummaryOptions {
  watched?: boolean;
  failedLabel?: string;
  canResume?: boolean;
  forUser?: boolean;
}

type SummaryRun = Pick<RunSummary, "status" | "reason" | "history" | "flowDef" | "resumes" | "failureNote"> & Partial<Pick<RunSummary, "workdir" | "runDir" | "repo">>;

/** The note of the approver in "rejected by X: note" (the output of the approval step). */
function approverNote(h: StepRecord[]): string {
  const rec = [...h].reverse().find((r) => !r.ok && r.error === "rejected");
  return /^rejected by [^:\n]*: (.+)/.exec((rec?.output ?? "").trim())?.[1] ?? "";
}

/** The four options, for a watched issue or a run by hand. */
function optionsFor(o: SummaryOptions): string[] {
  const resume = o.canResume !== false;
  if (o.watched) {
    const label = o.failedLabel ?? "factory:failed";
    return [
      `Retry — remove the ${label} label${resume ? ", or resume the run on its page" : ""}`,
      `Retry with a hint — write your hint as a comment on the issue, then remove the ${label} label`,
      `Change the plan — change the text of the issue, then remove the ${label} label`,
      "Close — close the issue if the work is no longer wanted",
    ];
  }
  return [
    `Retry — ${resume ? "resume the run on its page" : "start a new run"}`,
    "Retry with a hint — start a new run and put your hint in its task",
    "Change the plan — change the task, then start a new run",
    "Close — nothing more to do, leave the run as it is",
  ];
}

/**
 * The summary of a failed run: what failed, why, what was tried and the four options. Pure; never throws.
 * The text is plain (no Markdown, no folders). For a user it holds no money, setup or raw reason.
 */
export function failureSummary(run: SummaryRun, o: SummaryOptions = {}): FailureSummary {
  const f = classifyFailure(run);
  const h = Array.isArray(run.history) ? run.history : [];
  const user = !!o.forUser;
  const e = explainError(run.reason, "run", user);
  const folders = [run.workdir, run.runDir, run.repo];
  const clean = (t: string) => safeSentence(hideFolders(t, folders));
  const sentence = (t: string) => {
    const s = clean(t);
    return /^[a-z]+(?:[._][\w.]+)+\b/.test(s) ? s : upperFirst(s); // keeps names such as bot.gh_token_env
  };
  const note = !user && run.status === "failed" ? run.failureNote : undefined;
  const stepId = /^step "(?:[\w-]+\/)*([\w-]+)"/.exec(run.reason ?? "")?.[1];
  // At max_visits the step that ran out of tries may be a handler that succeeded; name the step that failed last.
  const looped = /exceeded max_visits/.test(run.reason ?? "") && stepId;
  const failing = looped ? h[failedIndex(h)] : undefined;
  const named = failing ? failing.id.split("/").at(-1)! : stepId;
  const desc = named ? (run.flowDef?.steps ?? []).find((s) => s.id === named)?.description : undefined;
  let what = looped ? (failing ? `The step ${named} kept failing` : `The loop at step ${stepId} reached its attempt limit`) : e.what;
  if (desc && safeSentence(desc, 120)) what += ` (${safeSentence(desc, 120)})`;

  let why: string;
  let byModel = false;
  switch (f.cause) {
    case "factory":
      if (user) why = "The Foundry failed, not the code";
      else if (note?.kind === "environment" && f.what === note.why) { why = sentence(note.why); byModel = true; }
      else why = sentence(f.what ?? run.reason ?? e.why);
      break;
    case "limit":
      why = user ? "The administrator's limit was reached" : sentence(e.why);
      break;
    case "decision": {
      const n = user ? "" : clean(approverNote(h));
      why = /stopped at step/.test(run.reason ?? "") ? "The run stopped at a step that needs a person" : `A person rejected it${n ? `: ${n}` : ""}`;
      break;
    }
    default:
      if (note?.kind === "code") { why = sentence(note.why); byModel = true; }
      else {
        why = sentence(e.why);
        const hint = user ? "" : [f.what, f.fix].filter(Boolean).join(", ");
        if (hint) why += ` (${clean(hint)})`;
      }
  }
  // A fix that changes the flow counts only for a new run: resuming keeps the used-up total.
  const options = optionsFor({ ...o, canResume: o.canResume !== false && !e.startOver });
  return { cause: f.cause, kind: KIND_TEXT[f.cause], what, why: why.replace(/[.!?]+$/, "") + ".", tried: triedText(run, user), options, ...(byModel ? { byModel } : {}) };
}
