import { explainError } from "../errors.js";
import type { RunStatus, RunSummary } from "../engine/state.js";
import type { NextStep } from "../next-step.js";

/**
 * What a user may see of a run. Everything is built from a list of fields (never "all fields except"), so a field added
 * to the run later stays hidden until it is added here: no costs, no tokens, no agent or model, no step output, no
 * transcripts, no settings, no folders. The log is rebuilt line by line from known shapes.
 */
export interface UserStep { id: string; type: string; visit: number; ok: boolean; error?: string; startedAt: string; durationMs: number; parent?: string }

export interface UserRun {
  runId: string; flow: string; task: string; status: RunStatus; startedAt: string; finishedAt?: string;
  branch?: string; resumes?: number; owner?: string; superseded?: boolean;
  vars: Record<string, string>;
  flowDef: { name: string; steps: { id: string; type: string; description?: string }[]; publish?: { enabled: boolean; version: number } };
  history: UserStep[]; state: { next: string | null };
  waiting?: { stepId: string; message: string; since: string }; next?: NextStep;
  /** The questions of a run that stopped to ask them: the output of that one step, nothing else. */
  questions?: string;
}

const QUESTION_STEPS = ["send_back", "ask_for_info"];
const MAX_QUESTIONS = 4000;

/** The text of the questions a run stopped with, taken from the step that asks them. */
function questionsOf(s: RunSummary): string | undefined {
  if (s.status !== "stopped") return undefined;
  const m = /stopped at step "(?:[\w-]+\/)*([\w-]+)"/.exec(s.reason ?? "");
  if (!m || !QUESTION_STEPS.includes(m[1]!)) return undefined;
  const step = [...(s.history ?? [])].reverse().find((h) => h.id.split("/").at(-1) === m[1]);
  const text = step?.output?.trim();
  return text ? text.slice(0, MAX_QUESTIONS) : undefined;
}

export const USER_ERROR = "something went wrong on the server; ask the administrator";

const PATH_HIDDEN = "(folder)";
const upper = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/** The type of a step as a user reads it: the agent that runs a step is not named. */
const userType = (t: string) => (t === "claude" ? "agent" : t);

/** One sentence for a raw step or run error: no command, path, setting or money. */
export function userError(raw: string): string {
  const t = raw.trim();
  if (/^cancelled/.test(t)) return "It was cancelled";
  if (/^output (matched fail_if|did not match pass_if)/.test(t)) return "Its output did not pass the check of the step";
  if (/^failed: /.test(t)) return "One of its steps failed";
  if (/^usage limit reached/.test(t)) return "The usage limit was reached";
  if (/^signed out —/.test(t)) return "The Foundry is signed out of its AI account";
  return upper(explainError(t, "run", true).why);
}

