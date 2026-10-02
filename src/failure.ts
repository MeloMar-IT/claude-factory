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

const lastFailed = (h: StepRecord[], before: number, ok: (r: StepRecord) => boolean = () => true): number => {
  for (let i = before - 1; i >= 0; i--) if (!h[i]!.ok && ok(h[i]!)) return i;
  return -1;
};

/** The failed step that explains the run: a failed `flow` or `parallel` record points at its failed child. */
function failedIndex(h: StepRecord[]): number {
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
  const lines = (rec.output ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
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
export function classifyFailure(run: Pick<RunSummary, "status" | "reason" | "history">): Failure {
  const reason = (run.reason ?? "").trim();
  const history = Array.isArray(run.history) ? run.history : undefined;
  if ((run.status === "failed" || run.status === "stopped") && /^interrupted\b/.test(reason)) return factory("the run was interrupted", "resume the run");
  switch (run.status) {
    case "waiting": case "cancelled": return { cause: "decision" };
    case "stopped":
      return /daily budget|usage limit reached/.test(reason) ? { cause: "limit" } : { cause: "decision" };
    case "failed": break;
    default: return { cause: "code" };
  }
  if (/^run budget of/.test(reason)) return { cause: "limit" };
  if (/exceeded max_visits/.test(reason)) return (history && hint(history)) || { cause: "code" };
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
