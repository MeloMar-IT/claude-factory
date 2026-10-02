import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  it("runs shell steps without colour even if FORCE_COLOR is set", async () => {
    process.env.FORCE_COLOR = "1";
    try {
      const s = await run(`
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: "node -e 'console.log(5)'; printf '\\\\033[31mred\\\\033[0m'"}
`);
      expect(s.history[0]!.output).toBe("5\nred");
    } finally {
      delete process.env.FORCE_COLOR;
    }
  });

  it("skips jump_only steps in normal order and can stop a run", async () => {
    const ok = await run(`
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: "true", on_failure: handler}
  - {id: handler, type: shell, run: "echo handled", jump_only: true, on_success: stop}
  - {id: b, type: shell, run: "true"}
`);
    expect(ok.status).toBe("succeeded");
    expect(ok.history.map((h) => h.id)).toEqual(["a", "b"]);

    const stopped = await run(`
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: "false", on_failure: handler}
  - {id: handler, type: shell, run: "echo handled", jump_only: true, on_success: stop}
  - {id: b, type: shell, run: "true"}
`);
    expect(stopped.status).toBe("stopped");
    expect(stopped.history.map((h) => h.id)).toEqual(["a", "handler"]);
  });

  it("exposes vars as env and supports an empty workspace", async () => {
    const s = await run(`
name: t
workspace: empty
vars: {github_repo: "o/r"}
steps:
  - {id: a, type: shell, run: 'echo "$FACTORY_VAR_GITHUB_REPO"; ls -A | wc -l'}
`);
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.output.split("\n").map((l) => l.trim())).toEqual(["o/r", "0", ""]);
    expect(s.workdir).toBe(join(s.runDir, "workspace"));
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

describe("run source and briefs", () => {
  const yaml = "name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'test -f ok'}\n";
  const runJson = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as { source?: string; status: string };

  it("saves who started the run, keeps it on resume, and leaves it out when unknown", async () => {
    const ui = await runFlow(parseFlow(yaml), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, source: "ui" });
    expect(ui.status).toBe("failed");
    expect(runJson(ui.runDir).source).toBe("ui");
    writeFileSync(join(repo, "ok"), "");
    const { resumeRun } = await import("../src/engine/runner.js");
    expect((await resumeRun({ runId: ui.runId, runsDir: join(tmp, "runs"), claudeBin })).status).toBe("succeeded");
    expect(runJson(ui.runDir).source).toBe("ui");
    const none = await runFlow(parseFlow(yaml), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin });
    expect("source" in runJson(none.runDir)).toBe(false);
  });

  it("an interrupted run ends when run.json was last written, not when it started", async () => {
    const { Scheduler } = await import("../src/queue/scheduler.js");
    const { ConfigSchema } = await import("../src/config.js");
    const runsDir = join(tmp, "runs");
    const s = await runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, runId: "20260101-000000-cccc" });
    const file = join(s.runDir, "run.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "running", reason: undefined, finishedAt: undefined, startedAt: "2020-01-01T00:00:00.000Z" }));
    // Whole seconds: file systems may round sub-second modification times by a millisecond.
    const written = new Date(Math.floor((Date.now() - 86_400_000) / 1000) * 1000);
    utimesSync(file, written, written);
    const sched = new Scheduler({ runsDir, config: () => ConfigSchema.parse({}) });
    expect(sched.briefs()[0]).toMatchObject({ status: "failed", finishedAt: written.toISOString() });
    expect(sched.get(s.runId)).toMatchObject({ status: "failed", finishedAt: written.toISOString() });
  });

  it("lists briefs newest first, sees a rewritten run, and skips a broken run.json", async () => {
    const { listRunBriefs } = await import("../src/engine/state.js");
    const runsDir = join(tmp, "runs");
    const a = await runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, runId: "20260101-000000-aaaa", source: "cli" });
    const b = await runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, runId: "20260102-000000-bbbb" });
    expect(listRunBriefs(runsDir).map((x) => [x.runId, x.status, x.source])).toEqual([[b.runId, "failed", undefined], [a.runId, "failed", "cli"]]);
    const file = join(a.runDir, "run.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "succeeded", reason: "now a longer text so the size changes" }));
    expect(listRunBriefs(runsDir).find((x) => x.runId === a.runId)!.status).toBe("succeeded");
    writeFileSync(file, "{ broken");
    expect(listRunBriefs(runsDir).map((x) => x.runId)).toEqual([b.runId]);
  });
});

