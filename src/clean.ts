import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { listRunIds, loadRun, type RunSummary } from "./engine/state.js";

export interface CleanOptions {
  runsDir: string;
  /** Only runs that finished at least this many days ago. */
  olderThanDays: number;
  /** Also delete run.json and logs (default: only workspaces). */
  purge?: boolean;
  /** Also clean stopped / waiting / interrupted runs (they can no longer be resumed). */
  includePaused?: boolean;
  dryRun?: boolean;
  isActive?: (runId: string) => boolean;
}

export interface CleanResult {
  workspaces: string[];
  runs: string[];
  freedMb: number;
  kept: { runId: string; why: string }[];
}

const PAUSED: RunSummary["status"][] = ["stopped", "waiting", "running"];

function sizeMb(path: string): number {
  try {
    return Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]) / 1024;
  } catch {
    return 0;
  }
}

/** Remove a run's workspace; worktrees are unregistered from their repo (the branch is kept). */
function removeWorkspace(s: RunSummary) {
  const wd = s.workdir!;
  if (s.branch && s.repo && existsSync(s.repo)) {
    try {
      execFileSync("git", ["-C", s.repo, "worktree", "remove", "--force", wd], { stdio: "ignore" });
    } catch {
      // not registered anymore — fall through to a plain delete
    }
  }
  rmSync(wd, { recursive: true, force: true });
  if (s.branch && s.repo && existsSync(s.repo)) {
    try {
      execFileSync("git", ["-C", s.repo, "worktree", "prune"], { stdio: "ignore" });
    } catch {
      // repo gone or not a git repo
    }
  }
}

/**
 * Free disk space from old runs. Workspaces inside the run dir (worktrees and clones)
 * are removed; in-place runs never touch the repo. Branches are kept.
 */
export function cleanRuns(o: CleanOptions): CleanResult {
  const cutoff = Date.now() - o.olderThanDays * 86_400_000;
  const res: CleanResult = { workspaces: [], runs: [], freedMb: 0, kept: [] };
  for (const id of listRunIds(o.runsDir)) {
    const s = loadRun(o.runsDir, id);
    if (!s) continue;
    const when = new Date(s.finishedAt ?? s.startedAt).getTime();
    if (when > cutoff) continue;
    if (o.isActive?.(id)) {
      res.kept.push({ runId: id, why: "running" });
      continue;
    }
    if (PAUSED.includes(s.status) && !o.includePaused) {
      res.kept.push({ runId: id, why: `${s.status} (can be resumed)` });
      continue;
    }
    const ownWorkspace = !!s.workdir && s.workdir.startsWith(s.runDir) && existsSync(s.workdir);
    if (o.purge) {
      res.freedMb += sizeMb(s.runDir);
      res.runs.push(id);
      if (!o.dryRun) {
        if (ownWorkspace) removeWorkspace(s);
        rmSync(s.runDir, { recursive: true, force: true });
      }
    } else if (ownWorkspace) {
      res.freedMb += sizeMb(s.workdir!);
      res.workspaces.push(s.workdir!);
      if (!o.dryRun) removeWorkspace(s);
    }
  }
  res.freedMb = Math.round(res.freedMb * 10) / 10;
  return res;
}
