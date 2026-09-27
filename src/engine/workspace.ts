import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  workdir: string;
  branch?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function repoRoot(dir: string): string | undefined {
  try {
    return git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

export function prepareWorkspace(
  mode: "worktree" | "inplace" | "empty",
  repo: string,
  runDir: string,
  runId: string,
): Workspace {
  if (mode === "inplace") return { workdir: repo };
  if (mode === "empty") {
    const workdir = join(runDir, "workspace");
    mkdirSync(workdir, { recursive: true });
    return { workdir };
  }

  const root = repoRoot(repo);
  if (!root) throw new Error(`workspace "worktree" needs a git repository, but ${repo} is not one`);
  try {
    git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error(`workspace "worktree" needs at least one commit in ${root}`);
  }
  const branch = `factory/${runId}`;
  const workdir = join(runDir, "workspace");
  git(root, ["worktree", "add", "-b", branch, workdir, "HEAD"]);
  return { workdir, branch };
}