describe("effectiveVars and frozen variables", () => {
  const flowOf = (workspace: string, vars = "") => parseFlow(`name: t\nworkspace: ${workspace}\n${vars}steps:\n  - id: a\n    type: shell\n    run: "true"\n`);
  const folderConfig = (vars: string) => {
    execFileSync("mkdir", ["-p", join(repo, ".claude-factory")]);
    writeFileSync(join(repo, ".claude-factory", "config.yaml"), `vars:\n${vars}`);
  };

  it("given beats the folder, and the folder beats the flow default", async () => {
    const { effectiveVars } = await import("../src/engine/runner.js");
    folderConfig("  a: folder\n  b: folder\n");
    const flow = flowOf("inplace", "vars:\n  a: flow\n  b: flow\n  c: flow\n");
    expect(effectiveVars(flow, repo, { a: "given" })).toEqual({ a: "given", b: "folder", c: "flow" });
  });

  it("ignores the folder config for an empty workspace", async () => {
    const { effectiveVars } = await import("../src/engine/runner.js");
    folderConfig("  a: folder\n");
    expect(effectiveVars(flowOf("empty", "vars:\n  a: flow\n"), repo)).toEqual({ a: "flow" });
  });

  it("counts a broken folder config as empty and logs it", async () => {
    const { effectiveVars } = await import("../src/engine/runner.js");
    execFileSync("mkdir", ["-p", join(repo, ".claude-factory")]);
    writeFileSync(join(repo, ".claude-factory", "config.yaml"), "vars: [1, 2]\n");
    const lines: string[] = [];
    expect(effectiveVars(flowOf("inplace", "vars:\n  a: flow\n"), repo, {}, (m) => lines.push(m))).toEqual({ a: "flow" });
    expect(lines.join("\n")).toContain("ignoring repo config");
  });

  it("runFlow with frozenVars does not read the folder config", async () => {
    folderConfig("  a: folder\n");
    const s = await runFlow(flowOf("inplace"), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, vars: { b: "given" }, frozenVars: true });
    expect(s.vars).toEqual({ b: "given" });
    const s2 = await runFlow(flowOf("inplace"), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, vars: { b: "given" } });
    expect(s2.vars).toEqual({ a: "folder", b: "given" });
  });
});

