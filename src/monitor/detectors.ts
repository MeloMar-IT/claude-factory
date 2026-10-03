import type { MonitorConfig, WatcherConfig } from "../config.js";
import type { DurationHistory } from "../estimate.js";
import type { RunSummary } from "../engine/state.js";
import { cleanLine, errorKind, explainError, GITHUB_LIMIT_RE, NOT_EXPLAINED } from "../errors.js";
import { classifyFailure, failedIndex } from "../failure.js";
import type { RateReading } from "../github.js";
import type { Scheduler } from "../queue/scheduler.js";
import { parseInterval, type TrackedIssue, type WatcherStatus } from "../queue/watcher.js";
import type { UpdateState } from "../self-update-state.js";
import type { Evidence, FindingInput, Severity } from "./findings.js";

export interface LogLine { at: string; text: string }

/** A run that runs now, with the newest write to any of its logs. */
export interface ActiveRun { run: RunSummary; lastWrite?: string }

/** A lock the lock tool honours. `orphanSince` is set while its owner is not running. No run id. */
export interface AreaLock { repo: string; areas: string[]; at: string; orphanSince?: string }

/** Everything a detector may look at. Plain data: no detector calls an AI or GitHub. */
export interface DetectorInput {
  now: Date;
  /** The server was asleep just before this check: timers are overdue, so nothing is judged silent. */
  asleep: boolean;
  config: MonitorConfig;
  /** Runs that were resumed lately and runs that failed lately (loaded in full). */
  runs: RunSummary[];
  watchers: { cfg: WatcherConfig; status: WatcherStatus; issues?: TrackedIssue[] }[];
  log: LogLine[];
  rate?: RateReading;
  /** The queue as it is now. */
  queue: ReturnType<Scheduler["queue"]>;
  /** The monitor's own id: its log lines are not evidence. */
  monitorId: string;
  /** When the server woke up after a sleep (set only for the check right after it). */
  wokeAt?: string;
  /** Runs that run now. */
  active?: ActiveRun[];
  /** Area locks that the lock tool honours. */
  areaLocks?: AreaLock[];
  /** When a job last started (or the scheduler was created). */
  lastStart?: string;
  /** Set while the server waits to restart. */
  restart?: { why: "new_version" | "data_folder"; since: string };
  /** Usual step times from older succeeded runs. */
  history?: DurationHistory;
  /** The record of the self-update (`broken`: it could not be read). */
  update?: { state: UpdateState; broken: boolean };
}

export interface Detector {
  name: string;
  /** What it looks for and why it matters: two short sentences the app can show. */
  description: string;
  run(input: DetectorInput): FindingInput[];
}

export const HOUR = 3_600_000;
const RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
export const iso = (ms: number) => new Date(ms).toISOString();
export const uniq = <T>(list: T[]) => [...new Set(list)];
export const when = (r: RunSummary) => Date.parse(r.finishedAt ?? r.startedAt);
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** The newest `n` of a list of times, as ISO text. */
export const latest = (times: number[], n = 5) => [...times].sort((a, b) => b - a).slice(0, n).map(iso);

/** The failed step of a run, and its error (or the run's reason without the "step … failed:" prefix). */
export function failure(run: RunSummary): { step: string; error: string; record?: RunSummary["history"][number] } {
  const history = Array.isArray(run.history) ? run.history : [];
  const record = history[failedIndex(history)];
  const reason = (run.reason ?? "").replace(/^step "[\w./-]+" failed:\s*/, "");
  return { step: record?.id ?? "", error: (record?.error ?? reason).trim(), record };
}

export const ownerRepo = (r: RunSummary): string | undefined => {
  const v = r.vars?.github_repo;
  return v && v !== "owner/repo" && /^[\w.-]+\/[\w.-]+$/.test(v) ? v : undefined;
};

