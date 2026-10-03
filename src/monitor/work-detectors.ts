import { cleanLine } from "../errors.js";
import { slowVisits } from "../estimate.js";
import { failedIndex } from "../failure.js";
import type { RunSummary } from "../engine/state.js";
import { DETECTORS, failure, HOUR, iso, latest, ownerRepo, plural, uniq, when, type Detector } from "./detectors.js";
import type { FindingInput } from "./findings.js";

// Detectors of the slower and quieter problems: work that stands still, steps that keep failing, labels that lie.
// Plain data in, findings out. They never call an AI or GitHub, and no evidence holds a run id.

const MIN = 60_000;
const num = (text: string | undefined): number => {
  const t = Date.parse(text ?? "");
  return Number.isFinite(t) ? t : 0;
};

/** The failed step that started the trouble: a step that only handles another step's failure (`on_failure`) steps back to it. */
function rootFailure(run: RunSummary): { step: string; error: string } {
  const f = failure(run);
  const history = Array.isArray(run.history) ? run.history : [];
  let idx = failedIndex(history);
  let record = f.record;
  for (let i = 0; i < 8 && record && idx > 0 && !record.parent; i++) {
    const prev = history[idx - 1];
    const step = prev && run.flowDef?.steps?.find((s) => s.id === prev.id);
    if (!prev || prev.ok || prev.parent || !step || step.on_failure !== record.id) break;
    idx--;
    record = prev;
  }
  return { step: record?.id ?? f.step, error: (record?.error ?? f.error).trim() };
}

/** The step a running run is at, or the first one of a run that has not recorded a step yet. */
function currentStep(run: RunSummary) {
  const steps = run.flowDef?.steps;
  if (!Array.isArray(steps)) return undefined;
  const id = run.state?.next ?? (run.history?.length ? undefined : steps.find((s) => !s.jump_only)?.id);
  return id ? steps.find((s) => s.id === id) : undefined;
}

/**
 * The timeout of the step a run is at, in seconds; undefined when it has none. "unknown" for a `flow` step (the engine
 * does not apply its timeout to the steps inside) and a `parallel` step with a `flow` child: they are not judged.
 */
function stepTimeoutSec(run: RunSummary): number | undefined | "unknown" {
  const step = currentStep(run);
  if (!step) return "unknown";
  const dflt = run.flowDef.defaults?.timeout_sec;
  if (step.type === "flow") return "unknown";
  if (step.type === "parallel") {
    const kids = step.steps.map((id) => run.flowDef.steps.find((s) => s.id === id));
    if (kids.some((k) => !k || k.type === "flow")) return "unknown";
    const t = kids.map((k) => k!.timeout_sec ?? dflt);
    return t.some((x) => x === undefined) ? undefined : Math.max(...(t as number[]));
  }
  return step.timeout_sec ?? dflt;
}

const repoOf = (run: RunSummary) => ownerRepo(run) ?? "";

/** A running run wrote nothing to its log for longer than the timeout of its step plus a margin. */
const stuckRun: Detector = {
  name: "stuck-run",
  description: "A running run wrote nothing to its log for longer than its step may take. It holds a slot and its story stands still until someone notices.",
  run({ now, asleep, config, active, wokeAt }) {
    if (asleep) return [];
    const t = now.getTime();
    const { extra_minutes, no_timeout_minutes } = config.stuck_run;
    const groups = new Map<string, { flow: string; step: string; repo: string; runs: number; quiet: number; since: number[] }>();
    for (const { run, lastWrite } of active ?? []) {
      if (run.status !== "running") continue;
      const timeout = stepTimeoutSec(run);
      if (timeout === "unknown") continue;
      const step = currentStep(run)!;
      const limit = (timeout === undefined ? no_timeout_minutes * 60 : timeout) * 1000 + extra_minutes * MIN;
      // The quiet time starts at the newest sign of life: a log line, the start, a resume, the step's start, the wake-up.
      const resumes = Array.isArray(run.resumeLog) ? run.resumeLog.map((e) => num(e.at)) : [];
      const since = Math.max(num(lastWrite), num(run.startedAt), num(run.stepStartedAt), num(wokeAt), ...resumes);
      if (!since || t - since <= limit) continue;
      const key = `${repoOf(run)}|${run.flow}|${step.id}`;
      const g = groups.get(key) ?? { flow: run.flow, step: step.id, repo: repoOf(run), runs: 0, quiet: 0, since: [] };
      g.runs++;
      g.quiet = Math.max(g.quiet, Math.round((t - since) / MIN));
      g.since.push(since);
      groups.set(key, g);
    }
    return [...groups].map(([key, g]) => ({
      detector: "stuck-run",
      fingerprint: `stuck-run|${key}`,
      severity: "major" as const,
      summary: `${plural(g.runs, "run")} of flow ${g.flow} wrote nothing to the log for ${g.quiet} minutes at step ${g.step}.`,
      evidence: { counts: { runs: g.runs, quiet_minutes: g.quiet }, times: latest(g.since), steps: [g.step], flows: [g.flow], ...(g.repo ? { repos: [g.repo] } : {}) },
      about: "foundry" as const,
      ...(g.repo ? { repo: g.repo } : {}),
    }));
  },
};