describe("Scheduler owner, frozen variables and run ids", () => {
  const shell = () => parseFlow(`name: t\nworkspace: empty\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n`);
  const idle = async () => ({ ...(await import("../src/config.js")).ConfigSchema.parse({}), concurrency: 0 });

  it("knows the owner of a pending job, also after a restart, and saves it in run.json", async () => {
    const { Scheduler } = await import("../src/queue/scheduler.js");
    const { ConfigSchema } = await import("../src/config.js");
    const runsDir = join(tmp, "runs");
    const queueFile = join(tmp, "queue.json");
    const stopped = await idle();
    const a = new Scheduler({ runsDir, queueFile, config: () => stopped });
    const id = a.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} }, { source: "ui", owner: "user-1" });
    const bare = a.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} }, { source: "ui" });
    expect(a.isQueued(id)).toBe(true);
    expect(a.ownerOf(id)).toBe("user-1");
    expect(a.ownerOf(bare)).toBeUndefined();
    expect(JSON.parse(readFileSync(queueFile, "utf8"))[0].owner).toBe("user-1");
    const b = new Scheduler({ runsDir, queueFile, config: () => ConfigSchema.parse({}) });
    expect(b.ownerOf(id)).toBe("user-1");
    await b.wait(id);
    await b.idle();
    expect(JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8")).owner).toBe("user-1");
    expect(b.ownerOf(id)).toBe("user-1");
    expect(JSON.parse(readFileSync(join(runsDir, bare, "run.json"), "utf8")).owner).toBeUndefined();
    expect(b.ownerOf(bare)).toBeUndefined();
    expect(b.briefs().find((x) => x.runId === id)?.owner).toBe("user-1");
  });

  it("answers undefined and does not throw for a run.json that is broken or has no string owner", async () => {
    const { Scheduler } = await import("../src/queue/scheduler.js");
    const { ConfigSchema } = await import("../src/config.js");
    const runsDir = join(tmp, "runs");
    const sched = new Scheduler({ runsDir, config: () => ConfigSchema.parse({}) });
    const s = await runFlow(shell(), { task: "t", repo, runsDir, claudeBin, runId: "20260101-000000-dddd", owner: "u" });
    const file = join(s.runDir, "run.json");
    expect(sched.ownerOf(s.runId)).toBe("u");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), owner: 5 }));
    expect(sched.ownerOf(s.runId)).toBeUndefined();
    writeFileSync(file, "{ broken");
    expect(sched.ownerOf(s.runId)).toBeUndefined();
    expect(sched.ownerOf("nope")).toBeUndefined();
  });

  it("a queued run keeps the variables it was queued with when the folder config changes", async () => {
    const { Scheduler } = await import("../src/queue/scheduler.js");
    const { ConfigSchema } = await import("../src/config.js");
    const { effectiveVars } = await import("../src/engine/runner.js");
    const runsDir = join(tmp, "runs");
    const queueFile = join(tmp, "queue.json");
    const flow = parseFlow(`name: t\nworkspace: inplace\nsteps:\n  - id: a\n    type: shell\n    run: "true"\n`);
    const stopped = await idle();
    const a = new Scheduler({ runsDir, queueFile, config: () => stopped });
    const id = a.submit({ kind: "run", flow, task: "t", repo, vars: effectiveVars(flow, repo, { x: "1" }), frozenVars: true }, { owner: "u" });
    execFileSync("mkdir", ["-p", join(repo, ".claude-factory")]);
    writeFileSync(join(repo, ".claude-factory", "config.yaml"), "vars:\n  github_repo: other/repo\n");
    const b = new Scheduler({ runsDir, queueFile, config: () => ConfigSchema.parse({}) });
    await b.wait(id);
    await b.idle();
    expect(JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8")).vars).toEqual({ x: "1" });
  });

  it("never gives the same run id twice", async () => {
    const { Scheduler } = await import("../src/queue/scheduler.js");
    const runsDir = join(tmp, "runs");
    const stopped = await idle();
    const ids = ["x1", "x1", "x2"];
    const sched = new Scheduler({ runsDir, config: () => stopped, newId: () => ids.shift()! });
    const one = sched.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} }, { owner: "a" });
    const two = sched.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} }, { owner: "b" });
    expect([one, two]).toEqual(["x1", "x2"]);
    expect([sched.ownerOf(one), sched.ownerOf(two)]).toEqual(["a", "b"]);
  });

  it("skips an id whose folder exists, and gives up when every id is taken", async () => {
    const { Scheduler } = await import("../src/queue/scheduler.js");
    const runsDir = join(tmp, "runs");
    execFileSync("mkdir", ["-p", join(runsDir, "old")]);
    const stopped = await idle();
    const ids = ["old", "new"];
    const sched = new Scheduler({ runsDir, config: () => stopped, newId: () => ids.shift()! });
    expect(sched.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} })).toBe("new");
    const same = new Scheduler({ runsDir: join(tmp, "runs2"), config: () => stopped, newId: () => "same" });
    same.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} });
    expect(() => same.submit({ kind: "run", flow: shell(), task: "t", repo, vars: {} })).toThrow(/free run id/);
  });
});