/** Same run resumed more than N times in M minutes. */
const restartLoop: Detector = {
  name: "restart-loop",
  description: "The same run is resumed again and again within a few minutes. It keeps a slot busy and never gets further.",
  run({ now, config, runs }) {
    const { resumes, within_minutes } = config.restart_loop;
    const from = now.getTime() - within_minutes * 60_000;
    const groups = new Map<string, { flow: string; steps: string[]; runs: number; max: number; total: number; times: number[] }>();
    // Per run: its resumes inside the window. A run over the threshold belongs to a group of flow + the set of steps.
    const hits = runs.flatMap((run) => {
      const log = (Array.isArray(run.resumeLog) ? run.resumeLog : []).filter((e) => Date.parse(e.at) >= from && Date.parse(e.at) <= now.getTime());
      return log.length > resumes ? [{ run, log }] : [];
    });
    for (const { run, log } of hits) {
      const steps = uniq(log.map((e) => e.from)).sort();
      const key = `${run.flow}|${steps.join("+")}`;
      const g = groups.get(key) ?? { flow: run.flow, steps, runs: 0, max: 0, total: 0, times: [] };
      g.runs++;
      g.max = Math.max(g.max, log.length);
      g.total += log.length;
      g.times.push(...log.map((e) => Date.parse(e.at)));
      groups.set(key, g);
    }
    return [...groups].map(([key, g]) => ({
      detector: "restart-loop",
      fingerprint: `restart-loop|${key}`,
      severity: "critical" as const,
      summary: `Runs of flow ${g.flow} are resumed again and again at step ${g.steps.join(" and ")}: ${g.max} times in ${within_minutes} minutes.`,
      evidence: { counts: { runs: g.runs, resumes: g.total, most_resumes_of_one_run: g.max, within_minutes }, times: latest(g.times), steps: g.steps, flows: [g.flow] },
      about: "foundry" as const,
    }));
  },
};

/** A watcher's check failed more than N checks in a row; grouped by kind of error. */
const watcherError: Detector = {
  name: "watcher-error",
  description: "A watcher's check failed many times in a row. It finds no new work until the cause is fixed.",
  run({ config, watchers }) {
    const groups = new Map<string, { kind: string; ids: string[]; checks: number; since: number[]; lines: string[] }>();
    for (const { cfg, status } of watchers) {
      const error = status.lastError;
      if (!cfg.enabled || !error || (status.errorCount ?? 0) <= config.watcher_error.checks || GITHUB_LIMIT_RE.test(error)) continue;
      const ex = explainError(error, "watcher");
      const kind = ex.why === NOT_EXPLAINED ? errorKind(error) : ex.what;
      const g = groups.get(kind) ?? { kind, ids: [], checks: 0, since: [], lines: [] };
      g.ids.push(cfg.id);
      g.checks = Math.max(g.checks, status.errorCount ?? 0);
      if (status.errorSince) g.since.push(Date.parse(status.errorSince));
      g.lines.push(cleanLine(error).slice(0, 300));
      groups.set(kind, g);
    }
    return [...groups].map(([kind, g]) => ({
      detector: "watcher-error",
      fingerprint: `watcher-error|${kind}`,
      severity: "major" as const,
      summary: `${plural(g.ids.length, "watcher")} failed ${g.checks} checks in a row: ${kind}.`,
      evidence: { counts: { watchers: g.ids.length, failed_checks: g.checks }, times: latest(g.since), watchers: g.ids.sort(), lines: uniq(g.lines).slice(0, 5) },
      about: "foundry" as const,
    }));
  },
};

