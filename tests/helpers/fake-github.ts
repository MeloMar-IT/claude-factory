import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  const bin = join(tmp, "bin");
  mkdirSync(bin);
  symlinkSync(resolve("tests/fixtures/fake-gh.sh"), join(bin, "gh"));
  const ghLog = join(tmp, "gh.log");
  writeFileSync(ghLog, "");
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
    /** Every comment the fake gh logged (up to its hidden marker). */
    comments: () =>
      [...readFileSync(ghLog, "utf8").matchAll(/^--- comment on #(\d+):\n([\s\S]*?<!-- claude-factory[^>]*-->)/gm)].map((m) => ({ issue: Number(m[1]), body: m[2]! })),
    remoteGit: (...a: string[]) => git(remote, ...a),
    restore: () => {
      process.env = { ...env };
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** The last two non-empty lines of a comment: its closing sentence and its hidden marker. */
export const closing = (body: string) => body.split("\n").filter((l) => l.trim()).slice(-2);
