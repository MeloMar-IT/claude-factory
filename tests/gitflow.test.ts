import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// Gitflow: one feature branch per issue, merged into develop by the factory (in parallel when
// the code areas differ); develop goes to main once a day in one pull request.
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const VARS = { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" };
const FAKES = ["FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_GH_COMMENTS", "FAKE_GH_ISSUE_LABELS", "FAKE_ISSUE_PLAN"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

describe("gitflow pipeline", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  // develop is not protected here: the factory merges into it itself.
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3 });
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    gh = fakeGithub();
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => gh.restore());

  const watcher = () => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-gitflow", max_per_tick: 2,
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const issues = (...nums: number[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(nums.map((number) => ({ number, title: `issue ${number}`, labels: [{ name: "Factory_go" }] })));
  };
  const settle = async () => {
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  };
  const runOf = (issue: string) => scheduler.list().find((s) => s.flow === "issue-gitflow" && s.vars.issue === issue);

  it("codes an issue on its own feature branch and merges it into develop (created from main)", async () => {
    issues(5);
    await watcher().tick();
    await settle();
    const run = runOf("5")!;
    expect(run.reason).toBeUndefined();
    expect(run.status).toBe("succeeded");
    const ids = run.history.map((h) => h.id);
    expect(ids.slice(0, 3)).toEqual(["pull_ticket", "feature_branch", "baseline_tests"]);
    expect(ids).toEqual(expect.arrayContaining(["size_gate", "risk_gate", "claim_areas", "implement", "push_feature", "merge_develop", "test_develop", "push_develop", "report"]));
    expect(run.history.find((h) => h.id === "feature_branch")!.output).toContain("BRANCH: feature/5-add-a-feature (new, from develop)");
    expect(gh.remoteGit("log", "--format=%s", "develop")).toMatch(/^Merge #5: Add a feature \(feature\/5-add-a-feature\)/);
    expect(gh.remoteGit("show", "develop:feature.txt")).toBe("implemented #5\n");
    expect(gh.remoteGit("log", "--format=%s", "main")).not.toContain("#5"); // main untouched
    const log = gh.ghLog();
    expect(log).toContain("merged it into `develop`");
    expect(log).toContain("with the daily release pull request");
    expect(log).toMatch(/gh issue edit 5 .*--add-label Factory_done/);
  });

  it("codes two issues in parallel on different areas and merges both into develop, resolving conflicts", async () => {
    issues(6, 7);
    await watcher().tick();
    await settle();
    const [a, b] = [runOf("6")!, runOf("7")!];
    expect([a.status, b.status, a.reason, b.reason]).toEqual(["succeeded", "succeeded", undefined, undefined]);
    const develop = gh.remoteGit("log", "--format=%s", "develop");
    expect(develop).toContain("Merge #6:");
    expect(develop).toContain("Merge #7:");
    // Both wrote feature.txt: the second merge conflicted and the agent kept both sides.
    expect([a, b].some((r) => r.history.some((h) => h.id === "resolve_conflicts"))).toBe(true);
    const feature = gh.remoteGit("show", "develop:feature.txt");
    expect(feature).toContain("implemented #6");
    expect(feature).toContain("implemented #7");
    expect(feature).not.toMatch(/<<<<<<<|>>>>>>>/);
    // The changelog merged by itself (union): both entries, no conflict markers.
    const changelog = gh.remoteGit("show", "develop:docs/CHANGELOG.md");
    expect(changelog).toContain("#6");
    expect(changelog).toContain("#7");
  });

  it("brings develop up to date with main first (e.g. a pull request merged elsewhere)", async () => {
    issues(5);
    const w = watcher();
    await w.tick();
    await settle();
    // Something lands on main that develop doesn't have.
    const work = mkdtempSync(join(tmpdir(), "hotfix-"));
    const git = (...a: string[]) => spawnSync("git", a, { cwd: work, encoding: "utf8" });
    git("clone", "-q", process.env.FAKE_GH_REMOTE!, ".");
    writeFileSync(join(work, "hotfix.txt"), "fix\n");
    git("add", "."); git("commit", "-qm", "hotfix on main"); git("push", "-q", "origin", "main");
    issues(6);
    await w.tick();
    await settle();
    expect(runOf("6")!.history.find((h) => h.id === "feature_branch")!.output).toContain("brought develop up to date with main");
    expect(gh.remoteGit("show", "develop:hotfix.txt")).toBe("fix\n");
    expect(gh.remoteGit("log", "--format=%s", "develop")).toMatch(/Merge #6:[\s\S]*Merge main into develop/);
  });

  it("splits an issue whose plan is over the size limit", async () => {
    process.env.FAKE_SIZE = "40 files, 3000 lines";
    issues(8);
    await watcher().tick();
    await settle();
    const run = runOf("8")!;
    expect(run.status).toBe("succeeded");
    expect(run.history.map((h) => h.id)).toEqual(expect.arrayContaining(["size_gate", "force_split", "split_gate", "create_split"]));
    expect(run.history.find((h) => h.id === "size_gate")!.output).toContain("40 files, 3000 lines of production code (limit 15 files, 800 lines)");
    expect(gh.ghLog()).toContain("created issue: issue create --repo acme/app --title Small part one");
    expect(run.history.some((h) => h.id === "implement")).toBe(false);
  });

  it("opens one release pull request develop → main that closes the merged issues", async () => {
    issues(5);
    await watcher().tick();
    await settle();
    const flow = loadFlow("release-daily", gh.tmp).flow;
    const r = await runFlow(flow, { task: "", repo: gh.tmp, runsDir: runsDir(), claudeBin, config, vars: { github_repo: REPO, test_cmd: "true" } });
    expect(r.status).toBe("succeeded");
    expect(r.history.at(-1)!.output).toMatch(/checks passed — PR #99 \(Release \d{4}-\d\d-\d\d: #5\) is ready to merge/);
    const log = gh.ghLog();
    expect(log).toMatch(/gh pr create --repo acme\/app --base main --head develop --title Release/);
    expect(log).toContain("Closes #5");
    expect(log).toContain("Spaghetti Code Foundry daily release check");
  });
});

describe("area locks", () => {
  const tool = resolve("tools/area-lock");
  const dir = mkdtempSync(join(tmpdir(), "locks-"));
  const env = { ...process.env, FACTORY_LOCK_DIR: join(dir, "locks"), AREA_LOCK_POLL_MS: "50" };
  const runDir = (id: string, status: string) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "run.json"), JSON.stringify({ status }));
    return join(dir, id);
  };
  const lock = (...a: string[]) => spawnSync(tool, ["acquire", ...a], { env, encoding: "utf8" });

  it("lets different areas through, holds overlapping ones, and ignores runs that stopped", () => {
    const r1 = runDir("r1", "running");
    expect(lock("r1", r1, "platform/update,desktop/Main.kt").stdout).toContain("LOCKED");
    expect(lock("r2", runDir("r2", "running"), "packaging").stdout).toContain("LOCKED");
    const blocked = lock("r3", runDir("r3", "running"), "platform", "--wait-sec", "0.3");
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain("waiting for run r1 (platform/update, desktop/Main.kt)");
    writeFileSync(join(r1, "run.json"), JSON.stringify({ status: "failed" }));
    expect(lock("r3", join(dir, "r3"), "platform", "--wait-sec", "1").stdout).toContain("LOCKED");
    expect(lock("r3", join(dir, "r3"), "@develop").stdout).toContain("LOCKED");
    expect(lock("r2", join(dir, "r2"), "@develop", "--wait-sec", "0.3").status).toBe(1);
    spawnSync(tool, ["release", "r3"], { env });
    expect(lock("r2", join(dir, "r2"), "@develop", "--wait-sec", "1").stdout).toContain("LOCKED");
    expect(readFileSync(join(dir, "r2", "run.json"), "utf8")).toContain("running");
  });
});

describe("coding agents can run the build", () => {
  it("allows the project's build and test commands, never git push", async () => {
    const flow = loadFlow("issue-gitflow", process.cwd()).flow;
    expect(flow.defaults.allowed_tools).toEqual(expect.arrayContaining(["Bash(./gradlew *)", "Bash(npm *)", "Bash(pytest*)"]));
    expect(flow.defaults.allowed_tools!.some((t) => /push/.test(t))).toBe(false);
    const implement = flow.steps.find((s) => s.id === "implement")!;
    expect(implement.type === "claude" && implement.prompt).toContain("You may run the build and the tests yourself");
  });

  it("passes agent_env to the agents, but never PATH, tokens or factory variables", async () => {
    const { agentEnv } = await import("../src/agents/run.js");
    expect(agentEnv("JAVA_HOME=/opt/jdk21; GRADLE_OPTS=-Xmx2g\nPATH=/evil\nGH_TOKEN=x\nFACTORY_VAR_X=1\nnot a pair")).toEqual({ JAVA_HOME: "/opt/jdk21", GRADLE_OPTS: "-Xmx2g" });
  });
});