/** GitHub's request limit was hit, or more than N% of it was used. */
const githubLimit: Detector = {
  name: "github-limit",
  description: "GitHub's request limit is used up or nearly used up. Every call of the Foundry is refused until it resets.",
  run({ now, config, watchers, log, rate, monitorId, runs }) {
    const t = now.getTime();
    const found = new Map<string, FindingInput>();
    const add = (resource: string, severity: Severity, summary: string, evidence: Evidence) => {
      const fingerprint = `github-limit|${resource}`;
      const have = found.get(fingerprint);
      if (!have) {
        found.set(fingerprint, { detector: "github-limit", fingerprint, severity, summary, evidence, about: "foundry" });
        return;
      }
      // The same problem seen again: keep the worse severity, and every count, time, step and line.
      const hits = (have.evidence.counts?.hits ?? 0) + (evidence.counts?.hits ?? 0);
      const worse = RANK[severity] < RANK[have.severity];
      have.evidence = {
        ...(worse ? evidence : have.evidence),
        counts: { ...(have.evidence.counts ?? {}), ...(evidence.counts ?? {}), ...(hits ? { hits } : {}) },
        times: uniq([...(have.evidence.times ?? []), ...(evidence.times ?? [])]).slice(0, 5),
        steps: uniq([...(have.evidence.steps ?? []), ...(evidence.steps ?? [])]),
        lines: uniq([...(have.evidence.lines ?? []), ...(evidence.lines ?? [])]).slice(0, 5),
      };
      if (worse) {
        have.severity = severity;
        have.summary = summary;
      }
    };
    const kindOf = (text: string) => (/secondary rate limit/i.test(text) ? "secondary" : /graphql/i.test(text) ? "graphql" : "core");
    const hit = (text: string, source: string, at?: number) => {
      const kind = kindOf(text);
      add(kind, "critical", `GitHub's request limit (${kind}) was hit: the Foundry's calls are refused until it is lifted.`,
        { counts: { hits: 1 }, ...(at ? { times: [iso(at)] } : {}), lines: [cleanLine(text).slice(0, 300)], steps: source ? [source] : [] });
    };

    // 1. The stored reading of `gh api rate_limit`, when it is fresh and its window has not reset.
    if (rate && t - Date.parse(rate.at) < HOUR) {
      for (const [name, r] of Object.entries(rate.resources)) {
        if (r.reset * 1000 <= t || r.limit <= 0) continue;
        const percent = Math.round((r.used / r.limit) * 100);
        if (r.remaining === 0) add(name, "critical", `GitHub's request limit (${name}) is used up: ${r.used} of ${r.limit} requests.`, { counts: { used: r.used, limit: r.limit, percent }, times: [rate.at] });
        else if ((r.used / r.limit) * 100 > config.github_limit.percent) add(name, "major", `More than ${config.github_limit.percent}% of GitHub's request limit (${name}) is used: ${percent}%.`, { counts: { used: r.used, limit: r.limit, percent }, times: [rate.at] });
      }
    }
    // 2. A watcher that could not check because of the limit.
    for (const { cfg, status } of watchers) {
      // Only a recent check counts: an old error of a slow watcher would keep the finding alive for ever.
      const last = Date.parse(status.lastTick ?? status.startedAt ?? "");
      if (cfg.enabled && status.lastError && GITHUB_LIMIT_RE.test(status.lastError) && t - last <= HOUR) hit(status.lastError, "", last);
    }
    // 3. The server's own log of the last hour.
    for (const line of log) {
      const at = Date.parse(line.at);
      if (t - at > HOUR || line.text.startsWith(`[${monitorId}]`) || !GITHUB_LIMIT_RE.test(line.text)) continue;
      hit(line.text, "", at);
    }
    // 4. Runs that failed in the last hour: the reason, the step's error, and the output of a shell step (an agent may quote the words).
    for (const run of runs) {
      if (run.status !== "failed" || t - when(run) > HOUR) continue;
      const { step, record } = failure(run);
      const texts = [run.reason ?? "", record?.error ?? "", ...(record?.type === "shell" ? (record.output ?? "").split("\n") : [])];
      const line = texts.find((x) => GITHUB_LIMIT_RE.test(x));
      if (line) hit(line.trim(), step, when(run));
    }
    return [...found.values()];
  },
};

/** An enabled watcher finished no check for N times its interval. */
const watcherSilent: Detector = {
  name: "watcher-silent",
  description: "An enabled watcher finished no check for many times its interval. It may be stuck, so no new work arrives.",
  run({ now, asleep, config, watchers, restart }) {
    if (asleep || restart) return [];
    const out: FindingInput[] = [];
    for (const { cfg, status } of watchers) {
      if (!cfg.enabled) continue;
      let every: number;
      try {
        every = parseInterval(cfg.every);
      } catch {
        continue; // the watcher reports a bad interval as its own error
      }
      const last = status.lastTick ?? status.startedAt;
      if (!last) continue;
      const silent = now.getTime() - Date.parse(last);
      if (silent <= config.watcher_silent.intervals * every) continue;
      out.push({
        detector: "watcher-silent",
        fingerprint: `watcher-silent|${cfg.id}`,
        severity: "critical",
        summary: `Watcher ${cfg.id} finished no check for ${Math.round(silent / 60_000)} minutes (its interval is ${cfg.every}).`,
        evidence: { counts: { silent_minutes: Math.round(silent / 60_000), interval_minutes: Math.round(every / 60_000) }, times: [last], watchers: [cfg.id] },
        about: "foundry",
        ...(cfg.github_repo ? { repo: cfg.github_repo } : {}),
      });
    }
    return out;
  },
};

