import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { WatcherManager } from "../src/queue/watchers.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// "If no human is needed, the next step happens right away": when a run ends, the watchers of its
// repository check at once instead of at their next interval.
describe("next story starts right away", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => {
    gh = fakeGithub();
    // These tests only need a run that finishes: one shell step (a full flow is slow on a busy machine).
    writeFileSync(join(gh.tmp, ".claude-factory", "flows", "tiny.yaml"), "name: tiny\nworkspace: empty\nsteps:\n  - {id: done, type: shell, run: echo done}\n");
    process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
  });
  afterEach(() => gh.restore());

  it("a finished run makes the watchers of its repository check immediately", async () => {
    const REPO = "acme/app";
    const config = ConfigSchema.parse({
      protected_branches: ["main"],
      watchers: [{ id: "w", github_repo: REPO, label: "Factory_go", flow: "tiny", every: "1h",
        vars: { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" } }],
    });
    const DONE = JSON.stringify([
      { number: 4, title: "Story 4", labels: [{ name: "Factory_done" }], state: "CLOSED", body: "" },
      { number: 5, title: "Story 5", labels: [{ name: "Factory_go" }], state: "OPEN", body: "### Depends on\n#4" },
    ]);
    let manager!: WatcherManager;
    const scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin,
      onFinished: (s) => {
        // #4 finished: GitHub now shows it done (in reality its labels are set before the check runs).
        if (s.vars.issue === "4") process.env.FAKE_GH_ISSUES = DONE;
        if (s.vars?.github_repo) manager.kickRepo(s.vars.github_repo, 0);
      } });
    manager = new WatcherManager({ scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, config: () => config, log: () => {} });
    // #5 depends on #4, which is being built; the watcher checks only every hour.
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "Story 4", labels: [{ name: "Factory_go" }], state: "OPEN", body: "" },
      { number: 5, title: "Story 5", labels: [{ name: "Factory_go" }], state: "OPEN", body: "### Depends on\n#4" },
    ]);
    manager.sync();
    // #5 must start right after #4 finishes — not an hour later at the next interval.
    const deadline = Date.now() + 60_000;
    while (!scheduler.list().some((s) => s.vars.issue === "5") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(scheduler.list().some((s) => s.vars.issue === "5")).toBe(true);
    manager.stopAll();
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  }, 60_000);

  it("never starts an issue again because GitHub's issue list lags behind its new label", async () => {
    const REPO = "acme/app";
    const config = ConfigSchema.parse({
      protected_branches: ["main"],
      watchers: [{ id: "w", github_repo: REPO, label: "Factory_go", flow: "tiny", every: "1h",
        status_labels: { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" },
        vars: { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", docs_required: "docs/CHANGELOG.md" } }],
    });
    let manager!: WatcherManager;
    const scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin,
      onFinished: (s) => {
        // The issue got its new label (fresh view), but the search list still shows it without.
        process.env.FAKE_GH_FRESH = JSON.stringify([{ number: 4, state: "OPEN", labels: [{ name: "Factory_go" }, { name: "Factory_ERROR" }] }]);
        if (s.vars?.github_repo) manager.kickRepo(s.vars.github_repo, 0);
      } });
    manager = new WatcherManager({ scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, config: () => config, log: () => {} });
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "Story 4", labels: [{ name: "Factory_go" }], state: "OPEN", body: "" }]);
    manager.sync();
    const deadline = Date.now() + 60_000;
    while (!scheduler.list().some((s) => s.vars.issue === "4" && s.status !== "running") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 2000)); // a few kicked checks happen
    expect(scheduler.list().filter((s) => s.vars.issue === "4")).toHaveLength(1);
    manager.stopAll();
    await scheduler.idle();
    delete process.env.FAKE_GH_FRESH;
    await new Promise((r) => setTimeout(r, 300));
  }, 60_000);
});
