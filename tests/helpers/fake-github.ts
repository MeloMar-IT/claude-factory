import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const claudeBin = resolve("tests/fixtures/fake-claude.mjs");

/**
 * A temp dir with a bare git remote (one commit on main) and a fake `gh` on PATH that
 * clones that remote and logs every call. Call restore() when done.
 */
export function fakeGithub() {
  const env = { ...process.env };
  const tmp = mkdtempSync(join(tmpdir(), "factory-gh-"));
  const seed = join(tmp, "seed");
  const remote = join(tmp, "remote.git");
  mkdirSync(seed);
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hi\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(tmp, "clone", "-q", "--bare", seed, remote);
  // A status comment has its marker on the last line; a comment that only quotes the marker is not one.
  const STATUS_END = /<!-- (?:claude-factory|spaghetti-code-foundry) status -->$/;
  const logged = () =>
    [...readFileSync(join(tmp, "gh.log"), "utf8").matchAll(/^--- comment on #(\d+):\n([\s\S]*?)\n--- end comment$/gm)].map((m) => ({ issue: Number(m[1]), body: m[2]!.trimEnd() }));

  // Retired flows (no longer shipped) are test material: make them repo flows of the test repository.
  const flowsDir = join(tmp, ".claude-factory", "flows");
  mkdirSync(flowsDir, { recursive: true });
  for (const f of readdirSync(resolve("tests/fixtures/flows"))) copyFileSync(resolve("tests/fixtures/flows", f), join(flowsDir, f));

  const bin = join(tmp, "bin");
  mkdirSync(bin);
  symlinkSync(resolve("tests/fixtures/fake-gh.sh"), join(bin, "gh"));
  const ghLog = join(tmp, "gh.log");
  writeFileSync(ghLog, "");
  // The status comments the Foundry remembers must not leak from one test into the next.
  rmSync(join(process.env.FACTORY_HOME ?? tmp, "status-comments.json"), { force: true });
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_GH_LOG: ghLog,
    FAKE_GH_REMOTE: remote,
    FAKE_GH_CI_SETTLE: "0",
    FACTORY_VAR_CI_SETTLE_SEC: "0",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  });

  return {
    tmp,
    remote,
    ghLog: () => readFileSync(ghLog, "utf8"),
    /** Every comment the fake gh logged (up to its hidden marker), the status comments left out. */
    comments: () => logged().filter((c) => !STATUS_END.test(c.body)),
    /** The status comments that were created. */
    statusComments: () => logged().filter((c) => STATUS_END.test(c.body)),
    /** The status comments that were edited (the id and the new text). */
    statusEdits: () =>
      [...readFileSync(ghLog, "utf8").matchAll(/^--- comment edit (\d+):\n([\s\S]*?<!-- claude-factory status -->)/gm)].map((m) => ({ id: m[1]!, body: m[2]! })),
    /** The ids of the comments that were deleted. */
    statusDeletes: () => [...readFileSync(ghLog, "utf8").matchAll(/^--- comment delete (\d+)$/gm)].map((m) => m[1]!),
    remoteGit: (...a: string[]) => git(remote, ...a),
    restore: () => {
      process.env = { ...env };
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** The last two non-empty lines of a comment: its closing sentence and its hidden marker. */
export const closing = (body: string) => body.split("\n").filter((l) => l.trim()).slice(-2);

/** The first non-empty line of a comment. */
export const first = (body: string) => body.split("\n").find((l) => l.trim()) ?? "";

/** A flow's file: shipped in flows/, or (retired, kept as test material) in tests/fixtures/flows/. */
export function flowPath(name: string): string {
  const shipped = join("flows", `${name}.yaml`);
  return existsSync(shipped) ? shipped : join("tests", "fixtures", "flows", `${name}.yaml`);
}

/** The flow each watcher source ran before the defaults changed (retired flows, kept for the tests). */
export const OLD_DEFAULT_FLOW: Record<string, string> = { issues: "github-issue", "pr-feedback": "pr-feedback", "ci-failures": "ci-fix", schedule: "chore" };
export const oldFlowFor = (over: { source?: string; flow?: string } = {}) => over.flow ?? OLD_DEFAULT_FLOW[over.source ?? "issues"]!;
