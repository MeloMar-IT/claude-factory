import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFlow } from "../src/engine/runner.js";
import { listBlocks, parseBlock } from "../src/flow/blocks.js";
import { loadFlow } from "../src/flow/load.js";
import { fakeGithub } from "./helpers/fake-github.js";

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
  let gh: ReturnType<typeof fakeGithub>;
  let tmp: string;
  beforeEach(() => {
    gh = fakeGithub();
    tmp = gh.tmp;
  });
  afterEach(() => gh.restore());
  const ghLog = () => gh.ghLog();

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
    const log = ghLog();
    expect(log).toContain("claude-factory plan");
    expect(log).toContain("finished this ticket");
    expect(log).toContain("added feature.txt");
    const branches = gh.remoteGit("branch", "--list");
    expect(branches).toMatch(/factory\/issue-7-/);
    const msg = gh.remoteGit("log", "-1", "--format=%s", branches.match(/factory\/\S+/)![0]);
    expect(msg.trim()).toBe("Resolve #7");
  });

  it("asks for more info on the ticket and stops when the plan is unclear", async () => {
    process.env.FAKE_PLAN = "Which database should be used?\nPLAN_STATUS: NEEDS_INFO";
    const s = await run();
    expect(s.status).toBe("stopped");
    expect(s.history.map((h) => h.id)).toEqual(["check_repo", "pull_ticket", "pull_repo", "plan", "ask_for_info"]);
    const log = ghLog();
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
