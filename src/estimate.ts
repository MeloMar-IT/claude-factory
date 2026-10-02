import type { RunSummary, StepRecord } from "./engine/state.js";
import type { NextStep, RunTiming } from "./next-step.js";

// Progress and estimates for runs. Pure: the caller passes in the runs and the time.
// An estimate needs at least MIN_SAMPLES earlier succeeded runs of the same flow (same steps) in the same repository.

export const MIN_SAMPLES = 3;
const SLOW_FACTOR = 3;
const SLOW_FLOOR_MS = 2 * 60_000;
const MIN = 60_000;

/** Samples of one flow in one repository. Every array has one sample per run, sorted. */
export interface FlowHistory {
  /** Working time of a whole run. */
  totals: number[];
  /** Time of one visit of a step ("id#visit"). */
  ms: Record<string, number[]>;
  /** Time from the start of a step visit ("id#visit") to the end of the run. */
  left: Record<string, number[]>;
  /** Time after a step visit has ended, to the end of the run. */
  after: Record<string, number[]>;
}

export type DurationHistory = Map<string, FlowHistory>;

const validMs = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

function keyOf(run: RunSummary): string | undefined {
  const gh = run.vars?.github_repo;
  const repo = gh && gh !== "owner/repo" ? gh : run.repo; // "owner/repo" is the placeholder, not a repository
  const steps = run.flowDef?.steps;
  if (!repo || !run.flow || !Array.isArray(steps)) return undefined;
  return [repo, run.flow, steps.map((s) => `${s.id}:${s.type}`).join(",")].join("\n");
}

/**
 * The records that count: top-level, not cut short by a limit, not children of a parallel step.
 * The children of a parallel step are recorded right before the step's own record, one per child id.
 */
function counted(run: RunSummary): StepRecord[] {
  const all = (Array.isArray(run.history) ? run.history : []).filter(Boolean);
  const flow = run.flowDef?.steps ?? [];
  const children = new Set<StepRecord>();
  all.forEach((r, i) => {
    const p = r.parent ? undefined : flow.find((s) => s.id === r.id && s.type === "parallel");
    if (p?.type !== "parallel") return;
    for (let j = i - 1, left = p.steps.length; j >= 0 && left > 0 && p.steps.includes(all[j]!.id); j--, left--) children.add(all[j]!);
  });
  return all.filter((r) => !r.parent && !r.limited && !children.has(r));
}

const quantile = (sorted: number[], q: number) => {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

const push = (o: Record<string, number[]>, k: string, v: number) => (o[k] ??= []).push(v);

/** Samples from succeeded runs. Runs that are not succeeded, have no key or have a bad duration are skipped. */
export function buildHistory(runs: RunSummary[]): DurationHistory {
  const out: DurationHistory = new Map();
  for (const run of runs) {
    if (run.status !== "succeeded") continue;
    const key = keyOf(run);
    if (!key) continue;
    const recs = counted(run);
    if (!recs.length || !recs.every((r) => validMs(r.durationMs))) continue;
    const h = out.get(key) ?? { totals: [], ms: {}, left: {}, after: {} };
    out.set(key, h);
    const total = recs.reduce((a, r) => a + r.durationMs, 0);
    h.totals.push(total);
    const seen: Record<string, number> = {};
    let done = 0;
    for (const r of recs) {
      const visit = (seen[r.id] = (seen[r.id] ?? 0) + 1);
      push(h.ms, `${r.id}#${visit}`, r.durationMs);
      push(h.left, `${r.id}#${visit}`, total - done);
      done += r.durationMs;
      push(h.after, `${r.id}#${visit}`, total - done);
    }
  }
  const sort = (a: number[]) => a.sort((x, y) => x - y);
  for (const h of out.values()) {
    sort(h.totals);
    for (const o of [h.ms, h.left, h.after]) for (const a of Object.values(o)) sort(a);
  }
  return out;
}

/** Progress of a run that is not finished: "Step N of M". */
export function runProgress(run: RunSummary): RunTiming | undefined {
  const steps = run.flowDef?.steps;
  if (run.status === "succeeded" || !Array.isArray(steps) || !steps.length) return undefined;
  let id = run.state?.next ?? null;
  if (!id && run.status === "running" && !run.history?.length) id = steps.find((s) => !s.jump_only)?.id ?? null;
  if (!id) return undefined;
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) return undefined;
  return { step: i + 1, of: steps.length, stepId: id, progress: `Step ${i + 1} of ${steps.length}` };
}

/** "4 min", "25 min", "1.5 h". */
function span(ms: number): string {
  const min = ms / MIN;
  if (min < 10) return `${Math.max(1, Math.round(min))} min`;
  if (min < 90) return `${Math.round(min / 5) * 5} min`;
  return `${Math.round(min / 30) / 2} h`;
}

/** "usually 25–40 min", "usually about 30 min", "usually 50 min – 1.5 h". */
function usual([lo, hi]: [number, number]): string {
  const a = span(lo);
  const b = span(hi);
  if (a === b) return `usually about ${a}`;
  const unit = (s: string) => s.slice(s.indexOf(" "));
  return unit(a) === unit(b) ? `usually ${a.slice(0, a.indexOf(" "))}–${b}` : `usually ${a} – ${b}`;
}

const enough = (a: number[] | undefined): a is number[] => !!a && a.length >= MIN_SAMPLES;

/** Progress, plus (for a running run, when there is enough history) the usual time, a slow hint and the time left. */
export function runTiming(run: RunSummary, history: DurationHistory, now: Date = new Date()): RunTiming | undefined {
  const t = runProgress(run);
  if (!t || run.status !== "running") return t;
  const key = keyOf(run);
  const h = key ? history.get(key) : undefined;
  if (!h) return t;
  const out: RunTiming = { ...t };
  if (enough(h.totals)) out.usualTotalMs = [Math.round(quantile(h.totals, 0.25)), Math.round(quantile(h.totals, 0.75))];

  const started = run.stepStartedAt ? Date.parse(run.stepStartedAt) : NaN;
  const elapsed = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : undefined;
  // Loops: samples are per visit, so a second visit of a step has its own numbers.
  const visit = counted(run).filter((r) => r.id === t.stepId).length + 1;
  const ms = h.ms[`${t.stepId}#${visit}`];
  if (elapsed !== undefined && enough(ms)) {
    if (elapsed > SLOW_FACTOR * quantile(ms, 0.5) && elapsed > SLOW_FLOOR_MS) {
      out.slow = true;
      out.note = "Taking longer than usual";
    }
  }

  const left = h.left[`${t.stepId}#${visit}`];
  const after = h.after[`${t.stepId}#${visit}`];
  if (enough(left) && enough(after)) {
    out.leftMs = Math.round(Math.max(quantile(left, 0.5) - (elapsed ?? 0), quantile(after, 0.5)));
  }

  if (out.usualTotalMs) {
    const total = `${usual(out.usualTotalMs)} in total`;
    out.estimate = out.leftMs !== undefined ? `Estimate: about ${span(out.leftMs)} left (${total})` : `Estimate: ${total}`;
  }
  return out;
}

/** "after #88" becomes "after #88 (about 20 min left)". */
export function withWaitLeft(n: NextStep, leftMs: number | undefined): NextStep {
  if (leftMs === undefined || !Number.isFinite(leftMs)) return n;
  const base = n.until ?? (n.afterRun ? "after that run" : undefined);
  if (!base) return n;
  return { ...n, until: `${base} (about ${span(leftMs)} left)` };
}
