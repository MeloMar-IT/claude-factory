import { describe, expect, it } from "vitest";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { classifyFailure, shortDenied, type FailureCause } from "../src/failure.js";

const rec = (over: Partial<StepRecord> & { id: string }): StepRecord =>
  ({ type: "shell", visit: 1, ok: false, output: "", startedAt: "x", durationMs: 1, logFile: "l", ...over }) as StepRecord;
const run = (status: RunSummary["status"], reason: string | undefined, history: StepRecord[] | undefined = []) =>
  ({ status, reason, history }) as Pick<RunSummary, "status" | "reason" | "history">;
const failedStep = (output: string, id = "s") => [rec({ id, output })];
const FAILED = 'step "s" failed: exit code 1';

describe("classifyFailure", () => {
  it.each<[string, string, FailureCause]>([
    ["internal error", "internal error: x is not a function", "factory"],
    ["unknown step", 'unknown step "nope"', "factory"],
    ["bot token", 'bot.gh_token_env is "BOT_TOKEN" but that env var is not set', "factory"],
    ["app token", 'GitHub App token request failed: 401 {"message":"Bad credentials"}', "factory"],
    ["workspace", 'workspace "worktree" needs a git repository, but /x is not one', "factory"],
    ["interrupted", "interrupted — resume it to continue", "factory"],
    ["run budget", "run budget of $2 reached", "limit"],
  ])("%s", (_n, reason, cause) => {
    const f = classifyFailure(run("failed", reason));
    expect(f.cause).toBe(cause);
    if (cause === "factory") expect(f.fix).toBeTruthy();
  });

  it("is factory for a run that failed before any step ran", () => {
    expect(classifyFailure(run("failed", undefined, []))).toMatchObject({ cause: "factory", what: "the run failed before any step ran" });
  });

  it.each([
    "set a token for this repository under My repositories",
    "the token of this repository is missing; set it again under My repositories",
    "the stored token of this repository cannot be read; set it again under My repositories, or ask an admin",
    "GitHub refused the token of this repository; check its access to Contents and Issues",
    '"acme/app" is not one of your repositories',
    "this run has no owner, so the token of the repository cannot be looked up",
  ])("is factory for a repository that could not be read with its stored token: %s", (error) => {
    for (const output of [error, `${error}\nfatal: Authentication failed for 'https://github.com/acme/app/'`]) {
      const h = [rec({ id: "clone", output, error })];
      expect(classifyFailure(run("failed", `step "clone" failed: ${error}`, h))).toMatchObject({
        cause: "factory",
        what: "the repository could not be read with its stored token",
        fix: "set the token of the repository again under My repositories, or ask an admin when it cannot be read",
      });
    }
  });

  it.each([
    ["planning failed: no PLAN_STATUS line", "the plan had no PLAN_STATUS line"],
    ["planning failed (no questions to ask)", "the plan had no questions to ask"],
    ["no SUBTASK lines", "the triage had no SUBTASK lines"],
  ])("reads the marker %s", (line, what) => {
    expect(classifyFailure(run("failed", FAILED, failedStep(`${line}\n`)))).toMatchObject({ cause: "factory", what, fix: "resume the run to try the step again" });
    expect(classifyFailure(run("failed", undefined, failedStep(line))).cause).toBe("factory");
    expect(classifyFailure(run("failed", FAILED, failedStep(`${line}\nmore text after it`))).cause).toBe("code");
    expect(classifyFailure(run("failed", FAILED, failedStep(`I saw: ${line}`))).cause).toBe("code");
  });

  it("reads the push guard, for any branch name", () => {
    const guard = (b: string, prefix = "Spaghetti Code Foundry") => `${prefix}: pushing to protected branch '${b}' is blocked\nerror: failed to push some refs`;
    for (const b of ["main", "x".repeat(120), "it's"]) {
      const f = classifyFailure(run("failed", FAILED, failedStep(guard(b))));
      expect(f.cause).toBe("factory");
      expect(f.what).not.toContain(b);
      expect(f.fix).toContain("Protected branches");
    }
    expect(classifyFailure(run("failed", FAILED, failedStep(guard("main", "claude-factory")))).cause).toBe("factory");
    for (const b of ["main", "y".repeat(120)]) {
      expect(classifyFailure(run("failed", FAILED, failedStep(`refusing to push ${b}: not a feature branch`))).cause).toBe("factory");
    }
    expect(classifyFailure(run("failed", FAILED, failedStep("expected 'pushing to protected branch 'main' is blocked' but got none"))).cause).toBe("code");
  });

  it("is factory when the failed agent step had a blocked command", () => {
    const h = [rec({ id: "code", type: "claude", denied: ["Bash: mkdir -p out"] })];
    expect(classifyFailure(run("failed", 'step "code" failed: x', h))).toMatchObject({ cause: "factory", what: "the agent was not allowed to run Bash: mkdir" });
    expect(classifyFailure(run("failed", undefined, h)).cause).toBe("factory");
  });

  it("looks through sub-flow and parallel records", () => {
    const child = rec({ id: "build/code", type: "claude", parent: "build", denied: ["Bash: mkdir x"] });
    const flow = rec({ id: "build", type: "flow", error: 'sub-flow b failed: step "build/code" failed: x' });
    expect(classifyFailure(run("failed", 'step "build" failed: sub-flow b failed', [child, flow])).cause).toBe("factory");
    const pChild = rec({ id: "code", type: "claude", denied: ["Bash: mkdir x"] });
    const par = rec({ id: "par", type: "parallel", error: "failed: code" });
    expect(classifyFailure(run("failed", 'step "par" failed: failed: code', [pChild, par])).cause).toBe("factory");
    const shell = rec({ id: "t", output: "no SUBTASK lines" });
    expect(classifyFailure(run("failed", 'step "par" failed: failed: t', [shell, rec({ id: "par", type: "parallel", error: "failed: t" })])).cause).toBe("factory");
  });

  it("keeps code failures as code", () => {
    const cases: Array<[string, StepRecord[] | undefined]> = [
      ['step "run_tests" failed: exit code 1', failedStep("FAIL 2 tests", "run_tests")],
      ['step "fix_tests" exceeded max_visits (3)', failedStep("x")],
      ['step "build" failed: sub-flow b failed: step "build/plan" exceeded max_visits (3)', [rec({ id: "build/plan", parent: "build", output: "no SUBTASK lines" }), rec({ id: "build", type: "flow", error: "sub-flow b failed" })]],
      ['step "par" failed: failed: code, test', [rec({ id: "code", type: "claude", denied: ["Bash: mkdir x"] }), rec({ id: "test" }), rec({ id: "par", type: "parallel", error: "failed: code, test" })]],
      ['step "f" failed: output did not match pass_if /x/', [rec({ id: "c", parent: "f", type: "claude", denied: ["Bash: mkdir x"] }), rec({ id: "f", type: "flow", error: "output did not match pass_if /x/" })]],
      [FAILED, failedStep("secret scan: found a key in app.js\nerror: failed to push some refs")],
      ['step "review" failed: output did not match pass_if /APPROVE/', failedStep("VERDICT: CHANGES")],
      ["", failedStep("boom")],
      ["", undefined],
      ['step "a" failed', undefined],
      ["", [rec({ id: "x" }), rec({ id: "x2" })]],
      ['step "par" failed: failed: push, test', [
        rec({ id: "push", output: "Spaghetti Code Foundry: pushing to protected branch 'main' is blocked" }),
        rec({ id: "test", output: "FAIL" }),
        rec({ id: "par", type: "parallel", error: "failed: push, test", output: "## push\nSpaghetti Code Foundry: pushing to protected branch 'main' is blocked\n\n## test\nFAIL" }),
      ]],
      ['step "par" failed: failed: push, plan', [
        rec({ id: "par", type: "parallel", error: "failed: push, plan", output: "## push\nx\n\n## plan\nno SUBTASK lines" }),
      ]],
    ];
    for (const [reason, history] of cases) expect(classifyFailure({ status: "failed", reason, history } as RunSummary).cause, reason).toBe("code");
    expect(() => classifyFailure({ status: "failed" } as RunSummary)).not.toThrow();
  });

  it("hints at a blocked command in a code failure", () => {
    const h = [rec({ id: "c", type: "claude", ok: true, denied: ["Bash: curl -H x http://y"] }), rec({ id: "t", output: "FAIL" })];
    expect(classifyFailure(run("failed", 'step "t" failed: exit code 1', h))).toEqual({ cause: "code", what: "a command was blocked: Bash: curl", fix: "allow it in the flow if it was needed" });
    const v = [rec({ id: "c", type: "claude", denied: ["Bash: rm x"] })];
    expect(classifyFailure(run("failed", 'step "c" exceeded max_visits (3)', v))).toMatchObject({ cause: "code", what: "a command was blocked: Bash: rm" });
  });

  it("knows limits and decisions", () => {
    expect(classifyFailure(run("stopped", "daily budget of $5 reached — resume tomorrow")).cause).toBe("limit");
    expect(classifyFailure(run("stopped", "usage limit reached: x")).cause).toBe("limit");
    expect(classifyFailure(run("waiting", "Go?")).cause).toBe("decision");
    expect(classifyFailure(run("stopped", 'stopped at step "send_back" — needs attention')).cause).toBe("decision");
    expect(classifyFailure(run("cancelled", "cancelled by user")).cause).toBe("decision");
  });
});

describe("shortDenied", () => {
  it.each([
    ['Bash: curl -H "Authorization: token abc" https://x', "Bash: curl"],
    ["Bash: TOKEN=abc ./gradlew test", "Bash: gradlew"],
    ["Bash: $(evil)", "Bash"],
    ["Write: /a/b.txt", "Write"],
    ["mcp__x__y", "mcp__x__y"],
    ["weird tool!: x", "a tool"],
  ])("%s", (input, want) => expect(shortDenied(input)).toBe(want));
});
