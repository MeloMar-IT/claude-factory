import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { reportFirst, runClosedIssue } from "../src/next-step.js";
import { claudeBin, closing, fakeGithub, first } from "./helpers/fake-github.js";

// Hotfix path of issue-gitflow: a bug story is built on hotfix/<issue>-<title> from main, merged into main
// (tested, then pushed — the one push to main the Foundry makes) and then into develop.
const REPO = "acme/app";
const FAKES = [
  "FAKE_CODEX_VERDICT", "FAKE_CODEX_PLAN_VERDICT", "FAKE_CODEX_CODE_VERDICT", "FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_GH_COMMENTS",
  "FAKE_GH_ISSUE_LABELS", "FAKE_ISSUE_PLAN", "FAKE_RESOLVE_NOOP", "FAKE_GH_FAIL", "FAKE_GH_FAIL_LABELS", "FAKE_FORCED_SPLIT", "FACTORY_SELF_DIR",
];
const ZERO = "0".repeat(40);
const PLAIN_TEST = "! grep -q BUG feature.txt 2>/dev/null";

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

// Each test runs a whole flow with real git; a busy machine (parallel runs) needs more than the default 60 s.
describe("gitflow hotfix path", { timeout: 240_000 }, () => {
  let gh: ReturnType<typeof fakeGithub>;
  let config: Config;
  let branchLog: string;
  const hotfixConfig = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3, hotfix_to_main: true, ...over });

  beforeEach(() => {
    gh = fakeGithub();
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    for (const k of FAKES) delete process.env[k];
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go bug";
    branchLog = join(gh.tmp, "branches.txt");
    process.env.TEST_BRANCH_LOG = branchLog;
    config = hotfixConfig();
  });
  afterEach(() => gh.restore());

  const runsDir = () => join(gh.tmp, "runs");
  const flow = () => loadFlow("issue-gitflow", gh.tmp).flow;
  // The tests append the branch they run on, so a test can tell where they ran.
  const recording = (extra = "") => `git branch --show-current >> "$TEST_BRANCH_LOG"; ${extra}${PLAIN_TEST}`;
  const run = (issue: string, over: { test_cmd?: string; vars?: Record<string, string>; flow?: ReturnType<typeof flow> } = {}) =>
    runFlow(over.flow ?? flow(), {
      task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config,
      vars: { github_repo: REPO, issue, test_cmd: over.test_cmd ?? recording(), docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md", ...over.vars },
    });
  const resume = (r: RunSummary, from: string) => resumeRun({ runsDir: runsDir(), runId: r.runId, claudeBin, config, from });
  const ids = (r: RunSummary) => r.history.map((h) => h.id);
  const out = (r: RunSummary, id: string) => r.history.filter((h) => h.id === id).at(-1)?.output ?? "";
  const rev = (b: string) => gh.remoteGit("rev-parse", b).trim();
  const runFile = (r: RunSummary, name: string) => readFileSync(join(r.runDir, name), "utf8").trim();
  const branches = () => (existsSync(branchLog) ? readFileSync(branchLog, "utf8").split("\n").filter(Boolean) : []);
  const report = (issue = 5) => gh.comments().filter((c) => c.issue === issue && c.body.includes("### What was done")).at(-1)?.body ?? "";
  const mainOnly = (cmd: string) => `if [ "$(git branch --show-current)" = main ] && [ -f feature.txt ]; then ${cmd}; fi; `;
  const isAncestor = (a: string, b: string) => spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: gh.remote }).status === 0;
  const hasRemoteBranch = (pattern: string) => gh.remoteGit("branch", "--list", pattern).trim() !== "";
  // Something lands on main from a second clone, once, while the tests run (outside the push protection).
  const moveMain = (file: string, text: string) =>
    mainOnly(`if [ ! -f "$TEST_BRANCH_LOG.moved" ]; then touch "$TEST_BRANCH_LOG.moved"; w=$(mktemp -d); ( env -u GIT_CONFIG_COUNT git clone -q "$FAKE_GH_REMOTE" "$w" && cd "$w" && echo ${text} > ${file} && git add . && git commit -qm "main moved" && env -u GIT_CONFIG_COUNT git push -q origin main ); fi`);
  const remoteHook = (name: string, body: string) => {
    const p = join(gh.remote, "hooks", name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  // develop already has feature #6 (merged by a feature run), so the fix of #5 conflicts with it.
  const developWithFeature6 = async () => {
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go";
    const f = await run("6");
    expect(f.status, f.reason).toBe("succeeded");
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go bug";
  };

  it("1. a bug story ends on main and on develop", async () => {
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(out(r, "feature_branch")).toContain("HOTFIX: yes");
    expect(out(r, "hotfix_branch")).toContain("BRANCH: hotfix/5-add-a-feature (new, from main)");
    expect(branches()[0]).toBe("main"); // the tests before the change ran on main
    const h = ids(r);
    expect(h).toEqual(expect.arrayContaining(["baseline_main", "hotfix_branch", "merge_main", "test_main", "push_main", "merge_back", "test_back", "push_back", "hotfix_done", "report"]));
    for (const no of ["baseline_tests", "merge_develop", "push_develop"]) expect(h).not.toContain(no);
    expect(h.indexOf("test_back")).toBeLessThan(h.indexOf("push_back"));
    expect(gh.remoteGit("log", "-1", "--format=%s", "main").trim()).toBe("Merge #5: Add a feature (hotfix/5-add-a-feature)");
    const mainSha = rev("main");
    expect(runFile(r, "main-tested")).toBe(mainSha);
    expect(runFile(r, "main-sha")).toBe(mainSha);
    expect(isAncestor("main", "develop")).toBe(true);
    expect(rev("develop")).toBe(mainSha); // develop equalled main before: the back merge was a fast-forward
    expect(gh.remoteGit("show", "main:feature.txt")).toBe("implemented #5\n");
    // The issue is closed by push_main (the fix is on main), not by the release.
    expect(out(r, "push_main")).toMatch(/PUSHED: main [0-9a-f]+\nclosed #5/);
    expect(gh.ghLog()).toMatch(/gh issue close 5 --repo acme\/app --reason completed/);
    expect(runClosedIssue(r)).toBe(true);
    expect(hasRemoteBranch("hotfix/*")).toBe(false);
    expect(out(r, "hotfix_done")).toContain("DEVELOP: merged");
    const body = report();
    expect(first(body)).toBe(reportFirst("fixed"));
    expect(body).toContain(`/commit/${mainSha}`);
    expect(closing(body)).toEqual(["_The fix is on `main` and in `develop`._", `<!-- claude-factory run=${r.runId} -->`]);
  });

  it("2. develop has its own work: the back merge conflicts, the agent keeps both, the tests run", async () => {
    await developWithFeature6();
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(ids(r)).toEqual(expect.arrayContaining(["merge_back", "resolve_back", "finish_back", "test_back", "push_back"]));
    const feature = gh.remoteGit("show", "develop:feature.txt");
    expect(feature).toContain("implemented #5");
    expect(feature).toContain("implemented #6");
    expect(feature).not.toMatch(/<<<<<<<|>>>>>>>/);
    expect(gh.remoteGit("log", "--format=%s", "develop")).toContain("Merge main into develop (hotfix #5)");
    expect(isAncestor("main", "develop")).toBe(true);
    expect(gh.remoteGit("show", "main:feature.txt")).toBe("implemented #5\n"); // main has only the fix
    expect(first(report())).toBe(reportFirst("fixed"));
  });

  it("3. red tests on main push nothing, and the run can be tried again", async () => {
    const mainBefore = rev("main");
    const test_cmd = recording(mainOnly("exit 1"));
    const r = await run("5", { test_cmd });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("red_main");
    expect(out(r, "red_main")).toContain("Nothing was pushed to main");
    expect(ids(r)).not.toContain("push_main");
    const afterPush = r.history.slice(ids(r).indexOf("push_feature") + 1);
    expect(afterPush.every((x) => x.type === "shell")).toBe(true); // no agent step after the push of the branch
    expect(rev("main")).toBe(mainBefore);
    expect(hasRemoteBranch("hotfix/*")).toBe(true);
    expect(gh.ghLog()).not.toContain("gh issue close 5");
    const again = await resume(r, "push_main");
    expect(again.status).toBe("failed");
    expect(out(again, "push_main")).toContain("did not pass the tests");
    expect(rev("main")).toBe(mainBefore);
    // A new run for the same issue starts on main and continues the branch.
    const seen = branches().length;
    const second = await run("5", { test_cmd });
    expect(branches()[seen]).toBe("main");
    expect(out(second, "hotfix_branch")).toContain("(continuing, up to date with main)");
    expect(rev("main")).toBe(mainBefore);
  });

  it("4. main moves during the run without a conflict: merged and tested again", async () => {
    const r = await run("5", { test_cmd: recording(moveMain("moved.txt", "x")) });
    expect(r.status, `${r.reason}\n${out(r, "push_main")}`).toBe("succeeded");
    expect(ids(r).filter((x) => x === "merge_main")).toHaveLength(2);
    expect(ids(r).filter((x) => x === "test_main")).toHaveLength(2);
    expect(out(r, "push_main")).toContain("PUSHED:");
    const log = gh.remoteGit("log", "--format=%s", "main");
    expect(log).toContain("main moved");
    expect(log).toContain("Merge #5:");
    expect(runFile(r, "main-tested")).toBe(rev("main"));
    expect(isAncestor("main", "develop")).toBe(true);
  });

  it("5. main moves with a conflicting change: the run stops and nothing is pushed", async () => {
    const r = await run("5", { test_cmd: recording(moveMain("feature.txt", "other")) });
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("merge_main");
    expect(out(r, "merge_main")).toContain("changed in the same places");
    expect(out(r, "merge_main")).toContain("Nothing was pushed to main");
    expect(gh.remoteGit("show", "main:feature.txt")).toBe("other\n");
    expect(gh.remoteGit("log", "--format=%s", "main")).not.toContain("Merge #5");
    const afterPush = r.history.slice(ids(r).indexOf("push_feature") + 1);
    expect(afterPush.every((x) => x.type === "shell")).toBe(true);
    expect(hasRemoteBranch("hotfix/*")).toBe(true);
  });

  it("6. HEAD changes after the tests: push_main refuses", async () => {
    const mainBefore = rev("main");
    const r = await run("5", { test_cmd: recording(mainOnly("git commit -q --allow-empty -m sneaky")) });
    expect(r.status).toBe("failed");
    expect(out(r, "push_main")).toContain("is not the commit that was tested");
    expect(rev("main")).toBe(mainBefore);
  });

  it("7. develop cannot take the fix: it stays on main, and the report says so", async () => {
    await developWithFeature6();
    process.env.FAKE_RESOLVE_NOOP = "1";
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(out(r, "hotfix_done")).toContain("DEVELOP: behind — the conflicts could not be resolved");
    expect(gh.remoteGit("show", "main:feature.txt")).toBe("implemented #5\n");
    expect(isAncestor("main", "develop")).toBe(false);
    expect(hasRemoteBranch("hotfix/*")).toBe(true); // kept: develop does not have it yet
    expect(gh.ghLog()).toContain("gh issue close 5");
    const body = report();
    expect(first(body)).toBe(reportFirst("merge_back"));
    expect(body).toContain("does not have this fix yet");
    expect(body).toContain("The Foundry tries again when it starts the next story");
    expect(closing(body)[0]).toBe("_The fix is on `main`, not yet in `develop`._");
  });

  it("7b. tests that stay red on develop end the same way", async () => {
    const r = await run("5", { test_cmd: recording("if [ \"$(git branch --show-current)\" = develop ] && [ -f feature.txt ]; then exit 1; fi; ") });
    expect(r.status, r.reason).toBe("succeeded");
    expect(ids(r).filter((x) => x === "red_back")).toHaveLength(3);
    expect(out(r, "red_back")).toContain("DEVELOP_BEHIND: the tests still fail on develop with main merged in, after 2 fix attempts");
    expect(isAncestor("main", "develop")).toBe(false);
    expect(first(report())).toBe(reportFirst("merge_back"));
    expect(runFile(r, "main-sha")).toBe(rev("main"));
  });

  it("8. a feature story is unchanged, and the hotfix steps refuse to run for it", async () => {
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go";
    const mainBefore = rev("main");
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(ids(r).slice(0, 3)).toEqual(["pull_ticket", "feature_branch", "baseline_tests"]);
    for (const no of ["baseline_main", "hotfix_branch", "merge_main", "push_main", "merge_back", "hotfix_done"]) expect(ids(r)).not.toContain(no);
    expect(out(r, "feature_branch")).toContain("BRANCH: feature/5-add-a-feature (new, from develop)");
    expect(gh.remoteGit("log", "--format=%s", "develop")).toMatch(/^Merge #5: Add a feature \(feature\/5-add-a-feature\)/);
    expect(rev("main")).toBe(mainBefore);
    expect(first(report())).toBe(reportFirst("ships"));
    expect(report()).not.toContain("hotfixes to `main` are switched off");
    for (const from of ["push_main", "merge_main"]) {
      const bad = await resume(r, from);
      expect(bad.status).toBe("failed");
      expect(out(bad, from)).toContain("not a hotfix");
      expect(rev("main")).toBe(mainBefore);
    }
  });

  it("9. with the setting off, or a changed copy of the flow, a bug story is a feature and the report says why", async () => {
    const mainBefore = rev("main");
    config = hotfixConfig({ hotfix_to_main: false });
    const off = await run("5");
    expect(off.status, off.reason).toBe("succeeded");
    expect(ids(off)).not.toContain("merge_main");
    expect(report()).toContain("has the `bug` label, but hotfixes to `main` are switched off");
    expect(rev("main")).toBe(mainBefore);

    config = hotfixConfig();
    const copy = flow();
    copy.vars.hotfix_prefix = "fix/";
    const changed = await run("7", { flow: copy });
    expect(changed.status, changed.reason).toBe("succeeded");
    expect(ids(changed)).not.toContain("merge_main");
    expect(report(7)).toContain("a changed copy");
    expect(rev("main")).toBe(mainBefore);
  });

  it("10. a label lookup that fails stops a run that could be a hotfix", async () => {
    process.env.FAKE_GH_FAIL_LABELS = "1";
    const r = await run("5");
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("feature_branch");
    expect(out(r, "feature_branch")).toContain("could not read the labels");
    config = hotfixConfig({ hotfix_to_main: false });
    const off = await run("5");
    expect(off.status, off.reason).toBe("succeeded");
    expect(ids(off)).not.toContain("merge_main");
  });

  it("11. a hotfix over the size limit is not split by itself", async () => {
    process.env.FAKE_SIZE = "40 files, 3000 lines";
    const r = await run("5");
    expect(r.status).toBe("waiting");
    expect(r.waiting?.stepId).toBe("approve_split");
    expect(gh.ghLog()).not.toContain("created issue:");
    expect(gh.ghLog()).toContain("a hotfix is never split by itself");
    expect(ids(r)).not.toContain("implement");
  });

  it("12. a risky hotfix plan waits for a person", async () => {
    process.env.FAKE_RISK = "90";
    const r = await run("5");
    expect(r.status).toBe("waiting");
    expect(r.waiting?.stepId).toBe("approve_plan");
    expect(gh.ghLog()).toContain("This is a hotfix: after the reviews it goes straight to `main`");
    expect(ids(r)).not.toContain("implement");
  });

  it("13. when GitHub only accepts pull requests on main, the run fails with a clear message", async () => {
    remoteHook("pre-receive", `while read old new ref; do if [ "$ref" = refs/heads/main ]; then echo "GH006: Protected branch update failed for $ref." >&2; exit 1; fi; done`);
    const mainBefore = rev("main");
    const r = await run("5");
    expect(r.status).toBe("failed");
    expect(out(r, "push_main")).toContain("only accepts pull requests");
    expect(rev("main")).toBe(mainBefore);
    expect(gh.ghLog()).not.toContain("gh issue close 5");
  });

  it("14. the daily release still works after a hotfix: no conflicts, and the hotfix is not listed again", async () => {
    await developWithFeature6();
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    const rel = await runFlow(loadFlow("release-daily", gh.tmp).flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: "true" } });
    expect(rel.status, rel.reason).toBe("succeeded");
    expect(rel.history.at(-1)!.output).toMatch(/\(Release \d{4}-\d\d-\d\d: #6\)/);
    const scratch = mkdtempSync(join(tmpdir(), "release-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: scratch, encoding: "utf8" });
    git("clone", "-q", gh.remote, ".");
    git("checkout", "-q", "main");
    expect(git("merge", "--no-commit", "--no-ff", "origin/develop").status).toBe(0);
  });

  it("15. the comment says whether the running Foundry has the fix", async () => {
    const dir = () => mkdtempSync(join(tmpdir(), "self-"));
    const checkout = () => {
      const d = dir();
      spawnSync("git", ["clone", "-q", gh.remote, d]);
      spawnSync("git", ["remote", "set-url", "origin", `https://github.com/${REPO}.git`], { cwd: d });
      return d;
    };
    const old = checkout(); // made before the run
    process.env.FACTORY_SELF_DIR = old;
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(out(r, "hotfix_done")).toContain("FOUNDRY: not yet");
    expect(report()).toContain("The running Foundry does not have this fix yet");
    // Pulled later: still the commit the Foundry started with.
    spawnSync("git", ["pull", "-q", gh.remote, "main"], { cwd: old });
    expect(out(await resume(r, "hotfix_done"), "hotfix_done")).toContain("FOUNDRY: not yet");
    // Another checkout at the new main.
    process.env.FACTORY_SELF_DIR = checkout();
    const fresh = await resume(r, "hotfix_done");
    expect(out(fresh, "hotfix_done")).toContain("FOUNDRY: has the fix");
    expect(report()).toContain("The running Foundry already has this fix.");
  });

  it("16. the merged branch is deleted when asked to, and a failed delete is said", async () => {
    const keep = await run("5", { vars: { delete_merged_branches: "no" } });
    expect(keep.status, keep.reason).toBe("succeeded");
    expect(hasRemoteBranch("hotfix/*")).toBe(true);
    gh.remoteGit("branch", "-D", "hotfix/5-add-a-feature");
    remoteHook("pre-receive", `while read old new ref; do case "$ref" in refs/heads/hotfix/*) [ "$new" = ${ZERO} ] && { echo "no deleting" >&2; exit 1; } ;; esac; done; exit 0`);
    const stuck = await run("6");
    expect(stuck.status, stuck.reason).toBe("succeeded");
    expect(out(stuck, "hotfix_done")).toContain("BRANCH: kept");
    expect(report(6)).toContain("The branch `hotfix/6-add-a-feature` could not be deleted — delete it by hand.");
  });

  it("18. a feature run cannot push to main, even by setting FACTORY_PUSH_ALLOW itself", async () => {
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go";
    const mainBefore = rev("main");
    const tries = ["main", "main:00", "main:$(ls $FACTORY_HOME/hooks/allow 2>/dev/null | head -1)"]
      .map((v) => `FACTORY_PUSH_ALLOW="${v}" git push -q origin HEAD:main 2>>"$TEST_BRANCH_LOG.push"; `).join("");
    const r = await run("5", { test_cmd: recording(tries) });
    expect(r.status, r.reason).toBe("succeeded");
    expect(rev("main")).toBe(mainBefore);
    expect(readFileSync(`${branchLog}.push`, "utf8")).toContain("protected branch 'main' is blocked");
    expect(ids(r)).not.toContain("push_main");
  });

  it("19. the hotfix branch starts from the commit the baseline tests passed on, even if main moved meanwhile", async () => {
    const test_cmd = recording(`if [ "$(git branch --show-current)" = main ] && [ ! -f feature.txt ] && [ ! -f "$TEST_BRANCH_LOG.moved" ]; then touch "$TEST_BRANCH_LOG.moved"; w=$(mktemp -d); ( env -u GIT_CONFIG_COUNT git clone -q "$FAKE_GH_REMOTE" "$w" && cd "$w" && echo x > moved.txt && git add . && git commit -qm "main moved" && env -u GIT_CONFIG_COUNT git push -q origin main ); fi; `);
    const r = await run("5", { test_cmd });
    expect(r.status, r.reason).toBe("succeeded");
    const moved = gh.remoteGit("log", "--grep=main moved", "--format=%H", "main").trim();
    expect(runFile(r, "baseline-sha")).toBe(gh.remoteGit("rev-parse", `${moved}^`).trim());
    expect(gh.remoteGit("show", "main:moved.txt")).toBe("x\n"); // merge_main still brought the new main in
    expect(runFile(r, "main-tested")).toBe(rev("main"));
  });

  it("20. a report that cannot be posted fails the run, and a resume at the report posts it", async () => {
    process.env.FAKE_GH_FAIL = "issue comment";
    const r = await run("5");
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("report");
    expect(out(r, "report")).toContain("the fix is on main, but the report could not be posted");
    expect(gh.remoteGit("show", "main:feature.txt")).toBe("implemented #5\n");
    delete process.env.FAKE_GH_FAIL;
    const again = await resume(r, "report");
    expect(again.status, again.reason).toBe("succeeded");
    expect(first(report())).toBe(reportFirst("fixed"));
  });

  it("21. labels match whatever their case", async () => {
    process.env.FAKE_GH_ISSUE_LABELS = "Factory_go Bug";
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(out(r, "feature_branch")).toContain("HOTFIX: yes");
    expect(ids(r)).toContain("push_main");
  });

  it("22. commits added to the hotfix branch after the merge are not deleted with it", async () => {
    const test_cmd = recording(`if [ "$(git branch --show-current)" = develop ] && [ ! -f "$TEST_BRANCH_LOG.late" ]; then touch "$TEST_BRANCH_LOG.late"; w=$(mktemp -d); ( env -u GIT_CONFIG_COUNT git clone -q -b hotfix/5-add-a-feature "$FAKE_GH_REMOTE" "$w" && cd "$w" && echo late > late.txt && git add . && git commit -qm "late work" && env -u GIT_CONFIG_COUNT git push -q origin HEAD:hotfix/5-add-a-feature ); fi; `);
    const r = await run("5", { test_cmd });
    expect(r.status, r.reason).toBe("succeeded");
    expect(out(r, "hotfix_done")).toContain("BRANCH: kept — unmerged commits");
    expect(gh.remoteGit("log", "-1", "--format=%s", "hotfix/5-add-a-feature").trim()).toBe("late work");
    expect(report()).toContain("was not deleted: it has commits that are not in `develop`");
  });

  it("17. an issue that cannot be closed is said in the comment, not a failure", async () => {
    process.env.FAKE_GH_FAIL = "issue close";
    const r = await run("5");
    expect(r.status, r.reason).toBe("succeeded");
    expect(report()).toContain("could not be closed — close it by hand");
    expect(out(r, "report")).not.toContain("closed #5");
  });
});
