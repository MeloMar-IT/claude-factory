import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { learningsFile, resumeRun, runFlow } from "../src/engine/runner.js";
import { listBlocks, parseBlock } from "../src/flow/blocks.js";
import { loadFlow, parseFlow } from "../src/flow/load.js";
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
    expect(log).toContain("🤖 **Spaghetti Code Foundry plan**");
    expect(log).toContain("✅ **Spaghetti Code Foundry finished this ticket**");
    expect(log).toContain(`<!-- claude-factory run=${s.runId} -->`);
    expect(log).not.toContain("**claude-factory");
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
    expect(log).toContain("🤖 **Spaghetti Code Foundry** needs more information before it can work on this ticket:");
    expect(log).toContain("_Reply on this issue; the Foundry continues once you answer._");
    expect(log).toContain(`<!-- claude-factory run=${s.runId} -->`);
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

describe("github-pr flow (fake gh + claude)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => gh.restore());

  it("waits for approval, then pushes, opens a PR, fixes CI, reports and learns", async () => {
    process.env.FAKE_GH_CI_FAILS = "1";
    const common = { runsDir: join(gh.tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs") };
    const s = await runFlow(loadFlow("github-pr", gh.tmp).flow, {
      ...common,
      task: "",
      repo: gh.tmp,
      vars: { github_repo: "acme/app", issue: "7", test_cmd: "test -f feature.txt", require_approval: "yes", ci_settle_sec: "0" },
    });
    expect(s.reason).toMatch(/Push the changes for acme\/app#7/);
    expect(s.status).toBe("waiting");
    expect(gh.ghLog()).toContain("Reply **/approve**");
    expect(gh.ghLog()).toContain("✋ **Spaghetti Code Foundry is ready to push** branch");
    expect(gh.ghLog()).toContain(`<!-- claude-factory run=${s.runId} approval -->`);
    expect(gh.remoteGit("branch", "--list")).not.toMatch(/factory\//); // nothing pushed yet

    const r = await resumeRun({ ...common, runId: s.runId, decision: { approved: true, by: "marcel" } });
    expect(r.reason).toBeUndefined();
    expect(r.status).toBe("succeeded");
    const ids = r.history.map((h) => h.id);
    expect(ids.slice(ids.indexOf("approve"))).toEqual([
      "approve", "push", "open_pr", "wait_ci", "fix_ci", "push_ci_fix", "wait_ci", "push_result", "learn", "save_learnings",
    ]);
    const log = gh.ghLog();
    expect(log).toContain("Closes #7");
    expect(log).toContain("✅ **Spaghetti Code Foundry finished this ticket**");
    expect(log).toContain("Pull request: https://github.com/owner/repo/pull/99");
    const branch = gh.remoteGit("branch", "--list").match(/factory\/\S+/)![0];
    expect(gh.remoteGit("log", "-2", "--format=%s", branch).trim().split("\n")).toEqual(["Fix CI", "Resolve #7"]);
    expect(readFileSync(learningsFile({ github_repo: "acme/app" }, ""), "utf8")).toContain("CI runs tests that expect 2");
  });
});

describe("generated ticket flows", () => {
  const flows = ["github-issue", "github-pr", "github-auto"];
  const text = (f: string) => readFileSync(`flows/${f}.yaml`, "utf8");

  it("say the new name and write the old marker only", () => {
    for (const f of flows) {
      const y = text(f);
      expect(y, f).not.toMatch(/(🤖|✅|✋) \*\*claude-factory/);
      expect(y, f).not.toContain("claude-factory continues");
      expect(y, f).not.toContain("<!-- spaghetti-code-foundry");
      expect(y, f).toContain("<!-- claude-factory run=$FACTORY_RUN_ID -->");
    }
    expect(text("github-pr")).toContain("<!-- claude-factory run=$FACTORY_RUN_ID approval -->");
    expect(text("github-auto")).toContain('label="claude-factory"');
    expect(text("github-auto")).toContain("They are labelled \\`claude-factory\\` and will be picked up automatically.");
  });

  it("match the blocks they are built from", () => {
    const pairs: [string, string, string[]][] = [
      ["plan", "ask_for_info", flows],
      ["push-plan", "push_plan", flows],
      ["push-result", "push_result", flows],
      ["request-approval", "request_approval", ["github-pr"]],
      ["triage", "split_ticket", ["github-auto"]],
    ];
    const runOf = (steps: { id: string }[], id: string) => (steps.find((s) => s.id === id) as { run?: string } | undefined)?.run;
    for (const [block, step, inFlows] of pairs) {
      const expected = runOf(parseBlock(readFileSync(`blocks/${block}.yaml`, "utf8")).steps, step);
      expect(expected, `${block}/${step}`).toBeTruthy();
      for (const f of inFlows) {
        expect(runOf(parseFlow(text(f), f).steps, step), `${f}/${step}`).toBe(expected);
      }
    }
  });
});

describe("pr-feedback flow (fake gh + claude)", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => (gh = fakeGithub()));
  afterEach(() => gh.restore());

  it("addresses review comments, pushes and replies on the PR", async () => {
    // Give the remote a PR branch to check out.
    execFileSync("git", ["-C", gh.remote, "branch", "factory/pr-17", "main"]);
    const s = await runFlow(loadFlow("pr-feedback", gh.tmp).flow, {
      task: "", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
      vars: { github_repo: "acme/app", pr: "17", test_cmd: "true" },
    });
    expect(s.reason).toBeUndefined();
    expect(s.status).toBe("succeeded");
    expect(gh.remoteGit("log", "-1", "--format=%s", "factory/pr-17").trim()).toBe("Address review comments");
    expect(gh.ghLog()).toContain("renamed the variable as requested");
  });
});
