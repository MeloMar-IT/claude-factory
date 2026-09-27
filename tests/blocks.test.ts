import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFlow } from "../src/engine/runner.js";
import { listBlocks, parseBlock } from "../src/flow/blocks.js";
import { loadFlow } from "../src/flow/load.js";

describe("block library", () => {
  it("all built-in blocks are valid", () => {
    const blocks = listBlocks("/nonexistent").filter((b) => b.scope === "builtin");
    expect(blocks.length).toBeGreaterThanOrEqual(12);
    for (const b of blocks) expect(b.error, b.id).toBeUndefined();
  });

  it("rejects jumps out of the block", () => {
    const y = "name: x\nsteps:\n  - {id: a, type: shell, run: x, on_failure: elsewhere}";
    expect(() => parseBlock(y)).toThrow(/only jump to their own steps/);
    expect(parseBlock("name: x\nsteps:\n  - {id: a, type: shell, run: x, on_failure: stop}").category).toBe("Custom");
  });
});

describe("github-issue flow (fake gh + claude)", { timeout: 30_000 }, () => {
  let tmp: string;
  let ghLog: string;
  const env = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-gh-"));
    // A bare "GitHub" remote with one commit.
    const seed = join(tmp, "seed");
    const remote = join(tmp, "remote.git");
    mkdirSync(seed);
    const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
    git(seed, "init", "-q", "-b", "main");
    writeFileSync(join(seed, "README.md"), "hi\n");
    git(seed, "add", ".");
    git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git(tmp, "clone", "-q", "--bare", seed, remote);

    const bin = join(tmp, "bin");
    mkdirSync(bin);
    symlinkSync(resolve("tests/fixtures/fake-gh.sh"), join(bin, "gh"));
    ghLog = join(tmp, "gh.log");
    Object.assign(process.env, {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_REMOTE: remote,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    });
  });
  afterEach(() => {
    process.env = { ...env };
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = () =>
    runFlow(loadFlow("github-issue", tmp).flow, {
      task: "",
      repo: tmp,
      runsDir: join(tmp, "runs"),
      claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
      vars: { github_repo: "owner/repo", issue: "7", test_cmd: "test -f feature.txt" },
    });

  it("goes from ticket to pushed branch and reports on the ticket", async () => {
    const s = await run();
    expect(s.reason).toBeUndefined();
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual([
      "check_repo", "pull_ticket", "pull_repo", "plan", "push_plan", "implement",
      "run_tests", "review", "commit", "push", "push_result",
    ]);
    const log = readFileSync(ghLog, "utf8");
    expect(log).toContain("claude-factory plan");
    expect(log).toContain("finished this ticket");
    expect(log).toContain("added feature.txt");
    const branches = execFileSync("git", ["branch", "--list"], { cwd: join(tmp, "remote.git"), encoding: "utf8" });
    expect(branches).toMatch(/factory\/issue-7-/);
    const msg = execFileSync("git", ["log", "-1", "--format=%s", branches.match(/factory\/\S+/)![0]], { cwd: join(tmp, "remote.git"), encoding: "utf8" });
    expect(msg.trim()).toBe("Resolve #7");
  });

  it("asks for more info on the ticket and stops when the plan is unclear", async () => {
    process.env.FAKE_PLAN = "Which database should be used?\nPLAN_STATUS: NEEDS_INFO";
    const s = await run();
    expect(s.status).toBe("stopped");
    expect(s.history.map((h) => h.id)).toEqual(["check_repo", "pull_ticket", "pull_repo", "plan", "ask_for_info"]);
    const log = readFileSync(ghLog, "utf8");
    expect(log).toContain("needs more information");
    expect(log).toContain("Which database should be used?");
    expect(log).not.toContain("PLAN_STATUS");
  });

  it("rejects a non-numeric issue", async () => {
    const s = await runFlow(loadFlow("github-issue", tmp).flow, {
      task: "", repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
      vars: { github_repo: "owner/repo", issue: "7; rm -rf /" },
    });
    expect(s.status).toBe("failed");
    expect(s.history.at(-1)!.output).toContain("issue number");
  });
});
