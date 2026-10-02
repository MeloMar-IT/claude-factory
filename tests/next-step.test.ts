import { describe, expect, it } from "vitest";
import { WatcherSchema } from "../src/config.js";
import type { RunSummary } from "../src/engine/state.js";
import { statusName } from "../src/words.js";
import { briefFailure, COMMENT_KINDS, REPORT_KINDS, reportFirst, commentFirst, commentText, firstLine, countQuestions, nextStep, nextStepEnv, releaseAtFor, releaseWatchersFor, runClosedIssue, runNextStep, trackingWatcher, type NextKind, type NextStep } from "../src/next-step.js";

const run = (over: Partial<RunSummary> = {}) =>
  ({
    runId: "r1", flow: "github-issue", task: "do it", status: "succeeded", startedAt: "2026-10-01T08:00:00Z", finishedAt: "2026-10-01T08:10:00Z",
    vars: { github_repo: "acme/app", issue: "7" }, history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} },
    runDir: "/tmp/none", ...over,
  }) as unknown as RunSummary;

const watched = { watched: true, failedLabel: "factory:failed" };
const ISSUE = "https://github.com/acme/app/issues/7";

describe("comment sentences", () => {
  const base = { repo: "acme/app", issue: 7, title: "T", runId: "r1" };
  const data = { watched: true, issueUrl: ISSUE, failedLabel: "factory:failed" };

  it("has exactly the FACTORY_NEXT_ and FACTORY_FIRST_ variables, equal to the record", () => {
    const env = nextStepEnv();
    expect(Object.keys(env).sort()).toEqual([
      "FACTORY_FIRST_APPROVAL", "FACTORY_FIRST_APPROVE_PLAN", "FACTORY_FIRST_APPROVE_SPLIT", "FACTORY_FIRST_DRAFT", "FACTORY_FIRST_INFO", "FACTORY_FIRST_LOOK",
      "FACTORY_FIRST_MERGE_PR", "FACTORY_FIRST_MERGE_RELEASE", "FACTORY_FIRST_NOTHING", "FACTORY_FIRST_OPEN_PR", "FACTORY_FIRST_PLANNER_QUESTIONS", "FACTORY_FIRST_QUESTIONS",
      "FACTORY_FIRST_SHIPS", "FACTORY_FIRST_START_CODING", "FACTORY_FIRST_START_PARTS",
      "FACTORY_NEXT_APPROVAL", "FACTORY_NEXT_APPROVE_PLAN", "FACTORY_NEXT_APPROVE_SPLIT", "FACTORY_NEXT_PLANNER_QUESTIONS", "FACTORY_NEXT_QUESTIONS",
    ]);
    expect(env.FACTORY_FIRST_NOTHING).toBe(firstLine(nextStep("running")));
    for (const k of COMMENT_KINDS) {
      const f = env[`FACTORY_FIRST_${k.toUpperCase()}`]!;
      expect(f).toBe(commentFirst(k));
      expect(f).toBe(firstLine(nextStep(k, base, data)));
    }
    for (const [k, v] of Object.entries(env)) if (k.startsWith("FACTORY_FIRST_")) expect(v).toMatch(/^\*\*[^\n\\`$"]*(?:\.|\*\*)$/);
    for (const k of REPORT_KINDS) expect(env[`FACTORY_FIRST_${k.toUpperCase()}`]).toBe(reportFirst(k));
    for (const k of COMMENT_KINDS) {
      const v = env[`FACTORY_NEXT_${k.toUpperCase()}`]!;
      expect(v).toBe(nextStep(k, base, data).text);
      expect(v).toMatch(/^[^\n]*\.$/);
      expect(v).not.toMatch(/[\\`$"_*]/);
    }
  });

  it("words the first line", () => {
    expect(commentFirst("approve_plan")).toBe("**What you need to do:** Reply /approve or /reject.");
    expect(commentFirst("planner_questions")).toBe("**What you need to do:** Answer the questions.");
    expect(nextStepEnv().FACTORY_FIRST_NOTHING).toBe("**Nothing needed from you** — it is being worked on.");
  });

  it.each([
    ["info", "**Nothing needed from you**"],
    ["merge_pr", "**What you need to do:** Review and merge the pull request."],
    ["open_pr", "**What you need to do:** Open a pull request from the branch."],
    ["start_coding", "**What you need to do:** Add the code label to start coding."],
    ["ships", "**Nothing needed from you** — it goes to main with the release pull request."],
    ["look", "**What you need to do:** Look at the changes."],
    ["merge_release", "**What you need to do:** Merge the release pull request when you like."],
    ["draft", "**What you need to do:** Fix the failed checks; the release pull request stays a draft until they pass."],
    ["start_parts", "**What you need to do:** Start the new issues when you want them built."],
  ] as const)("words the report first line %s", (kind, text) => {
    expect(reportFirst(kind)).toBe(text);
  });

  it("names the replies", () => {
    expect(commentText("questions")).toContain("/defaults");
    for (const k of ["approve_plan", "approve_split", "approval"] as const) {
      expect(commentText(k)).toContain("/approve");
      expect(commentText(k)).toContain("/reject");
    }
    expect(commentText("approval")).not.toContain("run page");
  });

  it("matches the real run first line for a waiting plan, a split and questions", () => {
    const waiting = (step: string) => run({ status: "waiting", state: { next: step, steps: {}, visits: {} }, waiting: { stepId: step, message: "m" } } as Partial<RunSummary>);
    expect(firstLine(runNextStep(waiting("approve_plan"), { watched: true }))).toBe(commentFirst("approve_plan"));
    expect(firstLine(runNextStep(waiting("approve_split"), { watched: true }))).toBe(commentFirst("approve_split"));
    expect(firstLine(runNextStep(run({ status: "running" }), watched))).toBe(nextStepEnv().FACTORY_FIRST_NOTHING);
    expect(runNextStep(waiting("approve_plan"), { watched: true }).text).toBe(commentText("approve_plan"));
    expect(runNextStep(waiting("approve_split"), { watched: true }).text).toBe(commentText("approve_split"));
    for (const step of ["send_back", "ask_for_info"]) {
      const r = run({ status: "stopped", reason: `stopped at step "${step}" — needs attention` });
      expect(runNextStep(r, { watched: true }).text).toBe(commentText("planner_questions"));
      expect(firstLine(runNextStep(r, { watched: true }))).toBe(commentFirst("planner_questions"));
    }
  });

  it("differs from the record only by the count and the message", () => {
    for (const k of ["questions", "planner_questions"] as const) {
      expect(nextStep(k, base, { ...data, questions: 3 }).text).toBe(commentText(k).replace("the questions", "3 questions"));
    }
    expect(nextStep("approval", base, { ...data, message: "Push the changes for acme/app#7?" }).text).toBe(
      commentText("approval").replace("It waits for your approval", "It waits for your approval: Push the changes for acme/app#7"),
    );
  });
});

describe("runClosedIssue", () => {
  const step = (id: string, ok = true, output = "") => ({ id, ok, output }) as never;
  const flowDef = (cmd: string) => ({ steps: [{ id: "report", type: "shell", run: cmd }] }) as never;
  it("is true when the run closed the issue itself", () => {
    expect(runClosedIssue(run({ history: [step("report", true, "x\nclosed #12")] }))).toBe(true);
    expect(runClosedIssue(run({ history: [step("build/merge")] }))).toBe(true);
    expect(runClosedIssue(run({ history: [step("create_split")] }))).toBe(true);
    expect(runClosedIssue(run({ state: { next: "create_split", steps: {}, visits: {} } }))).toBe(true);
    expect(runClosedIssue(run({ flowDef: flowDef("gh issue close 12"), state: { next: "report", steps: {}, visits: {} } }))).toBe(true);
  });
  it("is false otherwise", () => {
    expect(runClosedIssue(run({ history: [step("report", true, "commented")] }))).toBe(false);
    expect(runClosedIssue(run({ history: [step("report", false, "closed #12")] }))).toBe(false);
    expect(runClosedIssue(run({ flowDef: flowDef("gh issue comment 12"), state: { next: "report", steps: {}, visits: {} } }))).toBe(false);
    expect(runClosedIssue(run({ history: [step("plan")] }))).toBe(false);
    expect(runClosedIssue(undefined)).toBe(false);
    expect(runClosedIssue(run())).toBe(false);
  });
});

describe("next-step records, one per kind", () => {
  const base = { repo: "acme/app", issue: 7, title: "T", runId: "r1" };
  const data = { watched: true, issueUrl: ISSUE, failedLabel: "factory:failed" };
  const cases: [NextKind, Parameters<typeof nextStep>[2], string, string, string][] = [
    ["questions", { ...data, questions: 3 }, "You", "Answer 3 questions", ISSUE],
    ["planner_questions", data, "You", "Answer the questions", ISSUE],
    ["approve_plan", data, "You", "Reply /approve or /reject", ISSUE],
    ["approve_split", data, "You", "Reply /approve or /reject", ISSUE],
    ["approval", { message: "Deploy now" }, "You", "Approve or reject it on the run page", "#/runs/r1"],
    ["dependency", { ...data, blockers: [{ issue: 3 }] }, "Another story", "Nothing — it continues by itself", ISSUE],
    ["one_at_a_time", { ...data, blockingRun: "r0" }, "Another story", "Nothing — it continues by itself", "#/runs/r0"],
    ["area_lock", { areaWait: { runId: "r0", areas: "src" } }, "Another story", "Nothing — it continues by itself", "#/runs/r0"],
    ["usage_limit", data, "A time limit", "Nothing — it continues by itself", ISSUE],
    ["daily_budget", data, "A time limit", "Nothing — it continues by itself", ISSUE],
    ["release", { ...data, pr: { number: 99, url: "https://github.com/acme/app/pull/99" } }, "You", "Merge the release pull request #99", "https://github.com/acme/app/pull/99"],
    ["failed", data, "Something is wrong", "Look at the steps and the log on the run page, then remove the `factory:failed` label to start over, or resume the run on its page to continue at the failed step", ISSUE],
    ["restart", {}, "Foundry", "Nothing — it continues by itself", "#/watchers"],
    ["watcher_error", { reason: "gh failed" }, "Something is wrong", "Look at Error details on the Watchers page", "#/watchers"],
    ["closed_elsewhere", {}, "You", "Cancel the run if the work is no longer wanted", "#/runs/r1"],
    ["watcher_stale", { lastCheck: "2026-10-01T11:20:00Z", timeZone: "UTC" }, "Something is wrong", "Press Check now on the Watchers page", "#/watchers"],
    ["running", data, "Foundry", "Nothing — it continues by itself", ISSUE],
    ["queued", {}, "Foundry", "Nothing — it continues by itself", "#/runs/r1"],
    ["checking", data, "Foundry", "Nothing — it continues by itself", ISSUE],
    ["starting", data, "Foundry", "Nothing — it continues by itself", ISSUE],
    ["interrupted", data, "Foundry", "Nothing — it continues by itself", ISSUE],
    ["cancelled", data, "Foundry", "Nothing — it continues by itself", ISSUE],
    ["stopped", {}, "You", "Look at the run and resume it", "#/runs/r1"],
    ["superseded", {}, "Foundry", "Nothing — a newer run took over", "#/runs/r1"],
    ["done", data, "Foundry", "Nothing — it is done", ISSUE],
  ];
  it.each(cases)("%s", (kind, d, who, action, url) => {
    const n = nextStep(kind, base, d);
    expect(n.kind).toBe(kind);
    expect(n.who).toBe(who);
    expect(n.action).toBe(action);
    expect(n.where.url).toBe(url);
    expect(n.user).toBe("");
    expect(n).toMatchObject({ repo: "acme/app", issue: 7, title: "T", runId: "r1" });
  });

  it.each(cases)("first line of %s", (kind, d, who, action) => {
    const line = firstLine(nextStep(kind, base, d));
    expect(line).not.toMatch(/\n|Nothing — /);
    if (who === "You" || who === "Something is wrong") expect(line).toBe(`**What you need to do:** ${action}.`);
    else {
      expect(line.startsWith("**Nothing needed from you** — ")).toBe(true);
      expect(line.endsWith(".")).toBe(true);
    }
  });

  it("words the first line for spot checks and odd records", () => {
    expect(firstLine(nextStep("questions", base, { ...data, questions: 3 }))).toMatch(/Answer 3 questions\.$/);
    const failed = firstLine(nextStep("failed", base, data));
    expect(failed.split("`factory:failed`")).toHaveLength(2);
    expect(failed).toMatch(/[^.]\.$/);
    expect(firstLine(nextStep("release", base, { pr: { number: 99 } }))).toBe("**What you need to do:** Merge the release pull request #99.");
    expect(firstLine(nextStep("release", base, { releaseAt: "17:00" }))).toBe("**Nothing needed from you** — it is finished and waits for the 17:00 release.");
    expect(firstLine(nextStep("dependency", base, { blockers: [{ issue: 3 }] }))).toBe("**Nothing needed from you** — #7 waits for #3, which is to be done.");
    expect(firstLine({ who: "You", action: "Do it now.\n", why: "" })).toBe("**What you need to do:** Do it now.");
    expect(firstLine({ who: "Foundry", action: "", why: "" })).toBe("**Nothing needed from you**");
  });

  it("carries status and help from the glossary, kind first", () => {
    for (const [kind, d] of cases) {
      const n = nextStep(kind, base, d);
      expect(n.status, kind).toBe(statusName(kind, { blockers: (d?.blockers ?? []).map((b) => b.issue) }));
      expect(n.help, kind).toMatch(/^[^.!?]+[.!?] [^.!?]+[.!?]$/);
    }
    expect(Object.keys(nextStep("done"))[0]).toBe("kind");
  });

  it("words the release by pull request or schedule", () => {
    expect(runNextStep(run(), { ...watched, releaseAt: "17:00" }).status).toBe("in develop (ships with the 17:00 release)");
    expect(nextStep("release", base, { pr: { number: 99 }, releaseAt: "17:00" }).status).toBe("waiting for you — release pull request");
    const stopped = runNextStep(run({ status: "stopped", reason: 'stopped at step "wait_for_merge"' }));
    expect(stopped.status).toBe("waiting for you — release pull request");
    expect(stopped.action).toBe("Merge the release pull request");
    const r = nextStep("release", base, { pr: { number: 99, url: "u" } });
    for (const t of [r.why, r.action, r.where.label]) {
      expect(t).toContain("elease pull request");
      expect(t).not.toContain("aily pull request");
    }
  });

  it("names the release in a dependency chain", () => {
    const dep = (b: NextStep) => nextStep("dependency", { issue: 89 }, { blockers: [{ issue: 88, next: b }] }).why;
    expect(dep(nextStep("release", { issue: 88 }, { pr: { number: 99 } }))).toBe("#89 waits for #88, which waits for the release pull request");
    expect(dep(nextStep("release", { issue: 88 }, { releaseAt: "17:00" }))).toBe("#89 waits for #88, which waits for the 17:00 release");
  });

  it("uses no banned word in any record", () => {
    const variants: [NextKind, Parameters<typeof nextStep>[2]][] = [
      ...cases.map((c) => [c[0], c[1]] as [NextKind, Parameters<typeof nextStep>[2]]),
      ["approve_plan", {}], ["approve_split", {}], ["failed", {}], ["interrupted", {}], ["cancelled", {}], ["planner_questions", {}],
      ["restart", { restartWhy: "data_folder" }], ["restart", { runsLeft: 2 }], ["usage_limit", { limitAgent: "codex" }], ["daily_budget", {}],
      ["watcher_error", { reason: "dial tcp" }], ["release", { releaseAt: "17:00" }],
      ["dependency", { blockers: [{ issue: 1, next: nextStep("dependency", {}, { blockers: [{ issue: 2, next: nextStep("running") }] }) }] }],
      ["area_lock", { areaWait: { runId: "r0", areas: "src, tests" } }],
    ];
    for (const [kind, d] of variants) {
      const n = nextStep(kind, base, d);
      for (const t of [n.why, n.action, n.text, n.status, n.help, n.where.label]) {
        for (const w of ["hold", "precheck", "area lock", "jump_only"]) expect(t.toLowerCase(), `${kind}: ${t}`).not.toContain(w);
      }
    }
  });

  it("keeps banned words only inside quoted values", () => {
    const bad = "precheck hold area lock jump_only split risk";
    const scan = (t: string) => ["hold", "precheck", "area lock", "jump_only", "split risk"].filter((w) => t.toLowerCase().includes(w));
    const recs = [
      nextStep("approval", base, { message: bad }), nextStep("failed", base, { reason: bad }), nextStep("failed", base, { ...data, reason: bad, failedLabel: "on-hold" }),
      nextStep("watcher_error", base, { reason: bad }), nextStep("area_lock", base, { areaWait: { runId: "r0", areas: bad } }),
    ];
    for (const n of recs) {
      for (const t of [n.status, n.help, n.where.label]) expect(scan(t)).toEqual([]);
      for (const t of [n.why, n.action, n.text]) expect(scan(t.split(bad).join("").split("on-hold").join(""))).toEqual([]);
    }
    expect(recs[2]!.action).toContain("`on-hold`");
    expect(recs[0]!.why).toContain(bad);
  });

  it("has a kind in the table for every kind", () => {
    expect(new Set(cases.map((c) => c[0])).size).toBe(25);
  });

  it("says why a closed issue and a silent watcher need attention", () => {
    expect(nextStep("closed_elsewhere", base, { ...data }).text).toBe("#7 was closed on GitHub but its run is still working — cancel the run if the work is no longer wanted.");
    expect(nextStep("closed_elsewhere", base, { ...data, runWaits: true }).why).toBe("#7 was closed on GitHub but its run still waits for approval");
    expect(nextStep("watcher_stale", base, { lastCheck: "2026-10-01T11:20:00Z", timeZone: "UTC" }).text)
      .toBe("The watcher for acme/app has not checked since 11:20 — press Check now on the Watchers page.");
  });

  it("is one sentence for every kind, even with hard input", () => {
    for (const [kind, d] of cases) {
      const hard = { ...d, message: "Deploy now. Really?\nYes", reason: kind === "watcher_error" ? "a. b" : "step x failed: boom. More text" };
      const n = nextStep(kind, base, hard);
      expect(n.text, kind).toMatch(/^[^\n]+\.$/);
      expect(n.text.slice(0, -1), kind).not.toMatch(/[.!?]\s/);
    }
  });

  it("explains failure reasons in plain words", () => {
    const n = nextStep("failed", base, { reason: 'step "x" failed: exit code 1' });
    expect(n.why).toBe("The step x failed: its command ended with an error");
    expect(n.text.endsWith(", then resume the run on its page.")).toBe(true);
    expect(n.text).not.toContain("exit code");
    const b = runNextStep(run({ status: "failed", reason: "run budget of $2 reached" }));
    expect(b.why).toBe("The run reached its budget: it used the amount the flow allows for one run");
    expect(b.text).not.toContain("$");
    const u = nextStep("failed", base, { reason: "boom. More text" });
    expect(u.why).toBe("The run failed: the error is not one the Foundry can explain");
    expect(u.text).not.toContain("boom");
    expect(nextStep("failed", base, {}).why).toBe("The run failed: no reason was saved");
  });

  it("the advice fits the retry", () => {
    for (const reason of ["run budget of $2 reached", 'step "a" failed: claude result: error_max_budget_usd']) {
      const w = nextStep("failed", base, { ...data, reason });
      expect(w.action.endsWith("then remove the `factory:failed` label to start over")).toBe(true);
      expect(w.text).not.toContain("resume");
      expect(nextStep("failed", base, { reason }).action.endsWith("then start a new run")).toBe(true);
    }
    for (const reason of ['step "a" failed: timed out', 'step "a" exceeded max_visits (3)']) {
      expect(nextStep("failed", base, { ...data, reason }).action).toContain("or resume the run on its page");
    }
    const n = nextStep("failed", base, { ...data, reason: 'step "x" failed: exit code 1' });
    expect(n.text).toBe(`${n.why} — ${n.action.charAt(0).toLowerCase()}${n.action.slice(1)}.`);
  });

  it("a failed run with no step to resume at offers only to start over", () => {
    const r = run({ status: "failed", reason: 'step "x" failed: exit code 1', state: { next: null, steps: {}, visits: {} } } as never);
    expect(runNextStep(r).action.endsWith("then start a new run")).toBe(true);
    expect(runNextStep(r, watched).action.endsWith("to start over")).toBe(true);
    const ok = run({ status: "failed", reason: 'step "x" failed: exit code 1', state: { next: "x", steps: {}, visits: {} } } as never);
    expect(runNextStep(ok).action.endsWith("then resume the run on its page")).toBe(true);
  });

  it("explains watcher errors", () => {
    const n = nextStep("watcher_error", { repo: "o/r" }, { reason: "cannot access o/r with gh: x" });
    expect(n.why).toBe("The watcher for o/r can't reach GitHub: GitHub did not answer or did not let it in");
    expect(n.action).toBe("Check the network and `gh auth status`");
    expect(n.where.url).toBe("#/watchers");
    expect(nextStep("watcher_error", { repo: "o/r" }, { reason: "gh down" }).why).toBe("The watcher for o/r has an error: the error is not one the Foundry can explain");
    expect(nextStep("watcher_error", {}, { reason: "gh down" }).why).toBe("The watcher has an error: the error is not one the Foundry can explain");
    expect(nextStep("watcher_error", {}, { reason: "the check took longer than 600s and was given up" }).why).toContain("did not finish its check");
    expect(nextStep("watcher_error", {}, { reason: 'invalid interval "soon" (use e.g. 30s)' }).why).toContain("not a valid time");
  });

  it("says how many runs a restart waits for", () => {
    const a = nextStep("restart", {}, { restartWhy: "new_version", runsLeft: 2 });
    expect(a.text).toBe("A new version is waiting — it restarts after 2 runs.");
    expect(a.where.url).toBe("#/runs");
    expect(nextStep("restart", {}, { restartWhy: "data_folder", runsLeft: 1 }).text).toBe("The data folder moved — it restarts after 1 run.");
    expect(nextStep("restart", {}, { runsLeft: 0 }).text).toMatch(/it restarts in a moment\.$/);
    expect(nextStep("restart", {}, { restartWhy: "new_version" }).text).toBe("The server waits to restart on a new version — nothing to do, it restarts when the active runs are done.");
  });

  it("names the agent of a usage limit and links bare limits to the right page", () => {
    const reason = "usage limit reached — resets 11:52";
    const n = nextStep("usage_limit", {}, { limitAgent: "codex", reason });
    expect(n.why).toBe("The Codex usage limit is reached");
    expect(n.where.url).toBe("#/runs");
    expect(n.until).toBe("11:52");
    expect(nextStep("usage_limit", {}, { reason }).why).toBe("The usage limit is reached");
    expect(nextStep("usage_limit", {}, { reason }).where.url).toBe("#/watchers");
    const b = nextStep("daily_budget");
    expect(b.where.url).toBe("#/settings");
    expect(b.action).toBe("Raise the daily budget in Settings, or wait until tomorrow");
    expect(nextStep("daily_budget", { runId: "r1" }).where.url).toBe("#/runs/r1");
    expect(nextStep("daily_budget", { issue: 3 }, { issueUrl: "https://github.com/o/r/issues/3" }).action).toBe("Nothing — it continues by itself");
  });

  it("briefFailure drops the reason and the title of a Foundry failure only", () => {
    const f = nextStep("failed", { repo: "/work/app", title: "Fix /work/app/x", runId: "r1" }, { cause: "factory", what: "internal error: open '/work/app/x'", fix: "restart or update the Foundry" });
    const b = briefFailure(f);
    expect(b.why).toBe("The Foundry failed, not the code");
    expect(b.title).toBe("");
    expect(b.text).toBe("The Foundry failed, not the code — restart or update the Foundry, then resume the run on its page.");
    expect(b.text).not.toContain("/work");
    expect(b).toMatchObject({ action: f.action, where: f.where, issue: f.issue, runId: "r1" });
    const code = nextStep("failed", base, { cause: "code", reason: 'step "x" failed: exit code 1' });
    expect(briefFailure(code)).toBe(code);
    const done = nextStep("done", base);
    expect(briefFailure(done)).toBe(done);
  });

  it("runs saved before this change show the plain text", () => {
    const r = run({ status: "failed", reason: 'step "x" failed: claude result: error_max_turns' });
    expect(runNextStep(r).why).toBe("The step x failed: the agent used all its turns");
    expect(r.reason).toBe('step "x" failed: claude result: error_max_turns');
  });

  it("gives hints about what each reply does", () => {
    expect(nextStep("questions", base, data).text).toContain("/defaults");
    const plan = nextStep("approve_plan", base, data).text;
    expect(plan).toContain("optionally with notes");
    expect(plan).toContain("plans again");
    expect(nextStep("approve_split", base, data).text).toContain("creates these issues and closes this one");
  });

  it("counts questions", () => {
    expect(nextStep("questions", base, { questions: 1 }).action).toBe("Answer 1 question");
    expect(nextStep("questions", base, {}).action).toBe("Answer the questions");
    expect(countQuestions("Hi\n**Q1. A?**\n- x\n**Q2. B?**\n**Q3. C?**")).toBe(3);
    expect(countQuestions(undefined)).toBe(0);
  });

  it("failed: unwatched runs resume on the run page", () => {
    const n = nextStep("failed", base, { reason: "x" });
    expect(n.action).toBe("Look at Details on the run page, then resume the run on its page");
    expect(n.where.url).toBe("#/runs/r1");
    expect(nextStep("failed", base, data).text).toContain("to start over, or resume the run");
  });
});

describe("dependency chain", () => {
  const base = { repo: "acme/app", issue: 89 };
  const dep = (blockers: { issue: number; next?: NextStep }[]) => nextStep("dependency", base, { watched: true, blockers });
  it("describes what the blocker does", () => {
    const running = nextStep("running", { issue: 88 });
    expect(dep([{ issue: 88, next: running }]).text).toMatch(/^#89 waits for #88, which is being worked on — /);
    expect(dep([{ issue: 88, next: running }]).until).toBe("after #88");
  });
  it("follows the chain", () => {
    const inner = nextStep("running", { issue: 87 });
    const mid = dep([{ issue: 87, next: inner }]);
    const n = nextStep("dependency", { issue: 89 }, { blockers: [{ issue: 88, next: { ...mid, issue: 88 } }] });
    expect(n.why).toBe("#89 waits for #88, which waits for #87, which is being worked on");
  });
  it("says to be done for a blocker without a record, and skips done ones", () => {
    expect(dep([{ issue: 88 }]).why).toBe("#89 waits for #88, which is to be done");
    expect(dep([{ issue: 88, next: nextStep("done", { issue: 88 }) }]).why).toBe("#89 waits for #88");
  });
  it("uses the bracket form for two blockers", () => {
    expect(dep([{ issue: 87 }, { issue: 88 }]).why).toBe("#89 waits for #87, #88 (to be done first)");
  });
  it("keeps each blocker's own state and lists all of them in until", () => {
    const n = dep([{ issue: 87, next: nextStep("running", { issue: 87 }) }, { issue: 88, next: nextStep("failed", { issue: 88 }, { reason: "x" }) }]);
    expect(n.why).toBe("#89 waits for #87, which is being worked on and #88, which failed");
    expect(n.until).toBe("after #87, #88");
  });
  it("a local run keeps its repository", () => {
    expect(runNextStep(run({ vars: {}, repo: "/work/app" })).repo).toBe("/work/app");
  });
  it("shows a decision of a blocker", () => {
    const b = runNextStep(run({ status: "waiting", waiting: { stepId: "approve_plan", message: "m", since: "x" } }), { title: "x" });
    expect(dep([{ issue: 4, next: b }]).why).toContain("which waits for your decision on its risky plan");
  });
});

describe("until", () => {
  const limited = (reason: string, now = "2026-10-01T08:20:00Z") =>
    runNextStep(run({ status: "stopped", reason }), { ...watched, now: new Date(now), timeZone: "UTC" });
  it("usage limit: the reset time from the message", () => {
    const n = limited("usage limit reached: You've hit your limit · resets 3:50pm (Europe/Amsterdam) — continues automatically after the limit resets (or resume it)");
    expect(n.kind).toBe("usage_limit");
    expect(n.until).toBe("3:50pm (Europe/Amsterdam)");
  });
  it("usage limit: 30 minutes after it stopped, or the next check when due", () => {
    expect(limited("usage limit reached: busy").until).toBe("08:40");
    expect(limited("usage limit reached: busy", "2026-10-01T09:00:00Z").until).toBe("the next check");
  });
  it("signed out: it is the owner's turn, with the exact command", () => {
    const n = limited('signed out — the Claude Code login has expired. Sign in again: run "claude" in a terminal and type /login. The run continues by itself after that.');
    expect(n.who).toBe("You");
    expect(n.why).toBe("Claude Code is signed out (its login has expired)");
    expect(JSON.stringify(n)).toContain("/login");
  });
  it("daily budget: tomorrow, no amount", () => {
    const n = limited("daily budget of $5 reached — resume tomorrow");
    expect(n.kind).toBe("daily_budget");
    expect(n.until).toBe("tomorrow");
    expect(n.text).not.toContain("$");
  });
  it("finished work waits for the release", () => {
    const n = runNextStep(run(), { ...watched, releaseAt: "17:00" });
    expect(n).toMatchObject({ kind: "release", who: "Foundry", until: "17:00 release", action: "Nothing — it ships with the 17:00 release" });
    expect(n.text).toMatch(/^[^\n]+\.$/);
    expect(runNextStep(run(), watched).kind).toBe("done");
    expect(runNextStep(run(), watched).until).toBeUndefined();
  });
});

describe("runNextStep", () => {
  it("classifies real reason strings", () => {
    const k = (over: Partial<RunSummary>) => runNextStep(run(over), watched).kind;
    expect(k({ status: "stopped", reason: 'stopped at step "wait_for_merge" — needs attention' })).toBe("release");
    expect(k({ status: "stopped", reason: 'stopped at step "build/wait_for_merge" — needs attention' })).toBe("release");
    expect(k({ status: "stopped", reason: 'stopped at step "send_back" — needs attention' })).toBe("planner_questions");
    expect(k({ status: "stopped", reason: 'stopped at step "ask_for_info" — needs attention' })).toBe("planner_questions");
    expect(k({ status: "stopped", reason: 'stopped at step "approve" — needs attention' })).toBe("stopped");
    expect(k({ status: "failed", reason: "interrupted — resume it to continue" })).toBe("interrupted");
    expect(k({ status: "failed", reason: "run budget of $2 reached" })).toBe("failed");
    expect(k({ status: "failed", reason: 'step "x" failed: exit code 1' })).toBe("failed");
    expect(k({ status: "cancelled" })).toBe("cancelled");
    expect(k({ status: "running" })).toBe("running");
  });
  it("tells approval steps apart", () => {
    const k = (stepId: string) => runNextStep(run({ status: "waiting", waiting: { stepId, message: "ok", since: "x" } }), watched).kind;
    expect(k("approve_plan")).toBe("approve_plan");
    expect(k("approve_split")).toBe("approve_split");
    expect(k("gate")).toBe("approval");
  });
  it("links the run page for runs that are not watched", () => {
    const n = runNextStep(run({ status: "waiting", waiting: { stepId: "gate", message: "ok", since: "x" } }));
    expect(n.where.url).toBe("#/runs/r1");
    expect(n.text).toContain("approve or reject it on the run page");
  });
  it("uses the issue link for watched runs", () => {
    expect(runNextStep(run({ status: "failed", reason: "x" }), watched).where.url).toBe(ISSUE);
  });
  it("a queued resume names the blocker, or just waits", () => {
    const a = runNextStep(run({ status: "stopped" }), { queued: { waitingFor: "r0" } });
    expect(a.kind).toBe("one_at_a_time");
    expect(a.where.url).toBe("#/runs/r0");
    expect(runNextStep(run({ status: "stopped" }), { queued: {} }).kind).toBe("queued");
  });
  it("a superseded stopped run needs nobody; a succeeded one stays done", () => {
    const a = runNextStep(run({ status: "stopped", reason: "stopped at step \"approve\"" }), { superseded: true });
    expect(a.kind).toBe("superseded");
    expect(a.who).toBe("Foundry");
    expect(a.action.startsWith("Nothing")).toBe(true);
    expect(runNextStep(run(), { superseded: true }).kind).toBe("done");
  });
  const resumable = { state: { next: "p", steps: {}, visits: {} } };
  it("says the Foundry failed, not the code, and suggests the fix", () => {
    const n = runNextStep(run({ ...resumable, status: "failed", reason: "internal error: boom" }));
    expect(n).toMatchObject({ cause: "factory", who: "Something is wrong", where: { url: "#/runs/r1" } });
    expect(n.text).toBe("The Foundry failed, not the code: internal error: boom — restart or update the Foundry, then resume the run on its page.");
    expect(n.help).not.toContain("A step failed");

    const marker = runNextStep(run({ ...resumable, status: "failed", reason: 'step "p" failed: exit code 1', history: [{ id: "p", type: "shell", ok: false, output: "planning failed: no PLAN_STATUS line\n" }] as RunSummary["history"] }));
    expect(marker.text).toBe("The Foundry failed, not the code: the plan had no PLAN_STATUS line — resume the run to try the step again, then resume the run on its page.");

    const push = runNextStep(run({ ...resumable, status: "failed", reason: 'step "p" failed: exit code 1', history: [{ id: "p", type: "shell", ok: false, output: "refusing to push main: not a feature branch" }] as RunSummary["history"] }), watched);
    expect(push.text).toMatch(/— change Protected branches in Settings or the flow's branch, then remove the `factory:failed` label to start over, or resume the run on its page\.$/);
    expect(push.action).toMatch(/^C[^.]+[^.]$/);
    expect(push.where.url).toBe(ISSUE);

    // No step to resume at: only starting over is offered.
    const fresh = runNextStep(run({ status: "failed", reason: "internal error: boom" }));
    expect(fresh.text).toBe("The Foundry failed, not the code: internal error: boom — restart or update the Foundry, then start a new run.");
  });

  it("keeps the code failure text, and puts a blocked command in a hint", () => {
    const reason = 'step "x" failed: exit code 1';
    const n = runNextStep(run({ ...resumable, status: "failed", reason }));
    const old = nextStep("failed", { repo: "acme/app", issue: 7, title: "do it", runId: "r1" }, { reason, runId: "r1", issueUrl: undefined, canResume: true });
    expect([n.text, n.help, n.cause]).toEqual([old.text, old.help, "code"]);
    expect(runNextStep(run({ status: "failed", reason: "run budget of $2 reached" })).cause).toBe("limit");

    const h = [{ id: "c", type: "claude", ok: true, output: "", denied: ["Bash: mkdir x"] }, { id: "t", type: "shell", ok: false, output: "FAIL" }] as unknown as RunSummary["history"];
    const hinted = runNextStep(run({ ...resumable, status: "failed", reason: 'step "t" failed: exit code 1', history: h }));
    expect(hinted.why).toBe(`${n.why.replace("The step x", "The step t")} (a command was blocked: Bash: mkdir, allow it in the flow if it was needed)`);
    expect(hinted.action).toBe(n.action);
  });

  it("gives an interrupted run the factory cause but keeps its wording", () => {
    for (const o of [{}, watched]) {
      const n = runNextStep(run({ status: "failed", reason: "interrupted — resume it to continue" }), o);
      expect(n).toMatchObject({ kind: "interrupted", cause: "factory" });
      expect(n.why).toBe("The run was interrupted");
    }
  });

  it("is one sentence for a factory failure", () => {
    for (const d of [{ cause: "factory" as const, what: "a. b", fix: "c. d" }, { cause: "factory" as const }, { what: "a command", fix: "fix it. now" }]) {
      for (const w of [{}, watched]) {
        const n = nextStep("failed", { repo: "acme/app", issue: 7 }, { ...w, ...d, reason: "x. y" });
        expect(n.text).toMatch(/^[^\n]+\.$/);
        expect(n.text.slice(0, -1)).not.toMatch(/[.!?]\s/);
      }
    }
  });

  it("does not throw on a bare run", () => {
    const bare = { runId: "x", status: "stopped", reason: "boom" } as unknown as RunSummary;
    expect(() => runNextStep({ runId: "x", status: "failed", reason: 'step "a" failed' } as unknown as RunSummary)).not.toThrow();
    expect(() => runNextStep(bare)).not.toThrow();
    expect(() => releaseAtFor([], { ...bare, status: "succeeded" } as RunSummary)).not.toThrow();
  });
});

describe("releaseWatchersFor", () => {
  const w = (over: Record<string, unknown>) => WatcherSchema.parse({ id: "x", github_repo: "acme/app", task: "t", source: "schedule", flow: "release-daily", at: "17:00", ...over });
  const flowRun = (...ids: string[]) => run({ flowDef: { steps: ids.map((id) => ({ id })) } as unknown as RunSummary["flowDef"] });

  it("finds the schedule watcher of the flow's delivery step", () => {
    const rel = w({ id: "rel" });
    expect(releaseWatchersFor([rel, w({ id: "other", flow: "daily-pr" })], flowRun("code", "push_develop"))).toEqual([rel]);
  });
  it("finds none without the step, for another repo, when disabled or without a time", () => {
    expect(releaseWatchersFor([w({})], flowRun("code"))).toEqual([]);
    expect(releaseWatchersFor([w({ github_repo: "acme/other" })], flowRun("push_develop"))).toEqual([]);
    expect(releaseWatchersFor([w({ enabled: false })], flowRun("push_develop"))).toEqual([]);
    expect(releaseWatchersFor([w({ at: undefined })], flowRun("push_develop"))).toEqual([]);
  });
});

describe("releaseAtFor and trackingWatcher", () => {
  const w = (over: Record<string, unknown>) => WatcherSchema.parse({ id: "x", github_repo: "acme/app", task: "t", ...over });
  const steps = (...ids: string[]) => ids.map((id) => ({ id, ok: true })) as unknown as RunSummary["history"];
  const releaseDaily = w({ id: "rel", source: "schedule", flow: "release-daily", at: "17:00" });
  const dailyPr = w({ id: "pr", source: "schedule", flow: "daily-pr", at: "16:30" });

  it("pairs push_develop with release-daily", () => {
    expect(releaseAtFor([releaseDaily], run({ history: steps("push_develop") }))).toBe("17:00");
  });
  it("pairs daily_branch + push with daily-pr", () => {
    expect(releaseAtFor([dailyPr], run({ history: steps("daily_branch", "push") }))).toBe("16:30");
  });
  it("does not guess from a plain push or the wrong pair", () => {
    expect(releaseAtFor([releaseDaily, dailyPr], run({ history: steps("push") }))).toBeUndefined();
    expect(releaseAtFor([dailyPr], run({ history: steps("push_develop") }))).toBeUndefined();
  });
  it("a later failed release still waits; a succeeded one does not", () => {
    const r = run({ history: steps("push_develop") });
    const rel = (status: string) => run({ runId: "rel1", flow: "release-daily", status: status as RunSummary["status"], startedAt: "2026-10-01T17:00:00Z" });
    expect(releaseAtFor([releaseDaily], r, [rel("failed")])).toBe("17:00");
    const after = releaseAtFor([releaseDaily], r, [rel("succeeded")]);
    expect(after).toBeUndefined();
    expect(runNextStep(r, { ...watched, releaseAt: after }).kind).toBe("done");
  });
  it("ignores disabled watchers and watchers without a time", () => {
    const r = run({ history: steps("push_develop") });
    expect(releaseAtFor([{ ...releaseDaily, enabled: false }], r)).toBeUndefined();
    expect(releaseAtFor([w({ source: "schedule", flow: "release-daily" })], r)).toBeUndefined();
  });
  it("a release that began before the work finished did not cover it", () => {
    const r = run({ history: steps("push_develop"), startedAt: "2026-10-01T16:00:00Z", finishedAt: "2026-10-01T17:30:00Z" });
    const rel = run({ runId: "rel1", flow: "release-daily", startedAt: "2026-10-01T17:00:00Z" });
    expect(releaseAtFor([releaseDaily], r, [rel])).toBe("17:00");
  });
  it("trackingWatcher skips disabled watchers and other trigger labels", () => {
    const a = w({ id: "a", flow: "github-issue", label: "one", enabled: false });
    const b = w({ id: "b", flow: "github-issue", label: "two" });
    const c = w({ id: "c", flow: "github-issue", label: "one" });
    const r = run({ vars: { github_repo: "acme/app", issue: "7", trigger_label: "one" } });
    expect(trackingWatcher([a, b, c], r)?.id).toBe("c");
  });
  it("unwatched plan and split approvals point to the run page, not to comments", () => {
    for (const k of ["approve_plan", "approve_split"] as const) {
      const n = nextStep(k, { runId: "r1" }, {});
      expect(n.action).toBe("Approve or reject it on the run page");
      expect(n.text).not.toContain("/approve");
      expect(n.where.url).toBe("#/runs/r1");
    }
  });
  it("trackingWatcher matches source, repo and flow", () => {
    const issues = w({ id: "i", flow: "github-issue" });
    const r = run();
    expect(trackingWatcher([issues], r)?.id).toBe("i");
    expect(trackingWatcher([w({ id: "o", github_repo: "x/y" })], r)).toBeUndefined();
    expect(trackingWatcher([w({ id: "o", flow: "issue-plan" })], r)).toBeUndefined();
    expect(trackingWatcher([w({ id: "s", source: "schedule" })], r)).toBeUndefined();
    expect(trackingWatcher([issues], run({ vars: { github_repo: "acme/app" } }))).toBeUndefined();
  });
});
