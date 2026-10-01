import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { nextStep } from "../src/next-step.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { minutesNow, Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// The label-driven pipeline: issue-plan → issue-code-daily → daily-pr, as configured for a real repo.
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const today = minutesNow("Europe/Berlin").day;
const VARS = { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", forbidden_paths: "connector-geni/", docs_required: "docs/CHANGELOG.md" };

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
});

describe("label-driven issue pipeline", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of ["FAKE_IMPL_BUG", "FAKE_FIX_NOOP", "FAKE_CODEX_VERDICT", "FAKE_ISSUE_PLAN", "FAKE_REVISE", "FAKE_REVISE_COST"]) delete process.env[k];
  });
  afterEach(() => gh.restore());

  const planWatcher = () => new Watcher(WatcherSchema.parse({
    id: "plan", github_repo: REPO, label: "Factory_ready", flow: "issue-plan", exclude_labels: ["geni"],
    status_labels: { ...LABELS, working: "Factory_planning", done: "Factory_planned" }, remove_on_done: ["Factory_ready"], vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const codeWatcher = () => new Watcher(WatcherSchema.parse({
    id: "code", github_repo: REPO, label: "Factory_code", flow: "issue-code-daily", exclude_labels: ["geni"],
    status_labels: LABELS, remove_on_done: ["Factory_code", "Factory_planned"], pause_while_pr_open: "factory/daily-", one_at_a_time: true, vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const issues = (...list: [number, string[]][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, labels]) => ({ number, title: `issue ${number}`, labels: labels.map((name) => ({ name })) })));
  };
  const settle = async () => {
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  };
  const runOf = (flow: string, issue: string) => scheduler.list().find((s) => s.flow === flow && s.vars.issue === issue);
  const prs = () => JSON.parse(readFileSync(`${join(gh.tmp, "gh.log")}.prs.json`, "utf8")) as { number: number; headRefName: string; state: string }[];
  const mergePr = (branch: string) => {
    writeFileSync(`${join(gh.tmp, "gh.log")}.prs.json`, JSON.stringify(prs().map((p) => (p.headRefName === branch ? { ...p, state: "MERGED" } : p))));
    gh.remoteGit("update-ref", "refs/heads/main", `refs/heads/${branch}`);
  };

  it("plans Factory_ready issues (never geni ones) and swaps the labels", async () => {
    issues([5, ["Factory_ready"]], [8, ["Factory_ready", "geni"]]);
    const w = planWatcher();
    await w.tick();
    await settle();
    expect(w.status.lastError).toBeUndefined();
    expect(runOf("issue-plan", "5")?.status).toBe("succeeded");
    expect(runOf("issue-plan", "8")).toBeUndefined();
    const log = gh.ghLog();
    expect(log).toContain("Spaghetti Code Foundry plan**");
    expect(log).toContain("Add the `Factory_code` label to start coding");
    expect(log).toMatch(/gh issue edit 5 .*--remove-label Factory_ready.*--add-label Factory_planned/);
    expect(log).not.toMatch(/issue edit 8 /);
  });

  it("revises the plan when Codex finds problems, and posts the revised plan", async () => {
    process.env.FAKE_CODEX_VERDICT = "The plan misses an edge case.\nVERDICT: CHANGES";
    issues([5, ["Factory_ready"]]);
    await planWatcher().tick();
    await settle();
    const run = runOf("issue-plan", "5")!;
    expect(run.history.map((h) => h.id)).toEqual(["pull_ticket", "clone", "plan", "plan_review", "revise_plan", "post_plan"]);
    expect(run.history.find((h) => h.id === "plan")!.agent).toBe("claude:anthropic:claude-opus-5-5");
    expect(run.history.find((h) => h.id === "plan_review")!.agent).toBe("codex:openai");
    // The revision is a fresh, targeted session (cheaper than replaying the planning session).
    expect(run.history.find((h) => h.id === "revise_plan")!.sessionId).not.toBe(run.history.find((h) => h.id === "plan")!.sessionId);
    const log = gh.ghLog();
    expect(log).toContain("Spaghetti Code Foundry plan** (checked against the code by Codex)");
    expect(log).toContain("Add feature.txt (revised)");
  });

  it("posts the draft with Codex's notes when the revision uses up the budget", async () => {
    process.env.FAKE_CODEX_VERDICT = "The plan misses an edge case.\nVERDICT: CHANGES";
    process.env.FAKE_REVISE_COST = "50";
    process.env.FAKE_REVISE = "half a plan";
    issues([5, ["Factory_ready"]]);
    await planWatcher().tick();
    await settle();
    const run = runOf("issue-plan", "5")!;
    expect(run.history.map((h) => h.id)).toEqual(["pull_ticket", "clone", "plan", "plan_review", "revise_plan", "post_plan"]);
    expect(run.status).toBe("succeeded");
    const log = gh.ghLog();
    expect(log).toContain("the revision did not finish");
    expect(log).toContain("## Goal\nAdd feature.txt\n");
    expect(log).toContain("## Codex review notes (not yet worked in)\n\nThe plan misses an edge case.");
    expect(log).not.toContain("half a plan");
  });

  it("waits to plan an issue until the story it depends on is done", async () => {
    const body = (dep: string) => `Do it.\n\n### Depends on\n${dep}\n\n### Notes\nnone`;
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "Story 4 — Download", state: "OPEN", labels: [{ name: "Factory_code" }], body: "" },
      { number: 5, title: "Story 5 — Verify", state: "OPEN", labels: [{ name: "Factory_ready" }], body: body("Story 4 — Download.") },
      { number: 6, title: "Story 6 — Install", state: "OPEN", labels: [{ name: "Factory_ready" }], body: body("#3") },
    ]);
    const w = new Watcher(WatcherSchema.parse({
      id: "plan", github_repo: REPO, label: "Factory_ready", flow: "issue-plan", max_per_tick: 5,
      status_labels: { ...LABELS, working: "Factory_planning", done: "Factory_planned" }, dependency_done_labels: ["Factory_done"], vars: VARS,
    }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
    await w.tick();
    await settle();
    expect(runOf("issue-plan", "5")).toBeUndefined();
    expect(w.status.lastActions.join("\n")).toContain("#5 waits for #4");
    expect(w.status.holds).toMatchObject([{ issue: 5, title: "Story 5 — Verify", next: { kind: "dependency", who: "Another story", until: "after #4" } }]);
    expect(w.status.holds![0]!.reason).toContain("waits for #4");
    expect(runOf("issue-plan", "6")?.status).toBe("succeeded"); // #3 is not a known issue: not blocking
    // Story 4 is coded (Factory_done, not merged yet): now Story 5 can be planned.
    process.env.FAKE_GH_ISSUES = process.env.FAKE_GH_ISSUES.replace('"Factory_code"', '"Factory_done"');
    await w.tick();
    await settle();
    expect(runOf("issue-plan", "5")?.status).toBe("succeeded");
  });

  it("sends non-code issues back with the reason and stops", async () => {
    process.env.FAKE_ISSUE_PLAN = "This is a legal approval task.\nPLAN_STATUS: NOT_CODE";
    issues([1, ["Factory_ready"]]);
    await planWatcher().tick();
    await settle();
    expect(runOf("issue-plan", "1")?.status).toBe("stopped");
    expect(gh.ghLog()).toContain("thinks this issue is not a coding task");
    expect(gh.ghLog()).toMatch(/issue edit 1 .*--add-label Factory_needs_info/);
  });

  it("codes on today's branch: tests, two Codex reviews, docs, commit, push, report", async () => {
    process.env.FAKE_CODEX_VERDICT = "Rename x.\nVERDICT: CHANGES";
    issues([5, ["Factory_code", "Factory_planned"]]);
    const w = codeWatcher();
    await w.tick();
    await settle();
    const run = runOf("issue-code-daily", "5")!;
    expect(run.reason).toBeUndefined();
    expect(run.status).toBe("succeeded");
    const ids = run.history.map((h) => h.id);
    expect(ids).toEqual(["pull_ticket", "daily_branch", "baseline_tests", "implement", "guard", "run_tests", "review_1", "address_review_1",
      "run_tests_1", "review_2", "address_review_2", "run_tests_2", "docs", "final_guard", "commit", "push", "report"]);
    expect(run.history.find((h) => h.id === "review_1")!.agent).toBe("codex:openai");
    expect(run.history.find((h) => h.id === "implement")!.agent).toBe("claude:anthropic:claude-sonnet-5-5");
    // Review fixes and docs continue the coding session instead of re-reading the code.
    const sess = run.history.find((h) => h.id === "implement")!.sessionId;
    expect(["address_review_1", "address_review_2", "docs"].map((id) => run.history.find((h) => h.id === id)!.sessionId)).toEqual([sess, sess, sess]);

    const branch = `factory/daily-${today}`;
    expect(gh.remoteGit("log", "--format=%s", "-1", branch).trim()).toBe("Resolve #5: Add a feature");
    expect(gh.remoteGit("show", `${branch}:docs/CHANGELOG.md`)).toContain("feature.txt");
    const log = gh.ghLog();
    expect(log).toContain(`implemented this on branch \`${branch}\``);
    expect(log).toContain("- round 2: CHANGES");
    expect(log).toContain("result: PASSED");
    expect(log).toMatch(/gh issue edit 5 .*--remove-label Factory_code --remove-label Factory_planned --add-label Factory_done/);
  });

  it("gives up after 3 fix rounds: Factory_ERROR plus the failing output on the issue", async () => {
    process.env.FAKE_IMPL_BUG = "1";
    process.env.FAKE_FIX_NOOP = "1";
    issues([6, ["Factory_code"]]);
    await codeWatcher().tick();
    await settle();
    const run = runOf("issue-code-daily", "6")!;
    expect(run.status).toBe("failed");
    expect(run.history.filter((h) => h.id === "fix_tests")).toHaveLength(3);
    const log = gh.ghLog();
    expect(log).toMatch(/issue edit 6 .*--add-label Factory_ERROR/);
    expect(log).toContain("🤖 **Spaghetti Code Foundry** could not finish this issue");
    expect(log).not.toContain("**claude-factory** could not finish");
    expect(log).toMatch(new RegExp(`could not finish this issue[\\s\\S]*<!-- claude-factory run=${run.runId} -->`));
    expect(log).toContain("to start over, or resume the run");
    expect(log).toContain(nextStep("failed", {}, { watched: true, failedLabel: "Factory_ERROR", reason: run.reason }).text);
    expect(log).toContain("Last failing step: `run_tests` (attempt 4)");
    expect(log).toContain("result: FAILED");
    expect(gh.remoteGit("branch", "--list", "factory/*").trim()).toBe(""); // nothing was pushed
  });

  it("refuses changes in forbidden paths", async () => {
    const flow = loadFlow("issue-code-daily", gh.tmp).flow;
    const guard = flow.steps.find((s) => s.id === "guard")!;
    expect(guard.type === "shell" && guard.run).toContain("FACTORY_VAR_FORBIDDEN_PATHS");
    const out = spawnSync("sh", ["-c", (guard as { run: string }).run], {
      cwd: (() => {
        const d = join(gh.tmp, "g");
        execFileSync("git", ["clone", "-q", gh.remote, d]);
        execFileSync("mkdir", ["-p", join(d, "connector-geni")]);
        writeFileSync(join(d, "connector-geni", "X.kt"), "class X\n");
        return d;
      })(),
      env: { ...process.env, FACTORY_VAR_FORBIDDEN_PATHS: "connector-geni/" },
      encoding: "utf8",
    });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("changes in forbidden path connector-geni/");
  });

  it("opens the daily PR, pauses coding until it is merged, then starts a new branch", async () => {
    issues([5, ["Factory_code"]]);
    await codeWatcher().tick();
    await settle();

    // 17:00: the daily PR lists the issue and the checks.
    const pr = await runFlow(loadFlow("daily-pr", gh.tmp).flow, { task: "daily PR", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: VARS.test_cmd } });
    expect(pr.status).toBe("succeeded");
    const body = gh.ghLog().split("--- pr body:").pop()!;
    expect(body).toContain("- #5 Add a feature");
    expect(body).toContain("Closes #5");
    expect(body).toContain("### Checks on this branch");
    expect(prs()).toMatchObject([{ headRefName: `factory/daily-${today}`, state: "OPEN" }]);

    // Nothing new starts while it is open …
    issues([7, ["Factory_code"]]);
    const w = codeWatcher();
    await w.tick();
    await settle();
    expect(runOf("issue-code-daily", "7")).toBeUndefined();
    expect(w.status.lastActions[0]).toContain("not starting new work while PR #99");
    expect(w.status.holds).toMatchObject([{ issue: 7, next: { kind: "release", action: "Merge the daily pull request #99" } }]);
    expect(w.status.holds).toHaveLength(1);

    // … and after the merge, work continues on a fresh branch for today.
    mergePr(`factory/daily-${today}`);
    await w.tick();
    await settle();
    expect(runOf("issue-code-daily", "7")?.status).toBe("succeeded");
    expect(gh.remoteGit("log", "--format=%s", "-1", `factory/daily-${today}-2`).trim()).toBe("Resolve #7: Add a feature");

    // With nothing new to send, the daily PR flow ends quietly.
    mergePr(`factory/daily-${today}-2`);
    const none = await runFlow(loadFlow("daily-pr", gh.tmp).flow, { task: "daily PR", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO } });
    expect(none.history.map((h) => h.id)).toEqual(["clone", "find_branch"]);
  });

  it("a run that finds an open daily PR waits, and resumes by itself after the merge", async () => {
    issues([5, ["Factory_code"]]);
    await codeWatcher().tick();
    await settle();
    await runFlow(loadFlow("daily-pr", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: "true" } });

    // Started directly (as if it slipped past the watcher's check).
    const flow = loadFlow("issue-code-daily", gh.tmp).flow;
    const waiting = await runFlow(flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { ...VARS, github_repo: REPO, issue: "9" } });
    expect(waiting.status).toBe("stopped");
    expect(waiting.reason).toContain('"wait_for_merge"');

    mergePr(`factory/daily-${today}`);
    issues([9, ["Factory_code", "Factory_working"]]);
    const w = codeWatcher();
    await w.tick();
    await settle();
    const resumed = runOf("issue-code-daily", "9")!;
    expect(resumed.runId).toBe(waiting.runId);
    expect(resumed.status).toBe("succeeded");
    expect(w.status.lastActions.join("\n")).toContain("can continue now");
  });

  it("runs a daily schedule once, after its time of day", async () => {
    const w = new Watcher(WatcherSchema.parse({
      id: "pr17", github_repo: REPO, source: "schedule", flow: "daily-pr", at: "00:00", timezone: "Europe/Berlin", task: "open the daily PR", vars: { test_cmd: "true" },
    }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
    await w.tick();
    await settle();
    await w.tick();
    await settle();
    expect(scheduler.list().filter((s) => s.flow === "daily-pr")).toHaveLength(1);
    expect(() => WatcherSchema.parse({ id: "x", github_repo: REPO, source: "schedule", task: "t", timezone: "Mars/Olympus" })).toThrow(/time zone/);
  });
});
