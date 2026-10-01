import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadRun } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { MARKER_NAME, migrateDataHome, NOTE_NAME, repairWorktrees, type MigrateOptions } from "../src/home.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: "pipe" });
const env = {} as NodeJS.ProcessEnv;

const FLOW = `
name: wt
workspace: worktree
steps:
  - {id: s1, type: shell, run: pwd}
  - {id: gate, type: approval, message: "ok?"}
  - {id: s2, type: shell, run: 'echo "$FACTORY_OUT_S1"; pwd'}
`;

let tmp: string;
let from: string;
let to: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "home-move-"));
  from = join(tmp, ".claude-factory");
  to = join(tmp, ".spaghetti-code-foundry");
  mkdirSync(join(from, "runs"), { recursive: true });
  writeFileSync(join(from, "config.yaml"), "concurrency: 2\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeRepo(name: string) {
  const repo = join(tmp, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return repo;
}

/** A run in a worktree of a new repo, waiting at the approval. */
async function waitingRun(name: string) {
  const repo = makeRepo(name);
  const s = await runFlow(parseFlow(FLOW), { task: "t", repo, runsDir: join(from, "runs"), claudeBin });
  expect(s.status).toBe("waiting");
  return { repo, run: s };
}

/** A second waiting run in the same repo. */
async function makeSecondRun(repo: string) {
  const s = await runFlow(parseFlow(FLOW), { task: "t", repo, runsDir: join(from, "runs"), claudeBin });
  expect(s.status).toBe("waiting");
  return s;
}

const migrate = (o: Partial<MigrateOptions> = {}) =>
  migrateDataHome({ from, to, env, freeBytes: () => 1e15, sizeBytes: () => 1000, ...o });
const worktrees = (repo: string) => git(repo, "worktree", "list", "--porcelain");
const real = (p: string) => realpathSync(p);
const leftovers = () => readdirSync(tmp).filter((n) => n.includes(".migrating-"));

describe("account files in the move", () => {
  it("copies users.json and sessions.json byte for byte and keeps their mode", () => {
    const body = JSON.stringify({ version: 1, users: [{ name: `${from}/x` }] });
    for (const f of ["users.json", "sessions.json"]) writeFileSync(join(from, f), body, { mode: 0o600 });
    writeFileSync(join(from, "queue.json"), body);
    mkdirSync(join(from, "runs", "r9"), { recursive: true });
    writeFileSync(join(from, "runs", "r9", "users.json"), body);
    writeFileSync(join(from, "runs", "r9", "run.json"), JSON.stringify({ runId: "r9", status: "succeeded" }));
    expect(migrate().status).toBe("migrated");
    for (const f of ["users.json", "sessions.json"]) {
      expect(readFileSync(join(to, f))).toEqual(Buffer.from(body));
      expect(statSync(join(to, f)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(to, "queue.json"), "utf8")).toContain(to);
    expect(readFileSync(join(to, "runs", "r9", "users.json"), "utf8")).toContain(to);
  });
});

describe("moving waiting runs with git worktrees", () => {
  it("repairs the worktree, so a waiting run is approved and resumed in the new folder", async () => {
    const { repo, run } = await waitingRun("repo");
    const r = migrate();
    expect(r.status).toBe("migrated");
    expect(r.warnings).toEqual([]);
    const newWork = join(to, "runs", run.runId, "workspace");
    const out = await resumeRun({ runsDir: join(to, "runs"), runId: run.runId, decision: { approved: true, by: "t" }, claudeBin });
    expect(out.status).toBe("succeeded");
    expect(out.runDir).toBe(join(to, "runs", run.runId));
    const lines = out.history.at(-1)!.output.split("\n").filter(Boolean);
    expect(lines).toEqual([real(newWork), real(newWork)]);
    const list = worktrees(repo);
    expect(list).toContain(`worktree ${real(newWork)}`);
    expect(list).not.toContain(real(join(from, "runs", run.runId, "workspace")));
    expect(JSON.parse(readFileSync(join(to, MARKER_NAME), "utf8")).state).toBe("done");
  });

  it.each([
    ["the 2nd repo fails", 1],
    ["the 1st repo fails", 0],
  ])("puts everything back when a repair fails (%s)", async (_n, failIndex) => {
    const a = await waitingRun("repo-a");
    const b = await waitingRun("repo-b");
    const repos = [a.repo, b.repo];
    const r = migrate({
      repair: (repo, paths) => {
        if (repo === repos[failIndex] && paths.every((p) => p.startsWith(to))) throw new Error("repair broke");
        repairWorktrees(repo, paths);
      },
    });
    expect(r.status).toBe("failed");
    expect(r.home).toBe(from);
    expect(existsSync(to)).toBe(false);
    expect(leftovers()).toEqual([]);
    for (const { repo, run } of [a, b]) {
      expect(worktrees(repo)).toContain(`worktree ${real(join(from, "runs", run.runId, "workspace"))}`);
    }
    const out = await resumeRun({ runsDir: join(from, "runs"), runId: a.run.runId, decision: { approved: true }, claudeBin });
    expect(out.status).toBe("succeeded");
  });

  it("rolls back a path that git changed before the repair failed", async () => {
    const a = await waitingRun("repo");
    const b = await makeSecondRun(a.repo);
    let calls = 0;
    const r = migrate({
      repair: (repo, paths) => {
        if (paths.every((p) => p.startsWith(to))) {
          repairWorktrees(repo, paths);
          if (++calls === 2) throw new Error("failed after repairing");
        } else repairWorktrees(repo, paths);
      },
    });
    expect(r.status).toBe("failed");
    expect(existsSync(to)).toBe(false);
    const list = worktrees(a.repo);
    for (const run of [a.run, b]) expect(list).toContain(`worktree ${real(join(from, "runs", run.runId, "workspace"))}`);
  });

  it("keeps the new folder and shows the manual command when the rollback fails too", async () => {
    await waitingRun("repo-a");
    await waitingRun("repo-b");
    // The repos are repaired in the order of their run folders (random ids): the 2nd repair fails.
    let repaired = 0;
    const r = migrate({
      repair: (repo, paths) => {
        if (paths.every((p) => p.startsWith(from)) || repaired >= 1) throw new Error("repair broke");
        repairWorktrees(repo, paths);
        repaired++;
      },
    });
    expect(r.status).toBe("migrated");
    expect(existsSync(to)).toBe(true);
    expect(r.warnings.join("\n")).toContain("worktree repair");
    expect(readFileSync(join(from, NOTE_NAME), "utf8")).toContain("worktree repair");
  });

  describe("an interrupted move", () => {
    async function interrupted(repairedFirst: boolean) {
      const a = await waitingRun("repo-a");
      const b = await waitingRun("repo-b");
      expect(migrate().status).toBe("migrated");
      // as if killed after the rename: marker back to "repairing", no note, worktrees at the old paths
      const marker = JSON.parse(readFileSync(join(to, MARKER_NAME), "utf8"));
      writeFileSync(join(to, MARKER_NAME), JSON.stringify({ ...marker, state: "repairing" }));
      rmSync(join(from, NOTE_NAME));
      for (const x of repairedFirst ? [b] : [a, b]) repairWorktrees(x.repo, [join(from, "runs", x.run.runId, "workspace")]);
      return { a, b };
    }
    const noCopy = () => { throw new Error("must not copy"); };

    it.each([true, false])("is finished on the next start (first repo already done: %s)", async (first) => {
      const { a, b } = await interrupted(first);
      const r = migrate({ copy: noCopy });
      expect(r.status).toBe("migrated");
      for (const x of [a, b]) expect(worktrees(x.repo)).toContain(`worktree ${real(join(to, "runs", x.run.runId, "workspace"))}`);
      expect(JSON.parse(readFileSync(join(to, MARKER_NAME), "utf8")).state).toBe("done");
      expect(existsSync(join(from, NOTE_NAME))).toBe(true);
    });

    it("deletes nothing when finishing fails, and a later start finishes it", async () => {
      await interrupted(false);
      const failing = migrate({ copy: noCopy, repair: () => { throw new Error("nope"); } });
      expect(failing).toMatchObject({ status: "failed", reason: "incomplete", home: to });
      expect(JSON.parse(readFileSync(join(to, MARKER_NAME), "utf8")).state).toBe("repairing");
      expect(migrate({ copy: noCopy }).status).toBe("migrated");
    });
  });

  it("does not fail the move for a run whose worktree admin folder is gone; it names the run", async () => {
    const { repo, run } = await waitingRun("repo");
    rmSync(join(repo, ".git", "worktrees"), { recursive: true, force: true });
    const r = migrate();
    expect(r.status).toBe("migrated");
    expect(r.warnings.join("\n")).toContain(run.runId);
  });
});

describe("watchers across the move", () => {
  let gh: ReturnType<typeof fakeGithub>;
  const config = ConfigSchema.parse({ protected_branches: [], concurrency: 2 });
  afterEach(() => gh?.restore());

  it("keeps run history, waiting runs, labels and dependency state", async () => {
    gh = fakeGithub();
    const old = join(gh.tmp, ".claude-factory");
    const nw = join(gh.tmp, ".spaghetti-code-foundry");
    mkdirSync(join(old, "runs"), { recursive: true });
    const make = (runsDir: string) => {
      const scheduler = new Scheduler({ runsDir, config: () => config, claudeBin });
      const watcher = new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" } }), {
        scheduler, runsDir, repo: gh.tmp, log: () => {},
      });
      return { scheduler, watcher };
    };
    const settle = async (s: Scheduler) => {
      await s.idle();
      await new Promise((r) => setTimeout(r, 300));
    };
    const issue = (number: number, labels: string[] = [], body = "") => ({
      number, title: `issue ${number}`, state: "OPEN", body, labels: [{ name: "claude-factory" }, ...labels.map((name) => ({ name }))],
    });

    const first = make(join(old, "runs"));
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(5)]);
    await first.watcher.tick();
    await settle(first.scheduler);
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    process.env.FAKE_GH_ISSUES = JSON.stringify([issue(5, ["factory:done"]), issue(4)]);
    await first.watcher.tick();
    await settle(first.scheduler);
    const run4 = first.scheduler.list().find((s) => s.vars.issue === "4")!;
    expect(run4.status).toBe("stopped");
    const run5 = first.scheduler.list().find((s) => s.vars.issue === "5")!;
    expect(run5.status).toBe("succeeded");

    expect(migrateDataHome({ from: old, to: nw, env, freeBytes: () => 1e15, sizeBytes: () => 1000 }).status).toBe("migrated");

    // A new scheduler and watcher on the new folder; issue 4 is answered now.
    delete process.env.FAKE_PLAN;
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      issue(4, ["factory:needs-info"]),
      issue(5, ["factory:working"]),
      issue(7, [], "Do it.\n\n### Depends on\n#4\n\n### Notes\nnone"),
    ]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "questions <!-- claude-factory run=x -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" },
    ] });
    const second = make(join(nw, "runs"));
    await second.watcher.tick();
    await settle(second.scheduler);
    await second.watcher.tick();
    await settle(second.scheduler);
    const runs = second.scheduler.list();
    const resumed = runs.filter((s) => s.vars.issue === "4");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.runId).toBe(run4.runId);
    expect(resumed[0]!.resumes).toBe(1);
    expect(runs.filter((s) => s.vars.issue === "5")).toHaveLength(1);
    expect(loadRun(join(nw, "runs"), run5.runId)!.runDir).toBe(join(nw, "runs", run5.runId));
    expect(gh.ghLog()).toMatch(/gh issue edit 5 .*--add-label factory:done/);
    expect(second.watcher.status.holds!.map((h) => h.reason).join("\n")).toMatch(/waits for #4/);
    expect(runs.some((s) => s.vars.issue === "7")).toBe(false);
  });
});
