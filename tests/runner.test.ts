import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-test-"));
  repo = join(tmp, "repo");
  execFileSync("mkdir", ["-p", repo]);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = (yaml: string, task = "the task", vars?: Record<string, string>) =>
  runFlow(parseFlow(yaml), { task, repo, runsDir: join(tmp, "runs"), claudeBin, vars });

describe("runFlow", () => {
  it("runs claude and shell steps in order and records history", async () => {
    const s = await run(`
name: t
workspace: inplace
steps:
  - id: write
    type: claude
    prompt: "WRITE out.txt hello"
  - id: check
    type: shell
    run: grep -q hello out.txt && echo "task=$FACTORY_TASK"
`);
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual(["write", "check"]);
    expect(s.history[1]!.output).toContain("task=the task");
    expect(s.totalCostUsd).toBeCloseTo(0.01);
    expect(JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")).status).toBe("succeeded");
    expect(existsSync(s.history[0]!.logFile)).toBe(true);
  });

  it("loops test → fix until tests pass, resuming the claude session", async () => {
    const s = await run(`
name: t
workspace: inplace
steps:
  - id: impl
    type: claude
    prompt: "SAY implemented"
  - id: test
    type: shell
    run: test -f fixed
    on_success: end
    on_failure: fix
  - id: fix
    type: claude
    resume: impl
    prompt: |
      WRITE fixed yes
      exit={{steps.test.exit_code}}
    on_success: test
`);
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual(["impl", "test", "fix", "test"]);
    const [impl, , fix] = s.history;
    expect(fix!.sessionId).toBe(impl!.sessionId);
    expect(fix!.output).toContain("exit=1");
  });

  it("stops runaway loops with max_visits", async () => {
    const s = await run(`
name: t
workspace: inplace
steps:
  - id: a
    type: shell
    run: "false"
    on_failure: a
    max_visits: 3
`);
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/exceeded max_visits \(3\)/);
    expect(s.history).toHaveLength(3);
  });

  it("gates on pass_if and routes on_failure", async () => {
    const s = await run(`
name: t
workspace: inplace
steps:
  - id: review
    type: claude
    prompt: "SAY VERDICT: CHANGES"
    pass_if: "^VERDICT: APPROVE$"
    on_failure: rejected
  - id: approved
    type: shell
    run: echo approved
    on_success: end
  - id: rejected
    type: shell
    run: echo rejected
`);
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual(["review", "rejected"]);
    expect(s.history[0]!.error).toMatch(/pass_if/);
  });

  it("fails the run on a claude error by default", async () => {
    const s = await run(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: ERROR}
  - {id: b, type: shell, run: echo never}
`);
    expect(s.status).toBe("failed");
    expect(s.history.map((h) => h.id)).toEqual(["a"]);
  });

  it("passes vars into shell commands but keeps task out of templates", async () => {
    const ok = await run(`
name: t
workspace: inplace
vars: {greeting: hi}
steps:
  - {id: a, type: shell, run: "echo {{vars.greeting}}"}
`, "x", { greeting: "hello" });
    expect(ok.history[0]!.output.trim()).toBe("hello");

    const bad = await run(`
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: "echo {{task}}"}
`);
    expect(bad.status).toBe("failed");
    expect(bad.history[0]!.error).toMatch(/not allowed/);
  });

  it("runs in an isolated git worktree on its own branch", async () => {
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(repo, "README"), "x");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

    const s = await run(`
name: t
steps:
  - {id: a, type: claude, prompt: "WRITE new.txt from-factory"}
`);
    expect(s.status).toBe("succeeded");
    expect(s.branch).toMatch(/^factory\//);
    expect(readFileSync(join(s.workdir!, "new.txt"), "utf8")).toBe("from-factory");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  });

  it("fails cleanly when worktree mode is used outside git", async () => {
    const s = await run(`name: t\nsteps:\n  - {id: a, type: shell, run: echo}`);
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/needs a git repository/);
  });
});
