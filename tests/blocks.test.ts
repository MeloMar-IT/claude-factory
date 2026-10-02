import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { readdirSync, readFileSync } from "node:fs";
import { learningsFile, resumeRun, runFlow } from "../src/engine/runner.js";
import { listBlocks, parseBlock } from "../src/flow/blocks.js";
import { loadFlow, parseFlow } from "../src/flow/load.js";
import { commentFirst, commentText, nextStepEnv } from "../src/next-step.js";
import { closing, fakeGithub, first, flowPath } from "./helpers/fake-github.js";

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

describe("comment wording comes from the next-step module", () => {
  const files = [
    ...readdirSync("blocks").filter((f) => f.endsWith(".yaml")).map((f) => join("blocks", f)),
    ...readdirSync("flows").filter((f) => f.endsWith(".yaml")).map((f) => join("flows", f)),
    ...readdirSync("tests/fixtures/flows").filter((f) => f.endsWith(".yaml")).map((f) => join("tests/fixtures/flows", f)),
    "tools/post-questions",
  ];
  const text = (f: string) => readFileSync(f, "utf8");

  it("has no own 'Reply …' wording any more", () => {
    const old = [
      "continues once you answer", "and it plans again", "to go with the recommendations",
      "to start coding (optionally with notes)", "and the Foundry creates these issues", "to continue or **/reject** to stop",
    ];
    for (const f of files) {
      expect(text(f), f).not.toMatch(/\bReply\b/);
      for (const o of old) expect(text(f), `${f}: ${o}`).not.toContain(o);
    }
  });

  it("only uses variables the engine sets", () => {
    const known = Object.keys(nextStepEnv());
    for (const f of files) for (const m of text(f).matchAll(/FACTORY_(?:NEXT|FIRST)_[A-Z]+(?:_[A-Z]+)*/g)) expect(known, `${f}: ${m[0]}`).toContain(m[0]);
  });

  it("have no first-line wording of their own", () => {
    for (const f of files) expect(text(f), f).not.toMatch(/What you need to do|Nothing needed from you/);
  });

  const stepRun = (file: string, id: string) => {
    const def = parseYaml(readFileSync(file, "utf8")) as { steps: { id: string; run?: string }[] };
    const step = def.steps.find((s) => s.id === id);
    expect(step, `${file}#${id}`).toBeDefined();
    return step!.run ?? "";
  };
  it("uses the right variable in the right step", () => {
    expect(stepRun("blocks/plan.yaml", "ask_for_info")).toContain("${FACTORY_NEXT_PLANNER_QUESTIONS}");
    expect(stepRun("blocks/request-approval.yaml", "request_approval")).toContain("${FACTORY_NEXT_APPROVAL}");
    for (const f of ["issue-plan", "issue-deliver", "issue-gitflow"]) expect(stepRun(flowPath(f), "send_back")).toContain("${FACTORY_NEXT_PLANNER_QUESTIONS}");
    for (const f of ["issue-deliver", "issue-gitflow"]) {
      expect(stepRun(flowPath(f), "risk_gate")).toContain("${FACTORY_NEXT_APPROVE_PLAN}");
      expect(stepRun(flowPath(f), "split_gate")).toContain("${FACTORY_NEXT_APPROVE_SPLIT}");
    }
    expect(text("tools/post-questions")).toContain("FACTORY_NEXT_QUESTIONS");
  });

  it("are described in the guides", () => {
    expect(text("docs/USER_GUIDE.md")).toContain(commentFirst("approve_plan"));
    expect(text("docs/USER_GUIDE.md")).toContain(nextStepEnv().FACTORY_FIRST_NOTHING);
    expect(text("docs/FLOW_AUTHORING.md")).toContain("FACTORY_FIRST_");
  });

  it("print the first line before anything else", () => {
    const before = (run: string, echo: string, label: string) => {
      const at = run.indexOf(echo);
      const mark = run.search(/🤖|✋/);
      expect(at, `${label}: ${echo}`).toBeGreaterThanOrEqual(0);
      expect(at, label).toBeLessThan(mark);
    };
    before(stepRun("blocks/plan.yaml", "ask_for_info"), 'echo "$FACTORY_FIRST_PLANNER_QUESTIONS"', "plan/ask_for_info");
    before(stepRun("blocks/request-approval.yaml", "request_approval"), 'echo "$FACTORY_FIRST_APPROVAL"', "request-approval");
    for (const f of ["github-issue", "github-pr", "github-auto"]) before(stepRun(flowPath(f), "ask_for_info"), 'echo "$FACTORY_FIRST_PLANNER_QUESTIONS"', f);
    before(stepRun(flowPath("github-pr"), "request_approval"), 'echo "$FACTORY_FIRST_APPROVAL"', "github-pr/request_approval");
    for (const f of ["issue-plan", "issue-deliver", "issue-gitflow"]) before(stepRun(flowPath(f), "send_back"), 'echo "$FACTORY_FIRST_PLANNER_QUESTIONS"', `${f}/send_back`);
    for (const f of ["issue-deliver", "issue-gitflow"]) {
      before(stepRun(flowPath(f), "split_gate"), 'echo "$FACTORY_FIRST_APPROVE_SPLIT"', `${f}/split_gate`);
      const gate = stepRun(flowPath(f), "risk_gate");
      before(gate, 'echo "$first"', `${f}/risk_gate`);
      expect(gate).toContain('first="$FACTORY_FIRST_APPROVE_PLAN"');
      expect(gate).toContain('first="$FACTORY_FIRST_NOTHING"');
    }
    expect(text("tools/post-questions")).toMatch(/const comment = \[\s*\.\.\.\(first \? \[first, ""\]/);
    expect(text("tools/post-questions")).toContain("FACTORY_FIRST_QUESTIONS");
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
    const body = gh.remoteGit("log", "-1", "--format=%B", branches.match(/factory\/\S+/)![0]);
    expect(body).toContain(`Automated by Spaghetti Code Foundry (run ${s.runId})`);
    expect(body).not.toContain("claude-factory");
  });

  it("asks for more info on the ticket and stops when the plan is unclear", async () => {
    process.env.FAKE_PLAN = "Which database should be used?\nPLAN_STATUS: NEEDS_INFO";
    const s = await run();
    expect(s.status).toBe("stopped");
    expect(s.history.map((h) => h.id)).toEqual(["check_repo", "pull_ticket", "pull_repo", "plan", "ask_for_info"]);
    const log = ghLog();
    expect(log).toContain("🤖 **Spaghetti Code Foundry** needs more information before it can work on this ticket:");
    const c = gh.comments().at(-1)!;
    expect(c.body.split("\n").slice(0, 3)).toEqual([commentFirst("planner_questions"), "", "🤖 **Spaghetti Code Foundry** needs more information before it can work on this ticket:"]);
    expect(closing(c.body)).toEqual([`_${commentText("planner_questions")}_`, `<!-- claude-factory run=${s.runId} -->`]);
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
    const approval = gh.comments().at(-1)!.body;
    expect(first(approval)).toBe(commentFirst("approval"));
    expect(approval.split("\n").filter((l) => l.trim())[1]).toMatch(/^✋ \*\*Spaghetti Code Foundry is ready to push\*\* branch/);
    expect(closing(gh.comments().at(-1)!.body)).toEqual([`_${commentText("approval")}_`, `<!-- claude-factory run=${s.runId} approval -->`]);
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
    expect(gh.remoteGit("log", "-1", "--format=%b", branch).trim()).toBe(`Automated by Spaghetti Code Foundry (run ${r.runId})`);
    expect(readFileSync(learningsFile({ github_repo: "acme/app" }, ""), "utf8")).toContain("CI runs tests that expect 2");
  });
});

describe("generated ticket flows", () => {
  const flows = ["github-issue", "github-pr", "github-auto"];
  const text = (f: string) => readFileSync(flowPath(f), "utf8");

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

  it("commit messages and Jira/Linear comments say the new name", () => {
    const all = ["chore", "ci-fix", "github-issue", "github-pr", "github-auto", "jira-ticket", "linear-ticket", "cross-review"];
    for (const f of all) {
      expect(text(f), f).not.toMatch(/Automated by claude-factory|claude-factory plan:|claude-factory finished|\(claude-factory run/);
    }
    expect(text("cross-review")).toContain('-m "factory: $(printf');
    expect(text("cross-review")).toContain("reviewed by Codex (Spaghetti Code Foundry run $FACTORY_RUN_ID)");
  });

  it("match the blocks they are built from", () => {
    const pairs: [string, string, string[]][] = [
      ["plan", "ask_for_info", flows],
      ["push-plan", "push_plan", flows],
      ["push-result", "push_result", flows],
      ["request-approval", "request_approval", ["github-pr"]],
      ["triage", "split_ticket", ["github-auto"]],
      ["commit", "commit", ["github-issue", "github-pr", "github-auto", "chore", "ci-fix", "jira-ticket", "linear-ticket"]],
      ["ci", "push_ci_fix", ["github-pr", "github-auto", "chore", "ci-fix"]],
      ["jira-push-plan", "jira_push_plan", ["jira-ticket"]],
      ["jira-push-result", "jira_push_result", ["jira-ticket"]],
      ["linear-push-plan", "linear_push_plan", ["linear-ticket"]],
      ["linear-push-result", "linear_push_result", ["linear-ticket"]],
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
