import type { RunSummary } from "./engine/state.js";

export interface Stats {
  totals: { runs: number; costUsd: number; succeeded: number; failed: number; stopped: number; waiting: number };
  byDay: { day: string; costUsd: number; runs: number }[];
  byFlow: { flow: string; runs: number; succeeded: number; costUsd: number; avgMinutes: number }[];
  byRepo: { repo: string; runs: number; costUsd: number }[];
  failingSteps: { step: string; failures: number; runs: number }[];
  loops: { step: string; extraVisits: number }[];
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Aggregate run history for the dashboard. */
export function computeStats(runs: RunSummary[], days = 30, now = new Date()): Stats {
  const since = new Date(now.getTime() - (days - 1) * 86_400_000);
  since.setHours(0, 0, 0, 0);
  const inRange = runs.filter((r) => new Date(r.startedAt) >= since);

  const byDay = new Map<string, { costUsd: number; runs: number }>();
  for (let i = 0; i < days; i++) byDay.set(dayKey(new Date(since.getTime() + i * 86_400_000)), { costUsd: 0, runs: 0 });
  const byFlow = new Map<string, { runs: number; succeeded: number; costUsd: number; minutes: number; finished: number }>();
  const byRepo = new Map<string, { runs: number; costUsd: number }>();
  const stepFail = new Map<string, { failures: number; runs: Set<string> }>();
  const loops = new Map<string, number>();
  const totals = { runs: 0, costUsd: 0, succeeded: 0, failed: 0, stopped: 0, waiting: 0 };

  for (const r of inRange) {
    totals.runs++;
    totals.costUsd += r.totalCostUsd;
    if (r.status in totals) (totals as Record<string, number>)[r.status]! += 1;
    const d = byDay.get(dayKey(new Date(r.startedAt)));
    if (d) {
      d.costUsd += r.totalCostUsd;
      d.runs++;
    }
    const f = byFlow.get(r.flow) ?? { runs: 0, succeeded: 0, costUsd: 0, minutes: 0, finished: 0 };
    f.runs++;
    f.costUsd += r.totalCostUsd;
    if (r.status === "succeeded") f.succeeded++;
    if (r.finishedAt) {
      f.finished++;
      f.minutes += (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 60_000;
    }
    byFlow.set(r.flow, f);
    const repoKey = r.vars?.github_repo && r.vars.github_repo !== "owner/repo" ? r.vars.github_repo : r.repo;
    const rp = byRepo.get(repoKey) ?? { runs: 0, costUsd: 0 };
    rp.runs++;
    rp.costUsd += r.totalCostUsd;
    byRepo.set(repoKey, rp);
    for (const h of r.history) {
      const key = `${r.flow} · ${h.id}`;
      if (!h.ok) {
        const s = stepFail.get(key) ?? { failures: 0, runs: new Set<string>() };
        s.failures++;
        s.runs.add(r.runId);
        stepFail.set(key, s);
      }
      if (h.visit > 1) loops.set(key, (loops.get(key) ?? 0) + 1);
    }
  }

  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    totals: { ...totals, costUsd: round(totals.costUsd) },
    byDay: [...byDay].map(([day, v]) => ({ day, costUsd: round(v.costUsd), runs: v.runs })),
    byFlow: [...byFlow]
      .map(([flow, v]) => ({ flow, runs: v.runs, succeeded: v.succeeded, costUsd: round(v.costUsd), avgMinutes: v.finished ? Math.round((v.minutes / v.finished) * 10) / 10 : 0 }))
      .sort((a, b) => b.runs - a.runs),
    byRepo: [...byRepo].map(([repo, v]) => ({ repo, runs: v.runs, costUsd: round(v.costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
    failingSteps: [...stepFail].map(([step, v]) => ({ step, failures: v.failures, runs: v.runs.size })).sort((a, b) => b.failures - a.failures).slice(0, 10),
    loops: [...loops].map(([step, extraVisits]) => ({ step, extraVisits })).sort((a, b) => b.extraVisits - a.extraVisits).slice(0, 10),
  };
}
