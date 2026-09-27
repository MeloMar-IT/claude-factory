import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunSummary } from "./state.js";

const MAX_DIFF = 2_000_000;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 50_000_000, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
}

/** Where the run's changes start: recorded base, else merge-base with the remote default branch. */
function baseOf(s: RunSummary, cwd: string): string | undefined {
  if (s.baseSha) return s.baseSha;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    try {
      return git(cwd, ["merge-base", "HEAD", ref]).trim();
    } catch {
      // try the next ref
    }
  }
  return undefined;
}

/**
 * Everything the run changed: commits since the base plus uncommitted and new files.
 * Uses a throwaway index so the run's real index is untouched.
 */
export function runDiff(s: RunSummary): { base?: string; stat: string; patch: string; truncated: boolean } {
  const cwd = s.workdir;
  if (!cwd || !existsSync(join(cwd, ".git"))) return { stat: "", patch: "", truncated: false };
  const base = baseOf(s, cwd);
  if (!base) return { stat: "", patch: "", truncated: false };
  const tmp = mkdtempSync(join(tmpdir(), "factory-diff-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    git(cwd, ["read-tree", "HEAD"], env);
    git(cwd, ["add", "-A"], env);
    const stat = git(cwd, ["diff", "--cached", "--stat", base], env);
    let patch = git(cwd, ["diff", "--cached", "--no-color", base], env);
    const truncated = patch.length > MAX_DIFF;
    if (truncated) patch = patch.slice(0, MAX_DIFF);
    return { base, stat, patch, truncated };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
