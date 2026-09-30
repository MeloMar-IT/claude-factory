import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { buildStamp, RESTART_CODE, supervise } from "../src/supervise.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// The simpler pipeline: one label (Factory_go) → questions up front → plan + risk gate + code in one
// run → one rolling factory PR with a daily report.
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const VARS = { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", forbidden_paths: "connector-geni/", docs_required: "docs/CHANGELOG.md" };
const FAKES = ["FAKE_GH_CLOSED_ISSUES", "FAKE_GH_PARENT", "FAKE_RISK", "FAKE_CODEX_RISK", "FAKE_CODEX_VERDICT", "FAKE_GH_ISSUE_LABELS", "FAKE_QUESTIONS_FOR", "FAKE_GH_COMMENTS", "FAKE_GH_PERMISSION", "FAKE_ISSUE_PLAN"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
});

describe("deliver pipeline", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => gh.restore());

  const watcher = (extra: Record<string, unknown> = {}) => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-deliver", one_at_a_time: true,
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], vars: VARS, ...extra,
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

  it("plans and codes in one run, then opens the factory pull request", async () => {
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    await settle();
    const run = runOf("issue-deliver", "5")!;
    expect(run.reason).toBeUndefined();
    expect(run.status).toBe("succeeded");
    const ids = run.history.map((h) => h.id);
    expect(ids.slice(0, 7)).toEqual(["pull_ticket", "daily_branch", "baseline_tests", "plan", "plan_review", "risk_gate", "implement"]);
    expect(ids.slice(-4)).toEqual(["commit", "push", "open_pr", "report"]);
    expect(run.history.find((h) => h.id === "plan")!.agent).toBe("claude:anthropic:claude-opus-5-5");
    expect(run.history.find((h) => h.id === "implement")!.agent).toBe("claude:anthropic:claude-sonnet-5-5");
    const log = gh.ghLog();
    expect(log).toContain("**Risk: 20/100** — small local change");
    expect(log).toContain("Coding starts now");
    expect(log).toContain("It is in the factory pull request: https://github.com/owner/repo/pull/99");
    expect(prs()).toHaveLength(1);
    expect(log).toMatch(/gh issue edit 5 .*--remove-label Factory_go.*--add-label Factory_done/);
  });

  it("keeps adding issues to the open factory pull request instead of waiting for the merge", async () => {
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    await settle();
    issues([6, ["Factory_go"]]);
    await w.tick();
    await settle();
    expect(runOf("issue-deliver", "6")?.status).toBe("succeeded");
    expect(prs()).toHaveLength(1); // same PR, updated
    expect(gh.ghLog()).toMatch(/--- pr edit: pr edit 99 .*--title claude-factory: #5, #6/);
    const branch = prs()[0]!.headRefName;
    expect(gh.remoteGit("log", "--format=%s", `main..${branch}`)).toMatch(/Resolve #6[\s\S]*Resolve #5/);
  });

  it("waits for /approve when the plan's risk score is above 75, then codes", async () => {
    process.env.FAKE_RISK = "85";
    process.env.FAKE_RISK_REASON = "installs software";
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    await settle();
    const run = runOf("issue-deliver", "5")!;
    expect(run.status).toBe("waiting");
    expect(run.history.some((h) => h.id === "implement")).toBe(false);
    expect(gh.ghLog()).toContain("A human decides before coding starts:** the risk score is above 75");
    expect(gh.ghLog()).toMatch(/gh issue edit 5 .*--add-label Factory_waiting/);

    issues([5, ["Factory_go", "Factory_waiting"]]);
    const request = { author: { login: "bot" }, body: `plan <!-- claude-factory run=${run.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "marcel" }, body: "/approve keep it small", createdAt: "2026-01-01T01:00:00Z" }] });
    await w.tick();
    await settle();
    const done = runOf("issue-deliver", "5")!;
    expect(done.status).toBe("succeeded");
    expect(done.history.find((h) => h.id === "approve_plan")!.output).toContain("approved by marcel: keep it small");
  });

  it("fixes a waiting label when the run was approved elsewhere (e.g. in the UI)", async () => {
    process.env.FAKE_RISK = "85";
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    await settle();
    const run = runOf("issue-deliver", "5")!;
    expect(run.status).toBe("waiting");
    // Approved from the UI: the watcher didn't resume it, so nothing updated the label.
    scheduler.submit({ kind: "resume", runId: run.runId, decision: { approved: true, by: "ui" } });
    await settle();
    expect(runOf("issue-deliver", "5")!.status).toBe("succeeded");
    issues([5, ["Factory_go", "Factory_waiting"]]);
    await w.tick();
    await settle();
    expect(gh.ghLog()).toMatch(/gh issue edit 5 .*--remove-label Factory_waiting.*--remove-label Factory_go.*--add-label Factory_done/);
  });

  const SPLIT = (risk: number, agreed = false) => [
    "Too big: two concerns.", "## Split",
    "### ISSUE 1: Part A — status model", "DEPENDS_ON: none", "As a user I see the status.", "### Acceptance criteria", "- [ ] model",
    "### ISSUE 2: Part B — errors", "DEPENDS_ON: 1, #70", "As a user I understand errors.", "### Depends on", "Part A", "### Notes for this codebase", "- use strings.xml",
    `SPLIT_RISK: ${risk}`, ...(agreed ? ["SPLIT_APPROVED: yes"] : []), "PLAN_STATUS: TOO_BIG",
  ].join("\n");

  it("splits a too-big issue by itself when the split is low risk", async () => {
    process.env.FAKE_ISSUE_PLAN = SPLIT(20);
    issues([5, ["Factory_go"]]);
    await watcher().tick();
    await settle();
    const run = runOf("issue-deliver", "5")!;
    expect(run.status).toBe("succeeded");
    expect(run.history.map((h) => h.id).slice(-2)).toEqual(["split_gate", "create_split"]);
    const log = gh.ghLog();
    expect(log).toMatch(/created issue: issue create --repo acme\/app --title Part A — status model .*--label enhancement --label Factory_go/);
    expect(log).not.toMatch(/created issue:.*Factory_working/);
    expect(log).toContain("**Epic:** Updates\n\nPart 1 of 2 of #5");
    expect(log).toContain("### Depends on\n#101, #70"); // part 1 became #101; the planner's own section is replaced
    expect(log).not.toContain("### Depends on\nPart A");
    expect(log).toContain("split this issue into 2 issues");
    expect(log).toMatch(/gh issue close 5 --repo acme\/app --reason not planned/);
    expect(log).not.toMatch(/gh issue edit 5 .*--add-label Factory_done/); // closed in favour of the parts, not "done"
  });

  it("asks before a risky split, and creates the issues after /approve", async () => {
    process.env.FAKE_ISSUE_PLAN = SPLIT(70);
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    await settle();
    const run = runOf("issue-deliver", "5")!;
    expect(run.status).toBe("waiting");
    expect(gh.ghLog()).toContain("split risk: 70/100");
    expect(gh.ghLog()).not.toContain("created issue");
    issues([5, ["Factory_go", "Factory_waiting"]]);
    const request = { author: { login: "bot" }, body: `split <!-- claude-factory run=${run.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "marcel" }, body: "/approve", createdAt: "2026-01-01T01:00:00Z" }] });
    await w.tick();
    await settle();
    expect(runOf("issue-deliver", "5")!.status).toBe("succeeded");
    expect(gh.ghLog()).toContain("created issue: issue create --repo acme/app --title Part B — errors");
  });

  it("splits without asking when the owner already agreed, whatever the score", async () => {
    process.env.FAKE_ISSUE_PLAN = SPLIT(90, true);
    issues([5, ["Factory_go"]]);
    await watcher().tick();
    await settle();
    expect(runOf("issue-deliver", "5")!.status).toBe("succeeded");
    expect(gh.ghLog()).toContain("created issue: issue create --repo acme/app --title Part A");
  });

  it("tidies labels on issues closed by a merged pull request", async () => {
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    await settle();
    expect(runOf("issue-deliver", "5")!.status).toBe("succeeded");
    // #5 got closed by the merge while a stale error label was on it; #9 was closed by hand mid-way.
    issues();
    process.env.FAKE_GH_CLOSED_ISSUES = JSON.stringify([
      { number: 5, state: "CLOSED", labels: [{ name: "Factory_ERROR" }, { name: "Factory_go" }] },
      { number: 9, state: "CLOSED", labels: [{ name: "Factory_waiting" }, { name: "enhancement" }] },
      { number: 11, state: "CLOSED", labels: [{ name: "Factory_done" }] },
    ]);
    await w.tick();
    const log = gh.ghLog();
    expect(log).toMatch(/gh issue edit 5 --repo acme\/app --remove-label Factory_ERROR --remove-label Factory_go --add-label Factory_done/);
    expect(log).toMatch(/gh issue edit 9 --repo acme\/app --remove-label Factory_waiting\n/);
    expect(log).not.toMatch(/gh issue edit 11 /);
  });

  it("uses Codex's risk score when it is higher, and the review label always asks", async () => {
    process.env.FAKE_CODEX_RISK = "90";
    issues([5, ["Factory_go"]]);
    await watcher().tick();
    await settle();
    expect(runOf("issue-deliver", "5")?.status).toBe("waiting");
    expect(gh.ghLog()).toContain("**Risk: 90/100** — small local change — Codex scored it 90");

    delete process.env.FAKE_CODEX_RISK;
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go Factory_review_plan";
    const flow = loadFlow("issue-deliver", gh.tmp).flow;
    const r = await runFlow(flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { ...VARS, github_repo: REPO, issue: "7" } });
    expect(r.status).toBe("waiting");
    expect(gh.ghLog()).toContain("the issue has the `Factory_review_plan` label");
  });

  it("asks the open questions for all new issues up front, then builds; /defaults answers them", async () => {
    process.env.FAKE_QUESTIONS_FOR = "6";
    issues([5, ["Factory_go"]], [6, ["Factory_go"]]);
    const w = watcher({ precheck_flow: "epic-questions" });
    await w.tick();
    await settle();
    const check = scheduler.list().find((s) => s.flow === "epic-questions")!;
    expect(check.status).toBe("succeeded");
    expect(check.vars.issues).toBe("5 6");
    expect(runOf("issue-deliver", "5")).toBeUndefined(); // nothing is built before the check
    const log = gh.ghLog();
    expect(log).toContain("has questions before it builds this issue");
    expect(log).toContain("**Q1. Which package format?**");
    expect(log).toMatch(/gh issue edit 6 .*--add-label Factory_needs_info/);
    expect(log).not.toMatch(/gh issue edit 5 .*Factory_needs_info/);

    // #5 has no questions → built. #6 waits for an answer.
    issues([5, ["Factory_go"]], [6, ["Factory_go", "Factory_needs_info"]]);
    await w.tick();
    await settle();
    expect(runOf("issue-deliver", "5")?.status).toBe("succeeded");
    expect(runOf("issue-deliver", "6")).toBeUndefined();
    expect(w.status.lastError).toBeUndefined();
    expect(w.status.holds).toEqual([{ issue: 6, title: "issue 6", reason: "needs your answer — reply on the issue (or /defaults) and it continues" }]);

    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "questions <!-- claude-factory run=x questions -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: "/defaults", createdAt: "2026-01-01T01:00:00Z" },
    ] });
    issues([6, ["Factory_go", "Factory_needs_info"]]);
    await w.tick();
    await settle();
    expect(runOf("issue-deliver", "6")?.status).toBe("succeeded");
    expect(scheduler.list().filter((s) => s.flow === "epic-questions")).toHaveLength(1); // not checked twice
  });

  it("reports daily on the open factory PR: comment with the checks, draft while red", async () => {
    issues([5, ["Factory_go"]]);
    await watcher().tick();
    await settle();
    const ok = await runFlow(loadFlow("daily-pr", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: "true" } });
    expect(ok.status).toBe("succeeded");
    expect(ok.history.at(-1)!.output).toContain("checks passed — https://github.com/owner/repo/pull/99 is ready to merge");
    expect(gh.ghLog()).toContain("claude-factory daily report");
    const red = await runFlow(loadFlow("daily-pr", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: "false" } });
    expect(red.history.at(-1)!.output).toContain("is a draft");
    expect(gh.ghLog()).toMatch(/gh pr ready 99 --repo acme\/app --undo/);
    expect(prs()).toHaveLength(1);
  });
});

describe("restart on a new build", () => {
  it("notices a newer build", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-dist-"));
    writeFileSync(join(dir, "a.js"), "");
    const before = buildStamp(dir);
    utimesSync(join(dir, "a.js"), new Date(), new Date(Date.now() + 5000));
    expect(buildStamp(dir)).toBeGreaterThan(before);
  });

  it("starts the server again when it exits with the restart code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-sup-"));
    const script = join(dir, "server.mjs");
    // First start: ask for a restart. Second start (FACTORY_NO_OPEN set): exit normally.
    writeFileSync(script, `process.exit(process.env.FACTORY_NO_OPEN ? 0 : ${RESTART_CODE});`);
    const logs: string[] = [];
    expect(await supervise(script, [], (m) => logs.push(m))).toBe(0);
    expect(logs).toEqual(["restarting with the new version…"]);
    expect(spawnSync(process.execPath, [script]).status).toBe(RESTART_CODE);
  });
});