/** A run failed with an error that no rule of the Foundry explains. */
const unexplainedFailure: Detector = {
  name: "unexplained-failure",
  description: "A run failed with an error that no rule of the Foundry explains. It may be a bug that needs a fix.",
  run({ now, config, runs }) {
    const from = now.getTime() - config.unexplained_failure.within_hours * HOUR;
    const groups = new Map<string, { flow: string; step: string; line: string; repo?: string; times: number[] }>();
    for (const run of runs) {
      if (run.status !== "failed" || when(run) < from) continue;
      const { step, error } = failure(run);
      if (explainError(error, "run").why !== NOT_EXPLAINED) continue;
      // The model's note is not a rule: it is left out, so the run counts as before.
      if (classifyFailure({ status: run.status, reason: run.reason, history: run.history, failureNote: undefined }).cause !== "code") continue;
      const line = cleanLine(error.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
      const repo = ownerRepo(run);
      const key = `${run.flow}|${step}|${line}|${repo ?? ""}`;
      const g = groups.get(key) ?? { flow: run.flow, step, line, repo, times: [] };
      g.times.push(when(run));
      groups.set(key, g);
    }
    return [...groups.values()].filter((g) => g.times.length >= config.unexplained_failure.runs).map((g) => ({
      detector: "unexplained-failure",
      fingerprint: `unexplained-failure|${g.repo ?? ""}|${g.flow}|${g.step}|${g.line}`,
      severity: "minor" as const,
      summary: `A run of flow ${g.flow} failed${g.step ? ` at step ${g.step}` : ""} with an error the Foundry cannot explain.`,
      evidence: { counts: { failures: g.times.length }, times: latest(g.times), steps: g.step ? [g.step] : [], lines: g.line ? [g.line] : [], flows: [g.flow], ...(g.repo ? { repos: [g.repo] } : {}) },
      about: "project" as const,
      ...(g.repo ? { repo: g.repo } : {}),
    }));
  },
};

/** The self-update failed (the old version keeps running), or it could not go back, or its record is broken. */
const selfUpdate: Detector = {
  name: "self-update",
  description: "A self-update failed, could not go back, or its record cannot be read. The Foundry then keeps running an old version, or self-update is stopped until a person checks the checkout.",
  run({ update }) {
    if (!update) return [];
    if (update.broken) {
      return [{
        detector: "self-update",
        fingerprint: "self-update|state",
        severity: "critical",
        summary: "The self-update record could not be read; self-update is stopped until a person checks the checkout.",
        evidence: { counts: { failed: 1 } },
        about: "foundry",
      }];
    }
    const f = update.state.failed;
    if (!f) return [];
    const sha = f.commit.slice(0, 7);
    const [severity, summary]: [Severity, string] =
      f.backOk === false ? ["critical", `The update to ${sha} failed and the Foundry could not go back to the version before it; the checkout must be repaired by hand.`]
      : f.stage === "start" ? ["critical", `The update to ${sha} did not start healthy; the Foundry went back to the version before it.`]
      : ["major", `The update to ${sha} failed at ${f.stage}; the old version keeps running.`];
    return [{
      detector: "self-update",
      fingerprint: `self-update|${f.stage}`,
      severity,
      summary,
      evidence: { counts: { failed: 1 }, times: [f.at], steps: [f.stage], lines: f.lines ?? [] },
      about: "foundry",
    }];
  },
};

export const DETECTORS: Detector[] = [restartLoop, watcherError, githubLimit, watcherSilent, unexplainedFailure, selfUpdate];

/** Hides what an error message of a crashed detector may hold: folders and long numbers. */
const safeMessage = (e: unknown) => cleanLine(String((e as Error)?.message ?? e)).slice(0, 200);

/** Runs every detector. One that throws becomes a finding of its own and does not stop the others. */
export function runDetectors(detectors: Detector[], input: DetectorInput): FindingInput[] {
  const out: FindingInput[] = [];
  for (const d of detectors) {
    try {
      out.push(...d.run(input));
    } catch (e) {
      const msg = safeMessage(e);
      out.push({
        detector: "detector-failed",
        fingerprint: `detector-failed|${d.name}`,
        severity: "major",
        summary: `Detector ${d.name} failed, so its problems are not checked.`,
        evidence: { lines: [msg], counts: { failed: 1 } },
        about: "foundry",
      });
    }
  }
  return out;
}
