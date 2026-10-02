import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow, parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { buildStamp, RESTART_CODE, supervise } from "../src/supervise.js";
import { commentFirst, commentText, firstLine, nextStepEnv, reportFirst, runNextStep } from "../src/next-step.js";
import { claudeBin, closing, fakeGithub, first, flowPath } from "./helpers/fake-github.js";

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
    const plan = gh.comments().find((c) => c.body.includes("Coding starts now"))!.body;
    expect(first(plan)).toBe(nextStepEnv().FACTORY_FIRST_NOTHING);
    expect(plan.split("\n")[2]).toMatch(/^🤖 \*\*Spaghetti Code Foundry plan\*\*/);
    expect(plan.split("\n").at(-1)).toBe(`<!-- claude-factory run=${run.runId} plan -->`);
    expect(log).toContain("It is in the release pull request: https://github.com/owner/repo/pull/99");
    const result = gh.comments().find((c) => c.body.includes("implemented this on branch"))!.body;
    expect(first(result)).toBe(reportFirst("ships"));
    expect(result).toMatch(/_It is in the release pull request: https:\/\/github.com\/owner\/repo\/pull\/99\s+— merge it whenever you like\._/);
    expect(result.split("\n").at(-1)).toBe(`<!-- claude-factory run=${run.runId} -->`);
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
    expect(gh.ghLog()).toMatch(/--- pr edit: pr edit 99 .*--title Foundry: #5, #6/);
    expect(gh.ghLog()).toContain("Work from Spaghetti Code Foundry.");
    expect(gh.ghLog()).toContain("the Foundry runs the full tests");
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
    const planNext = runNextStep(run, { watched: true });
    expect(planNext.kind).toBe("approve_plan");
    const planBody = gh.comments().find((c) => c.body.includes("A human decides"))!.body;
    expect(first(planBody)).toBe(firstLine(planNext));
    expect(first(planBody)).toBe(commentFirst("approve_plan"));
    expect(closing(gh.comments().find((c) => c.body.includes("A human decides"))!.body)).toEqual([`_${planNext.text}_`, `<!-- claude-factory run=${run.runId} approval -->`]);
    expect(planNext.text).toBe(commentText("approve_plan"));

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
    expect(log).toContain("🤖 **Spaghetti Code Foundry** split this issue into 2 issues");
    expect(log).toContain("<!-- claude-factory split run=");
    const split = gh.comments().find((c) => c.body.includes("split this issue into"))!.body;
    expect(split.split("\n").slice(0, 3)).toEqual([reportFirst("info"), "", "🤖 **Spaghetti Code Foundry** split this issue into 2 issues, built in this order:"]);
    expect(closing(split)).toEqual(["Closing this one in favour of them.", `<!-- claude-factory split run=${run.runId} -->`]);
    expect(log).toContain("split by Spaghetti Code Foundry.");
    expect(log).toMatch(/gh issue close 5 --repo acme\/app --reason not planned/);
    expect(log).not.toMatch(/gh issue edit 5 .*--add-label Factory_done/); // closed in favour of the parts, not "done"
  });

  const OLD = "🤖 **claude-factory** split this issue into";
  const NEW = "🤖 **Spaghetti Code Foundry** split this issue into";
  const OLD_MARK = "<!-- claude-factory split run=r1 -->";
  const NEW_MARK = "<!-- spaghetti-code-foundry split run=r1 -->";
  const LEAD = "**Nothing needed from you**\n\n";
  it.each([
    ["old heading, old marker", OLD, OLD_MARK, ""],
    ["new heading, old marker", NEW, OLD_MARK, ""],
    ["new heading, new marker", NEW, NEW_MARK, ""],
    ["first line, old heading, old marker", OLD, OLD_MARK, LEAD],
    ["first line, new heading, old marker", NEW, OLD_MARK, LEAD],
    ["first line, new heading, new marker", NEW, NEW_MARK, LEAD],
  ])("treats an earlier finished split as done (%s)", (_name, head, mark, lead) => {
    process.env.FAKE_GH_PARENT = JSON.stringify({ title: "Add a feature", body: "", labels: [],
      comments: [{ author: { login: "bot" }, body: `${lead}${head} 2 issues, built in this order:\n\n- #101 Part A\n- #102 Part B\n\nClosing this one in favour of them.\n\n${mark}` }] });
    const r = spawnSync(process.execPath, [resolve("tools/create-split")], { input: SPLIT(20), encoding: "utf8",
      env: { ...process.env, FACTORY_VAR_GITHUB_REPO: REPO, FACTORY_VAR_ISSUE: "5", FACTORY_RUN_ID: "again" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already split: #101 #102");
    const log = gh.ghLog();
    expect(log).not.toContain("created issue");
    expect(log).not.toContain("issue close");
  });

  const runSplit = (extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [resolve("tools/create-split")], { input: SPLIT(20), encoding: "utf8",
      env: { ...process.env, FACTORY_VAR_GITHUB_REPO: REPO, FACTORY_VAR_ISSUE: "5", FACTORY_RUN_ID: "r1", ...extra } });

  it("recognises its own comment with the first line on a second run", () => {
    expect(runSplit({ FACTORY_FIRST_INFO: reportFirst("info") }).status).toBe(0);
    const posted = gh.comments().find((c) => c.body.includes("split this issue into"))!;
    expect(posted.body.split("\n")[0]).toBe(reportFirst("info"));
    process.env.FAKE_GH_PARENT = JSON.stringify({ title: "Add a feature", body: "", labels: [], comments: [{ author: { login: "bot" }, body: posted.body }] });
    const b = runSplit();
    expect(b.status).toBe(0);
    expect(b.stdout).toContain("already split: #101 #102");
    expect(gh.ghLog().match(/created issue/g)).toHaveLength(2);
  });

  it("does not take a heading in the middle of a line as a finished split", () => {
    process.env.FAKE_GH_PARENT = JSON.stringify({ title: "Add a feature", body: "", labels: [],
      comments: [{ author: { login: "bot" }, body: `I saw "${NEW}" somewhere\n${OLD_MARK}` }] });
    const r = runSplit();
    expect(r.stdout).not.toContain("already split");
    expect(gh.ghLog()).toContain("created issue");
  });

  it("isn't fooled by a comment that only mentions the split marker, and moves dependents onto the parts", async () => {
    process.env.FAKE_ISSUE_PLAN = SPLIT(20);
    process.env.FAKE_GH_PARENT = JSON.stringify({ title: "Add a feature", body: "Please add it", labels: [{ name: "Factory_go" }],
      comments: [{ author: { login: "bot" }, body: "Question: markers like `<!-- claude-factory split` or `<!-- spaghetti-code-foundry split run=x -->` …\n<!-- claude-factory run=x questions -->" }] });
    issues([5, ["Factory_go"]]);
    const w = watcher();
    await w.tick();
    // #7 depends on #5; once #5 is split it must wait for the parts, not for the closed #5.
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 5, title: "issue 5", labels: [{ name: "Factory_go" }], state: "OPEN", body: "" },
      { number: 7, title: "issue 7", labels: [], state: "OPEN", body: "Do it.\n\n### Depends on\n#5\n\n### Notes\nx" },
    ]);
    await settle();
    const log = gh.ghLog();
    expect(log).toContain("created issue: issue create --repo acme/app --title Part A");
    expect(log).toContain("--- issue body edit: issue edit 7 --repo acme/app --body-file -\nDo it.\n\n### Depends on\n#5, #101, #102 (parts of #5)\n\n### Notes");
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
    expect(gh.ghLog()).toContain("✋ **You decide** (the split risk is 70/100 (above 50)).");
    const splitNext = runNextStep(run, { watched: true });
    expect(splitNext.kind).toBe("approve_split");
    const splitBody = gh.comments().find((c) => c.body.includes("split risk: 70/100"))!.body;
    expect(first(splitBody)).toBe(firstLine(splitNext));
    expect(first(splitBody)).toBe(commentFirst("approve_split"));
    expect(closing(gh.comments().find((c) => c.body.includes("split risk: 70/100"))!.body)).toEqual([`_${splitNext.text}_`, `<!-- claude-factory run=${run.runId} approval -->`]);
    expect(splitNext.text).toBe(commentText("approve_split"));
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
    expect(log).toContain("🤖 **Spaghetti Code Foundry** has questions before it builds this issue");
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
    expect(w.status.holds).toMatchObject([{
      issue: 6, title: "issue 6",
      next: { kind: "questions", who: "You", action: "Answer the questions" },
      url: "https://github.com/acme/app/issues/6",
    }]);
    expect(w.status.holds![0]!.reason).toContain("/defaults");
    const asked = gh.comments().find((c) => c.issue === 6 && c.body.includes("has questions before it builds"))!;
    expect(first(asked.body)).toBe(commentFirst("questions"));
    expect(asked.body.split("\n")[2]).toMatch(/^🤖 \*\*Spaghetti Code Foundry\*\* has questions before it builds this issue/);
    expect(closing(asked.body)).toEqual([`_${commentText("questions")}_`, expect.stringMatching(/^<!-- claude-factory run=\S+ questions -->$/)]);

    // A bot comment with only the new marker is not an answer.
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "questions <!-- spaghetti-code-foundry run=x questions -->", createdAt: "2026-01-01T00:00:00Z" },
    ] });
    issues([6, ["Factory_go", "Factory_needs_info"]]);
    await w.tick();
    await settle();
    expect(runOf("issue-deliver", "6")).toBeUndefined();

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
    expect(gh.ghLog()).toContain("Spaghetti Code Foundry daily report");
    expect(gh.ghLog()).toContain("the Foundry keeps working either way");
    const red = await runFlow(loadFlow("daily-pr", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: "false" } });
    expect(red.history.at(-1)!.output).toContain("is a draft");
    expect(gh.ghLog()).toMatch(/gh pr ready 99 --repo acme\/app --undo/);
    expect(prs()).toHaveLength(1);
    const reports = gh.comments().filter((c) => c.body.includes("daily report"));
    expect(reports).toHaveLength(2);
    const green = reports[0]!.body;
    expect(first(green)).toBe(reportFirst("merge_release"));
    expect(green.split("\n")[2]).toMatch(/^🤖 \*\*Spaghetti Code Foundry daily report\*\* — /);
    expect(closing(green)).toEqual(["_Merge whenever you like — the Foundry keeps working either way; after a merge it continues on a fresh branch._", `<!-- claude-factory run=${ok.runId} daily -->`]);
    const failed = reports[1]!.body;
    expect(first(failed)).toBe(reportFirst("draft"));
    expect(failed).toContain("⚠ **Checks failed**");
    expect(failed).not.toContain("Merge whenever you like");
    expect(failed.split("\n").at(-1)).toBe(`<!-- claude-factory run=${red.runId} daily -->`);
  });
});

