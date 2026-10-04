import type { MonitorConfig, WatcherConfig } from "../config.js";
import type { RunBrief, RunSummary } from "../engine/state.js";
import type { TrackedIssue, WatcherStatus } from "../queue/watcher.js";
import type { ActiveRun } from "./detectors.js";
import { MAX_EARLIER, type Finding } from "./findings.js";
import type { BreakerWhy } from "./guard.js";
import type { LockFile } from "./monitor.js";

/**
 * Pure helpers for the circuit breaker and for "no circles": runs that build a bug story of the monitor are never a finding,
 * a failed one counts as "the fix failed", and many new findings or failed fixes in a row stop the stories.
 */

const key = (repo: string, issue: number | string) => `${repo.toLowerCase()}#${issue}`;

/** The bug stories of the findings: the current one and the earlier ones (repository ignores case). */
export function storyKeys(findings: Finding[]): Set<string> {
  const out = new Set<string>();
  for (const f of findings) {
    if (f.report) out.add(key(f.report.repo, f.report.issue));
    for (const e of f.earlier ?? []) out.add(key(e.repo, e.issue));
  }
  return out;
}

const issueOf = (x: string | undefined): number | undefined => (x !== undefined && /^\d+$/.test(x) ? Number(x) : undefined);

/** Does this run build one of the bug stories? */
export function isStoryRun(b: { githubRepo?: string; issue?: string }, stories: Set<string>): boolean {
  const n = issueOf(b.issue);
  return !!b.githubRepo && n !== undefined && stories.has(key(b.githubRepo, n));
}

export interface Seen {
  runs: RunSummary[];
  active: ActiveRun[];
  watchers: { cfg: WatcherConfig; status: WatcherStatus; issues?: TrackedIssue[] }[];
  locks: LockFile[];
}

const summaryIsStory = (r: RunSummary, stories: Set<string>) => isStoryRun({ githubRepo: r.vars?.github_repo, issue: r.vars?.issue }, stories);

/**
 * What the detectors may look at: without the runs of bug stories, their issues in the watchers, and the area locks they hold.
 * `ids` are run ids (and folder names) known to be story runs. Does not change its input.
 */
export function withoutStoryRuns(seen: Seen, stories: Set<string>, ids: string[] = []): Seen {
  const gone = new Set(ids);
  for (const r of seen.runs) if (summaryIsStory(r, stories)) gone.add(r.runId);
  for (const a of seen.active) if (summaryIsStory(a.run, stories)) gone.add(a.run.runId);
  return {
    runs: seen.runs.filter((r) => !summaryIsStory(r, stories)),
    active: seen.active.filter((a) => !summaryIsStory(a.run, stories)),
    watchers: seen.watchers.map((w) => {
      if (!w.issues) return w;
      const issues = w.issues.filter((i) => !stories.has(key(w.cfg.github_repo, i.issue)));
      return issues.length === w.issues.length ? w : { ...w, issues };
    }),
    locks: seen.locks.filter((l) => !gone.has(l.runId)),
  };
}

/** A story that a newer one replaced goes to `earlier`. Findings that did not change are the same objects. */
export function keepEarlier(before: Finding[], after: Finding[]): Finding[] {
  const old = new Map(before.map((f) => [f.fingerprint, f]));
  return after.map((f) => {
    const was = old.get(f.fingerprint)?.report;
    if (!was || (f.report && key(f.report.repo, f.report.issue) === key(was.repo, was.issue))) return f;
    const earlier = f.earlier ?? [];
    if (earlier.some((e) => key(e.repo, e.issue) === key(was.repo, was.issue))) return f;
    return { ...f, earlier: [...earlier, { repo: was.repo, issue: was.issue }].slice(-MAX_EARLIER) };
  });
}

/** Takes one reason out of the findings' `skipped` lists, so it is written to the log again. */
export function forgetSkip(findings: Finding[], reason: string): Finding[] {
  return findings.map((f) => {
    if (!f.skipped?.includes(reason)) return f;
    const { skipped, ...rest } = f;
    const left = skipped.filter((r) => r !== reason);
    return left.length ? { ...rest, skipped: left } : rest;
  });
}

/** A run that ended as failed and counts (an interrupted run, stopped, waiting and cancelled ones do not). */
const failedRun = (b: RunBrief): b is RunBrief & { finishedAt: string } => b.status === "failed" && !b.interrupted && !!b.finishedAt && !Number.isNaN(Date.parse(b.finishedAt));

export interface FixFailure { finding: Finding; repo?: string; issue: number; count: number }

/** A failed run of a bug story counts as "the fix failed" for its finding: each failed finish counts once. */
export function failedFixes(findings: Finding[], storyRuns: RunBrief[]): { findings: Finding[]; failed: FixFailure[] } {
  const failed: FixFailure[] = [];
  const out = findings.map((f) => {
    const mine = new Set([...(f.report ? [key(f.report.repo, f.report.issue)] : []), ...(f.earlier ?? []).map((e) => key(e.repo, e.issue))]);
    const since = f.fixFailed ? Date.parse(f.fixFailed.at) : -Infinity;
    const runs = storyRuns.filter((b) => failedRun(b) && isStoryRun(b, mine) && Date.parse(b.finishedAt) > since);
    if (!runs.length) return f;
    const newest = runs.reduce((a, b) => (Date.parse(b.finishedAt!) > Date.parse(a.finishedAt!) ? b : a));
    const next = { ...f, fixFailed: { count: (f.fixFailed?.count ?? 0) + runs.length, at: newest.finishedAt! } };
    failed.push({ finding: next, repo: newest.githubRepo, issue: Number(newest.issue), count: next.fixFailed.count });
    return next;
  });
  return { findings: out, failed };
}

export interface BreakerInput {
  findings: Finding[];
  storyRuns: RunBrief[];
  config: MonitorConfig["breaker"];
  now: Date;
  /** When the breaker was last switched on: nothing from before counts. */
  from?: string;
}

/** Should the breaker open? Too many new findings within the hour, or the newest finished story runs all failed. */
export function decideBreaker(i: BreakerInput): BreakerWhy | undefined {
  const from = i.from ? Date.parse(i.from) : -Infinity;
  const t = i.now.getTime();
  const fresh = i.findings.filter((f) => !f.quietStart && Date.parse(f.firstSeen) > from && Date.parse(f.firstSeen) >= t - i.config.within_minutes * 60_000);
  if (fresh.length > i.config.new_findings) return { reason: "findings", count: fresh.length, minutes: i.config.within_minutes };
  // A cancelled, stopped or interrupted run neither counts nor resets: only runs that really ended well or badly.
  const done = i.storyRuns
    .filter((b) => b.finishedAt && Date.parse(b.finishedAt) > from && (b.status === "succeeded" || failedRun(b)))
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))
    .slice(0, i.config.failed_fixes);
  if (done.length >= i.config.failed_fixes && done.every((b) => b.status === "failed")) return { reason: "failed_fixes", count: i.config.failed_fixes };
  return undefined;
}