/** Replaces the folders of a run (workspace, run folder, repository) in every string of a value. The longest path goes first; a path of one character or less (like "/") is ignored. */
export function hidePaths<T>(value: T, s: { workdir?: string; runDir?: string; repo?: string } = {}): T {
  const paths = [...new Set([s.workdir, s.runDir, s.repo].filter((p): p is string => typeof p === "string" && p.length > 1))].sort((a, b) => b.length - a.length);
  if (!paths.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return paths.reduce((t, p) => t.split(p).join(PATH_HIDDEN), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** A record for a user: the repository only when it is `owner/name`, never a folder of the server. */
export function userRecord(n: NextStep): NextStep {
  // The kind is a code the page reads; a user gets the generic limit kind, never the one named after money.
  const out = n.kind === "daily_budget" ? { ...n, kind: "usage_limit" as const } : n;
  return /^[\w.-]+\/[\w.-]+$/.test(out.repo) ? out : { ...out, repo: "" };
}

/** The user's view of a run (see the note at the top). Tolerates runs of older versions. */
export function userRun(s: RunSummary & { next?: NextStep; superseded?: boolean }): UserRun {
  const shown = new Set(["github_repo", "issue"]);
  for (const [k, spec] of Object.entries(s.flowDef?.publish?.vars ?? {})) if (spec.mode === "fixed" || spec.mode === "input") shown.add(k);
  const vars = Object.fromEntries(Object.entries(s.vars ?? {}).filter(([k]) => shown.has(k)));
  const publish = s.flowDef?.publish;
  const out: UserRun = {
    runId: s.runId, flow: s.flow, task: s.task, status: s.status, startedAt: s.startedAt,
    ...(s.finishedAt !== undefined ? { finishedAt: s.finishedAt } : {}),
    ...(s.branch !== undefined ? { branch: s.branch } : {}),
    ...(s.resumes !== undefined ? { resumes: s.resumes } : {}),
    ...(s.owner !== undefined ? { owner: s.owner } : {}),
    ...(s.superseded ? { superseded: true } : {}),
    vars,
    flowDef: {
      name: s.flowDef?.name ?? s.flow,
      steps: (s.flowDef?.steps ?? []).map((st) => ({ id: st.id, type: userType(st.type), ...(st.description !== undefined ? { description: st.description } : {}) })),
      ...(publish ? { publish: { enabled: publish.enabled, version: publish.version } } : {}),
    },
    history: (s.history ?? []).map((h) => ({
      id: h.id, type: userType(h.type), visit: h.visit, ok: h.ok,
      ...(h.error ? { error: userError(h.error) } : {}),
      startedAt: h.startedAt, durationMs: h.durationMs,
      ...(h.parent !== undefined ? { parent: h.parent } : {}),
    })),
    state: { next: s.state?.next ?? null },
    ...(s.waiting ? { waiting: { stepId: s.waiting.stepId, message: s.waiting.message, since: s.waiting.since } } : {}),
    ...(s.next ? { next: userRecord(s.next) } : {}),
    ...(questionsOf(s) ? { questions: questionsOf(s) } : {}),
  };
  return hidePaths(out, s);
}

/** A tool as a user reads it: its name when it is a plain one (Write, Bash), else just "tool". Never its arguments. */
const toolName = (raw: string) => (/^[A-Z][A-Za-z]*$/.test(raw) ? raw : "tool");

/** The sentences `resumeRun` answers with when a run cannot start; they hold no folder or setting. */
const START_FAILURES: RegExp[] = [
  /^run [\w-]+ not found$/,
  /^run [\w-]+ is not waiting for approval$/,
  /^run is waiting for approval: approve or reject it$/,
  /^run already succeeded \(pass a step to re-run from\)$/,
  /^the run's workspace no longer exists$/,
  /^nothing to resume$/,
  /^unknown step "[\w./-]+"$/,
  /^this run was created by an older version of Spaghetti Code Foundry and can't be resumed$/,
];

/** One anchored pattern and one rebuild function per known shape of a log line; the first match wins. A rebuild returns the line without what a user may not see. */
const LOG_SHAPES: [RegExp, (m: RegExpExecArray) => string | undefined][] = [
  [/^run ([\w-]+) · flow (\S+) · (.*?)(?: \(branch (\S+)\))?$/, (m) => `run ${m[1]} · flow ${m[2]}${m[4] ? ` (branch ${m[4]})` : ""}`],
  [/^↻ resuming run ([\w-]+) at "([\w./-]+)"(?: \((approved|rejected)\))?$/, (m) => `↻ resuming run ${m[1]} at "${m[2]}"${m[3] ? ` (${m[3]})` : ""}`],
  [/^▶ ([\w./-]+) \((claude|shell|approval|parallel|flow)(?:, visit (\d+))?\)$/, (m) => `▶ ${m[1]} (${userType(m[2]!)}${m[3] ? `, visit ${m[3]}` : ""})`],
  [/^([✔✘]) ([\w./-]+) \((\d+(?:\.\d+)?)s(?:, \$\d+(?:\.\d+)?)?(?:, \d+k tok)?\)(?: — (.*))?$/, (m) => `${m[1]} ${m[2]} (${m[3]}s)${m[4] ? ` — ${userError(m[4])}` : ""}`],
  [/^  ⇉ running ([\w./, -]+) in parallel$/, (m) => `  ⇉ running ${m[1]} in parallel`],
  [/^⏸ waiting for approval: (.*)$/, (m) => `⏸ waiting for approval: ${m[1]}`],
  [/^✘ could not start: (.*)$/, (m) => `✘ could not start: ${START_FAILURES.some((re) => re.test(m[1]!)) ? m[1] : USER_ERROR}`],
  // Which agent and model works, and why it does not resume, are the setup.
  [/^    · agent /, () => undefined],
  [/^    · not resuming /, () => undefined],
  [/^    · ([^\s:]+)(?::.*)?$/, (m) => `    · ${toolName(m[1]!)}`],
  [/^    ⚠ blocked: ([^\s:]+)(?::.*)?$/, (m) => `    ⚠ blocked: ${toolName(m[1]!)}`],
];

/** A log line for a user, or `undefined` to leave it out (a line of no known shape, or one about budgets and models). Only the first line of an event is read. */
export function userLogLine(line: string): string | undefined {
  const first = line.split("\n")[0]!;
  for (const [re, make] of LOG_SHAPES) {
    const m = re.exec(first);
    if (m) return make(m);
  }
  return undefined;
}

/** The answer to a changing call while the server moves to a new data folder. The folder is for the administrator only. */
export function movedText(moved: string, admin: boolean): string {
  return admin ? `the data folder moved to ${moved}; the server restarts onto it — try again in a minute` : "the server restarts — try again in a minute";
}