describe("restart on a new build", () => {
  it("stops starting new work while a new version waits for active runs", async () => {
    const { restartOnNewBuild } = await import("../src/supervise.js");
    const dir = mkdtempSync(join(tmpdir(), "factory-dist-"));
    writeFileSync(join(dir, "a.js"), "");
    let busy = true;
    let drained = 0;
    const logs: string[] = [];
    const exit = process.exit;
    let exited: number | undefined;
    process.exit = ((c?: number) => { exited = c; }) as typeof process.exit;
    const stop = restartOnNewBuild({ distDir: dir, idle: () => !busy, drain: () => drained++, beforeExit: () => {}, log: (m) => logs.push(m), everyMs: 30 });
    try {
      utimesSync(join(dir, "a.js"), new Date(), new Date(Date.now() + 5000));
      await new Promise((r) => setTimeout(r, 200));
      expect(drained).toBe(1); // once, not every check
      expect(exited).toBeUndefined();
      busy = false;
      await new Promise((r) => setTimeout(r, 120));
      expect(exited).toBe(RESTART_CODE);
      expect(logs[0]).toContain("no new runs start");
    } finally {
      stop();
      process.exit = exit;
    }
  });

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

describe("generated issue flows", () => {
  const FLOWS = ["pr-feedback", "issue-plan", "issue-code-daily", "issue-deliver", "issue-gitflow", "release-daily", "daily-pr"];
  const text = (f: string) => readFileSync(flowPath(f), "utf8");
  const step = (f: string, id: string) => JSON.stringify(parseFlow(text(f), f).steps.find((s) => s.id === id));

  it("names both plan headings in the implement prompt", () => {
    const p = step("issue-code-daily", "implement");
    expect(p).toContain('\\"Spaghetti Code Foundry plan\\" comment (older ones are headed');
    expect(p).toContain('\\"claude-factory plan\\")');
    expect(p).toContain("is for the owner, not a step of the plan");
  });

  it("keeps the hidden markers", () => {
    const run = (f: string, id: string) => {
      const s = parseFlow(text(f), f).steps.find((x) => x.id === id);
      return s && "run" in s ? String(s.run ?? "") : "";
    };
    expect(run("issue-plan", "post_plan")).toContain("run=$FACTORY_RUN_ID plan -->");
    for (const f of ["issue-code-daily", "issue-deliver", "issue-gitflow"]) expect(run(f, "report")).toContain("run=$FACTORY_RUN_ID -->");
    expect(run("pr-feedback", "reply")).toContain("run=$FACTORY_RUN_ID -->");
    expect(run("release-daily", "release_pr")).toContain("run=$FACTORY_RUN_ID daily -->");
    expect(run("release-daily", "release_pr")).toContain("run=$FACTORY_RUN_ID release -->");
    expect(run("daily-pr", "report")).toContain("run=$FACTORY_RUN_ID daily -->");
  });

  it.each(["issue-deliver", "issue-gitflow"])("%s swaps the implement prompt to the approved plan", (f) => {
    const p = step(f, "implement");
    expect(p).toContain("Follow this plan (comments from people on the issue override it)");
    expect(p).not.toContain("Follow the plan in the latest");
  });

  it("the gitflow report still points at the daily release pull request", () => {
    const r = step("issue-gitflow", "report");
    expect(r).toContain("with the daily release pull request");
    expect(r).not.toContain("Foundry pull request");
  });

  it("pr-feedback leaves out comments with the new marker", () => {
    expect(step("pr-feedback", "pr_comments").split('contains(\\"spaghetti-code-foundry\\")')).toHaveLength(3);
  });

  it("writes the old marker only", () => {
    for (const f of FLOWS) {
      expect(text(f)).not.toMatch(/🤖 \*\*claude-factory/);
      expect(text(f)).not.toContain("<!-- spaghetti-code-foundry");
    }
  });
});