/** The same step of the same flow ended runs as failed for several different issues. */
const sameStepFailing: Detector = {
  name: "same-step-failing",
  description: "The same step of a flow failed the run for several different issues in a short time. The cause is probably not the issues but the step or the project.",
  run({ now, config, runs }) {
    const { issues, within_hours } = config.same_step_failing;
    const from = now.getTime() - within_hours * HOUR;
    const groups = new Map<string, { flow: string; step: string; repo: string; issues: Set<string>; runs: number; times: number[]; line: string; newest: number }>();
    for (const run of runs) {
      if (run.status !== "failed" || when(run) < from || when(run) > now.getTime()) continue;
      const reason = run.reason ?? "";
      // A person's "no", the run's own budget and an interrupted run say nothing about the step.
      if (/interrupted/.test(reason) || /^run budget of /.test(reason) || /^rejected\b/.test(failure(run).error)) continue;
      const issue = run.vars?.issue;
      if (!issue) continue;
      const { step, error } = rootFailure(run);
      if (!step) continue;
      const repo = repoOf(run);
      const key = `${repo}|${run.flow}|${step}`;
      const g = groups.get(key) ?? { flow: run.flow, step, repo, issues: new Set(), runs: 0, times: [], line: "", newest: 0 };
      g.issues.add(issue);
      g.runs++;
      g.times.push(when(run));
      if (when(run) >= g.newest) {
        g.newest = when(run);
        g.line = cleanLine(error.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
      }
      groups.set(key, g);
    }
    return [...groups].filter(([, g]) => g.issues.size >= issues).map(([key, g]) => ({
      detector: "same-step-failing",
      fingerprint: `same-step-failing|${key}`,
      severity: "major" as const,
      summary: `Step ${g.step} of flow ${g.flow} failed the run for ${g.issues.size} different issues in ${within_hours} hours.`,
      evidence: { counts: { issues: g.issues.size, runs: g.runs, within_hours }, times: latest(g.times), steps: [g.step], flows: [g.flow], ...(g.line ? { lines: [g.line] } : {}), ...(g.repo ? { repos: [g.repo] } : {}) },
      about: "project" as const,
      ...(g.repo ? { repo: g.repo } : {}),
    }));
  },
};

const LABEL_WORDS: Record<string, string> = { working: "working", done: "done", needsInfo: "needs-info", waiting: "waiting-approval", failed: "failed" };

/** An issue's status label did not fit its newest run for several checks in a row. */
const labelMismatch: Detector = {
  name: "label-mismatch",
  description: "An issue carries a status label that does not match its newest run, check after check. People then look at the wrong story and the watcher may not move it on.",
  run({ config, watchers, restart }) {
    if (restart) return [];
    const out: FindingInput[] = [];
    for (const { cfg, status, issues } of watchers) {
      if (!cfg.enabled || status.lastError || !issues) continue; // a watcher in error shows old data
      const off = issues.filter((i) => i.labelOff && i.labelOff.checks > config.label_mismatch.checks);
      if (!off.length) continue;
      const lines = off.slice(0, 5).map((i) => `#${i.issue}: the label says ${LABEL_WORDS[i.labelOff!.label] ?? "something else"}, the run is ${i.labelOff!.run}`);
      out.push({
        detector: "label-mismatch",
        fingerprint: `label-mismatch|${cfg.id}`,
        severity: "minor",
        summary: `${plural(off.length, "issue")} of ${cfg.github_repo || cfg.id} ${off.length === 1 ? "has" : "have"} a status label that does not match the run.`,
        evidence: { counts: { issues: off.length, checks: Math.max(...off.map((i) => i.labelOff!.checks)) }, lines, watchers: [cfg.id], ...(cfg.github_repo ? { repos: [cfg.github_repo] } : {}) },
        about: "foundry",
        ...(cfg.github_repo ? { repo: cfg.github_repo } : {}),
      });
    }
    return out;
  },
};

/** A code-area lock or a run lock is held by a run that is not running. */
const orphanLock: Detector = {
  name: "orphan-lock",
  description: "A lock is held by a run that is not running any more. Other runs wait for it and nothing frees it by itself.",
  run({ now, asleep, config, areaLocks, active, queue, wokeAt }) {
    if (asleep) return [];
    const t = now.getTime();
    const limit = config.orphan_lock.minutes * MIN;
    const out: FindingInput[] = [];
    // Area locks: the monitor sets `orphanSince` when it first saw the lock without an owner.
    const byRepo = new Map<string, { areas: string[]; since: number[] }>();
    for (const l of areaLocks ?? []) {
      if (!l.orphanSince) continue;
      const since = Math.max(num(l.orphanSince), num(wokeAt));
      if (!since || t - since <= limit) continue;
      const g = byRepo.get(l.repo) ?? { areas: [], since: [] };
      g.areas.push(...l.areas);
      g.since.push(since);
      byRepo.set(l.repo, g);
    }
    for (const [repo, g] of byRepo) {
      out.push({
        detector: "orphan-lock",
        fingerprint: `orphan-lock|area|${repo}`,
        severity: "major",
        summary: `A code-area lock of ${repo} is held by a run that is not running, for more than ${config.orphan_lock.minutes} minutes.`,
        evidence: { counts: { locks: g.since.length, minutes: Math.round((t - Math.min(...g.since)) / MIN) }, times: latest(g.since), lines: uniq(g.areas.map((a) => cleanLine(a).slice(0, 120))).slice(0, 5) },
        about: "foundry",
      });
    }
    // Run locks: a job that still holds its lock key although its run has ended.
    const ended = new Map<string, { flow: string; since: number }[]>();
    for (const a of queue.active) {
      if (!a.lockKey && !a.repoLock) continue;
      const run = (active ?? []).find((x) => x.run.runId === a.runId);
      if (!run || run.run.status === "running") continue;
      const since = Math.max(num(run.run.finishedAt) || num(run.lastWrite), num(wokeAt));
      if (!since || t - since <= limit) continue;
      const list = ended.get(run.run.flow) ?? [];
      list.push({ flow: run.run.flow, since });
      ended.set(run.run.flow, list);
    }
    for (const [flow, list] of ended) {
      out.push({
        detector: "orphan-lock",
        fingerprint: `orphan-lock|run|${flow}`,
        severity: "major",
        summary: `${plural(list.length, "run")} of flow ${flow} still hold${list.length === 1 ? "s" : ""} a lock after ending, for more than ${config.orphan_lock.minutes} minutes.`,
        evidence: { counts: { runs: list.length }, times: latest(list.map((x) => x.since)), flows: [flow] },
        about: "foundry",
      });
    }
    return out;
  },
};

/** Jobs are queued, slots are free, and nothing started. */
const queueStalled: Detector = {
  name: "queue-stalled",
  description: "Jobs wait in the queue while a slot is free, and nothing starts. All new work stands still.",
  run({ now, asleep, config, queue, lastStart, wokeAt }) {
    if (asleep || !lastStart) return [];
    const free = queue.concurrency - queue.active.length;
    // A job with `waitingFor` waits for a lock on purpose; the others could start now.
    const ready = queue.pending.filter((p) => !p.waitingFor);
    if (free <= 0 || !ready.length) return [];
    const queued = Math.min(...ready.map((p) => num(p.enqueuedAt)));
    const since = Math.max(num(lastStart), queued, num(wokeAt));
    const stalled = now.getTime() - since;
    if (stalled <= config.queue_stalled.minutes * MIN) return [];
    return [{
      detector: "queue-stalled",
      fingerprint: "queue-stalled",
      severity: "critical",
      summary: `${plural(ready.length, "job")} could start, but nothing started for ${Math.round(stalled / MIN)} minutes although ${plural(free, "slot")} ${free === 1 ? "is" : "are"} free.`,
      evidence: { counts: { queued: ready.length, free_slots: free, stalled_minutes: Math.round(stalled / MIN) }, times: [iso(since)] },
      about: "foundry",
    }];
  },
};

/** A new version is installed and the server has waited too long to restart. */
const restartOverdue: Detector = {
  name: "restart-overdue",
  description: "A new version is installed, but the server has waited too long to restart. Fixes stay out of use and new work is held back meanwhile.",
  run({ now, config, restart, wokeAt }) {
    if (restart?.why !== "new_version") return [];
    const since = Math.max(num(restart.since), num(wokeAt));
    const waited = now.getTime() - since;
    if (!since || waited <= config.restart_overdue.hours * HOUR) return [];
    return [{
      detector: "restart-overdue",
      fingerprint: "restart-overdue",
      severity: "major",
      summary: `A new version is installed and the server has waited ${Math.round(waited / MIN)} minutes to restart.`,
      evidence: { counts: { waited_minutes: Math.round(waited / MIN) }, times: [restart.since] },
      about: "foundry",
    }];
  },
};

/** The tests after a merge into develop failed several times in a row. */
const developRed: Detector = {
  name: "develop-red",
  description: "The tests after a merge into the develop branch failed several times in a row. Every new story starts from a broken branch until it is fixed.",
  run({ now, config, runs }) {
    const { failures, within_hours } = config.develop_red;
    const from = now.getTime() - within_hours * HOUR;
    const byRepo = new Map<string, { at: number; ok: boolean; run: string }[]>();
    for (const run of runs) {
      if (run.status === "cancelled") continue;
      for (const r of Array.isArray(run.history) ? run.history : []) {
        if (r.id !== "test_develop" || r.parent || r.limited || /^cancelled/.test(r.error ?? "")) continue;
        const at = num(r.startedAt) + (Number.isFinite(r.durationMs) ? r.durationMs : 0);
        if (!at || at < from || at > now.getTime()) continue;
        const list = byRepo.get(repoOf(run)) ?? [];
        list.push({ at, ok: r.ok, run: run.runId });
        byRepo.set(repoOf(run), list);
      }
    }
    const out: FindingInput[] = [];
    for (const [repo, list] of byRepo) {
      list.sort((a, b) => b.at - a.at);
      const streak = list.findIndex((x) => x.ok);
      const red = list.slice(0, streak < 0 ? list.length : streak);
      if (red.length < failures) continue;
      out.push({
        detector: "develop-red",
        fingerprint: `develop-red|${repo}`,
        severity: "critical",
        summary: `The tests after a merge into develop failed ${red.length} times in a row${repo ? ` in ${repo}` : ""}.`,
        evidence: { counts: { failures_in_a_row: red.length, stories: new Set(red.map((x) => x.run)).size }, times: latest(red.map((x) => x.at)), steps: ["test_develop"], ...(repo ? { repos: [repo] } : {}) },
        about: "project",
        ...(repo ? { repo } : {}),
      });
    }
    return out;
  },
};

/** A step took much longer than usual, several times. */
const slowStep: Detector = {
  name: "slow-step",
  description: "A step took much longer than its usual time, several times in a day. Something may have slowed down, such as a tool, the network or the machine.",
  run({ now, config, runs, history }) {
    if (!history?.size) return [];
    const { factor, times, within_hours } = config.slow_step;
    const from = now.getTime() - within_hours * HOUR;
    const groups = new Map<string, { flow: string; step: string; repo: string; ends: number[]; slowest: number; usual: number }>();
    for (const run of runs) {
      for (const v of slowVisits(run, history, factor)) {
        if (v.endedAt < from || v.endedAt > now.getTime()) continue;
        const key = `${repoOf(run)}|${run.flow}|${v.id}`;
        const g = groups.get(key) ?? { flow: run.flow, step: v.id, repo: repoOf(run), ends: [], slowest: 0, usual: v.usualMs };
        g.ends.push(v.endedAt);
        g.slowest = Math.max(g.slowest, v.durationMs);
        g.usual = Math.min(g.usual, v.usualMs);
        groups.set(key, g);
      }
    }
    return [...groups].filter(([, g]) => g.ends.length >= times).map(([key, g]) => ({
      detector: "slow-step",
      fingerprint: `slow-step|${key}`,
      severity: "minor" as const,
      summary: `Step ${g.step} of flow ${g.flow} took more than ${factor} times its usual time, ${g.ends.length} times in ${within_hours} hours.`,
      evidence: { counts: { slow_visits: g.ends.length, slowest_minutes: Math.round(g.slowest / MIN), usual_minutes: Math.round(g.usual / MIN) }, times: latest(g.ends), steps: [g.step], flows: [g.flow], ...(g.repo ? { repos: [g.repo] } : {}) },
      about: "foundry" as const,
      ...(g.repo ? { repo: g.repo } : {}),
    }));
  },
};

export const WORK_DETECTORS: Detector[] = [stuckRun, sameStepFailing, labelMismatch, orphanLock, queueStalled, restartOverdue, developRed, slowStep];

export const ALL_DETECTORS: Detector[] = [...DETECTORS, ...WORK_DETECTORS];

/** Name and description of every finding the monitor can make, for the app. */
export function detectorInfo(): { name: string; description: string }[] {
  return [
    ...ALL_DETECTORS.map(({ name, description }) => ({ name, description })),
    { name: "detector-failed", description: "A detector of the monitor crashed, so the problems it looks for are not checked. The monitor itself needs a fix." },
  ];
}
