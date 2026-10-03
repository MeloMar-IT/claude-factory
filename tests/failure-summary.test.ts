import { describe, expect, it } from "vitest";
import type { RunSummary, StepRecord } from "../src/engine/state.js";
import { classifyFailure, failureSummary, hideFolders, safeSentence, triedOf, triedText } from "../src/failure.js";

const rec = (over: Partial<StepRecord> & { id: string }): StepRecord =>
  ({ type: "shell", visit: 1, ok: false, output: "", startedAt: "x", durationMs: 1, logFile: "l", ...over }) as StepRecord;
const run = (status: RunSummary["status"], reason: string | undefined, history: StepRecord[] = [], over: Partial<RunSummary> = {}) =>
  ({ status, reason, history, ...over }) as RunSummary;
const FAILED = 'step "s" failed: exit code 1';

describe("classifyFailure: the kinds", () => {
  it("a rejection is a person's decision, a step budget is a limit", () => {
    expect(classifyFailure(run("failed", 'step "a" failed: rejected', [rec({ id: "a", type: "approval", error: "rejected" })])).cause).toBe("decision");
    expect(classifyFailure(run("failed", 'step "a" failed: claude result: error_max_budget_usd')).cause).toBe("limit");
  });

  it("stopped runs: signed out and unreachable are the Foundry, limits are limits", () => {
    expect(classifyFailure(run("stopped", 'signed out — the Claude Code login has expired.')).cause).toBe("factory");
    expect(classifyFailure(run("stopped", 'signed out — the Codex login has expired.')).cause).toBe("factory");
    expect(classifyFailure(run("stopped", "usage limit reached: connection error", [rec({ id: "a", unreachable: true, limited: true })]))).toMatchObject({ cause: "factory", what: "the AI service could not be reached" });
    expect(classifyFailure(run("stopped", "usage limit reached: You've hit your limit", [rec({ id: "a", limited: true })])).cause).toBe("limit");
    expect(classifyFailure(run("stopped", "daily budget of $5 reached — resume tomorrow")).cause).toBe("limit");
    expect(classifyFailure(run("stopped", 'stopped at step "x" — needs attention')).cause).toBe("decision");
  });

  it.each([
    'unknown provider "nope" (known: anthropic)',
    "Claude Code can't use the openai provider — use agent codex",
    "Codex can't use the anthropic provider — use openai, ollama or lmstudio",
    "provider ollama needs a model, e.g. ollama:qwen3-coder",
    "provider x needs base_url",
    "codex CLI not found",
  ])("setup error %s is the Foundry, and the text is not repeated", (error) => {
    const f = classifyFailure(run("failed", `step "a" failed: ${error}`, [rec({ id: "a", type: "claude", error })]));
    expect(f.cause).toBe("factory");
    expect(f.what).not.toContain(error.slice(0, 12));
    // the same text in the output of a step is only text
    expect(classifyFailure(run("failed", FAILED, [rec({ id: "s", output: error })])).cause).toBe("code");
  });

  it.each([
    "fatal: Authentication failed for 'https://github.com/o/r.git/'",
    "remote: Invalid username or password.",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "To get started with GitHub CLI, please run:  gh auth login",
    "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
    "ssh: Could not resolve hostname github.com: nodename nor servname provided",
  ])("login and network line %s in a shell step is the Foundry", (line) => {
    const f = classifyFailure(run("failed", FAILED, [rec({ id: "s", output: `before\n${line}\n` })]));
    expect(f.cause).toBe("factory");
    expect(f.what).not.toContain(line.slice(0, 15));
    expect(classifyFailure(run("failed", FAILED, [rec({ id: "s", type: "claude", output: line })])).cause).toBe("code");
    expect(classifyFailure(run("failed", FAILED, [rec({ id: "s", output: `expected '${line}'` })])).cause).toBe("code");
  });

  it("does not guess when a parallel record cannot be traced to one child", () => {
    const h = [rec({ id: "p/a", output: "fatal: Authentication failed for x" }), rec({ id: "p/b" }), rec({ id: "p", type: "parallel", error: "failed: a, b" })];
    expect(classifyFailure(run("failed", 'step "p" failed: failed: a, b', h)).cause).toBe("code");
  });

  it("a model's note turns a code failure into an environment one, and nothing else", () => {
    const note = { kind: "environment" as const, why: "Java is not installed", by: "m" };
    const denied = [rec({ id: "x", ok: true, denied: ["Bash: gradle build"] }), rec({ id: "s" })];
    expect(classifyFailure(run("failed", FAILED, [rec({ id: "s" })], { failureNote: note }))).toEqual({ cause: "factory", what: note.why, fix: "fix what the reason says, then retry" });
    expect(classifyFailure(run("failed", FAILED, denied, { failureNote: note }))).toMatchObject({ cause: "factory", what: "Java is not installed", fix: "allow it in the flow if it was needed" });
    expect(classifyFailure(run("failed", FAILED, [rec({ id: "s" })], { failureNote: { ...note, kind: "code" } })).cause).toBe("code");
    expect(classifyFailure(run("failed", "run budget of $2 reached", [], { failureNote: note })).cause).toBe("limit");
    expect(classifyFailure(run("failed", 'step "a" failed: rejected', [], { failureNote: note })).cause).toBe("decision");
    expect(classifyFailure(run("failed", "internal error: x", [], { failureNote: note }))).toMatchObject({ cause: "factory", fix: "restart or update the Foundry" });
    expect(classifyFailure(run("stopped", "usage limit reached: x", [], { failureNote: note })).cause).toBe("limit");
  });
});

describe("limits inside composite steps, and options that need a new run", () => {
  it("reads a limit or an unreachable service on the child of a parallel step", () => {
    const wrap = (child: Partial<StepRecord>) => [rec({ id: "a", ...child }), rec({ id: "b", ok: true }), rec({ id: "p", type: "parallel", error: "failed: a" })];
    const reason = 'step "p" failed: failed: a';
    expect(classifyFailure(run("failed", reason, wrap({ limited: true, error: "usage limit reached: x" }))).cause).toBe("limit");
    expect(classifyFailure(run("failed", reason, wrap({ limited: true, unreachable: true }))).cause).toBe("factory");
    expect(classifyFailure(run("failed", reason, wrap({ error: "claude result: error_max_budget_usd" }))).cause).toBe("limit");
    expect(classifyFailure(run("failed", reason, wrap({}))).cause).toBe("code");
  });
  it("offers a new run, not a resume, when the budget is used up", () => {
    const r = run("failed", "run budget of $2 reached", [], { state: { next: "a", steps: {}, visits: {} } });
    expect(failureSummary(r).options[0]).toBe("Retry — start a new run");
    expect(failureSummary(r, { watched: true }).options[0]).not.toContain("resume");
  });
  it("counts the fix rounds when the fix handler itself fails last", () => {
    const flowDef = { name: "f", steps: [{ id: "run_tests", type: "shell", on_failure: "fix_tests" }, { id: "fix_tests", type: "claude" }] } as never;
    const h = [rec({ id: "run_tests" }), rec({ id: "fix_tests", type: "claude", ok: true }), rec({ id: "run_tests" }), rec({ id: "fix_tests", type: "claude" })];
    expect(triedText({ history: h, flowDef })).toBe("2 fix attempts");
  });
});

describe("max_visits and a missing Claude program", () => {
  it("repeated rejections are a decision, and the failing step is named, not the exhausted handler", () => {
    const rejected = [rec({ id: "approve_plan", type: "approval", error: "rejected", output: "rejected by Ann: no" })];
    const r1 = run("failed", 'step "approve_plan" exceeded max_visits (5)', rejected);
    expect(classifyFailure(r1).cause).toBe("decision");
    expect(failureSummary(r1).why).toBe("A person rejected it: no.");
    const loop = [rec({ id: "run_tests" }), rec({ id: "fix_tests", type: "claude", ok: true })];
    const r2 = run("failed", 'step "fix_tests" exceeded max_visits (3)', loop);
    expect(failureSummary(r2).what).toBe("The step run_tests kept failing");
    expect(failureSummary(run("failed", 'step "fix_tests" exceeded max_visits (3)', [])).what).toBe("The loop at step fix_tests reached its attempt limit");
  });
  it("a missing Claude program is a Foundry failure", () => {
    const error = "claude CLI not found — install Claude Code on the computer that runs the Foundry";
    const f = classifyFailure(run("failed", `step "a" failed: ${error}`, [rec({ id: "a", type: "claude", error })]));
    expect(f).toMatchObject({ cause: "factory", what: "the Claude Code tool is not installed" });
  });
});

describe("tried", () => {
  const flowDef = { name: "f", steps: [{ id: "run_tests", type: "shell", on_failure: "fix_tests" }, { id: "fix_tests", type: "claude", jump_only: true }, { id: "plain", type: "shell", on_failure: "fix_shell" }, { id: "fix_shell", type: "shell" }] } as never;
  const attempts = (id: string, n: number, over: Partial<StepRecord> = {}) => Array.from({ length: n }, () => rec({ id, ...over }));

  it("counts the fix attempts of an agent handler", () => {
    const h = [...attempts("run_tests", 4), ...attempts("fix_tests", 3, { ok: true, type: "claude" })];
    expect(triedText({ history: h, flowDef })).toBe("3 fix attempts");
  });
  it("uses attempts when the handler is not an agent step or the record is from a sub-flow", () => {
    expect(triedText({ history: attempts("plain", 3), flowDef })).toBe("3 attempts");
    expect(triedText({ history: attempts("run_tests", 2, { parent: "sub" }), flowDef })).toBe("2 attempts");
  });
  it("says nothing else was tried at the first failure", () => {
    expect(triedText({ history: [rec({ id: "plain" })], flowDef })).toBe("Nothing else — it failed at the first attempt");
  });
  it("counts the tries inside a step", () => {
    const history = [rec({ id: "a", type: "claude", retried: { blips: 2, models: 1 } })];
    expect(triedText({ history })).toBe("2 more tries after the AI service was briefly unavailable; 1 other model");
    expect(triedText({ history }, true)).toBe("3 more tries inside the step");
  });
  it("counts resumes", () => {
    expect(triedText({ history: [rec({ id: "a" })], resumes: 1 })).toBe("the run was resumed once");
    expect(triedText({ history: [rec({ id: "a" })], resumes: 2 })).toBe("the run was resumed 2 times");
  });
  it("does not throw without history or flow", () => {
    expect(triedOf({} as never)).toMatchObject({ attempts: 0, fixes: 0 });
    expect(triedText({ history: undefined as never })).toContain("first attempt");
  });
});

describe("safeSentence and hideFolders", () => {
  it("removes a marker comment completely", () => {
    expect(safeSentence("a <!-- claude-factory run=x --> b")).toBe("a b");
    expect(safeSentence("<!-- claude-factory run=x")).toBe("");
  });
  it("strips formatting, keeps names, breaks mentions, one short line", () => {
    const out = safeSentence("`a` **b** <details>c</details> [x](http://y) # Title _x_ run_tests");
    expect(out).toBe("a b c x Title x run_tests");
    expect(safeSentence("ping @someone")).not.toContain("@someone");
    const long = safeSentence(`line one\nline two ${"x".repeat(500)}`);
    expect(long).not.toContain("\n");
    expect(long.length).toBeLessThanOrEqual(240);
  });
  it("hides folders, longest first, and ignores a one-character path", () => {
    expect(hideFolders("/a/b/work and /a/b and /a/run", ["/a/b", "/a/b/work", "/", "/a/run", undefined])).toBe("(folder) and (folder) and (folder)");
  });
});

describe("failureSummary", () => {
  const OPTIONS = ["Retry", "Retry with a hint", "Change the plan", "Close"];
  const names = (s: ReturnType<typeof failureSummary>) => s.options.map((o) => o.split(" — ")[0]);
  const code = run("failed", FAILED, [rec({ id: "s" })]);

  it("has four options in order in every case", () => {
    for (const r of [code, run("failed", "run budget of $2 reached"), run("failed", 'step "a" failed: rejected'), run("failed", "boom"), run("failed", undefined)]) {
      expect(names(failureSummary(r, { watched: true }))).toEqual(OPTIONS);
      expect(names(failureSummary(r))).toEqual(OPTIONS);
    }
  });
  it("words the options for a watched issue and for a run by hand", () => {
    expect(failureSummary(code, { watched: true, failedLabel: "Factory_ERROR" }).options[0]).toBe("Retry — remove the Factory_ERROR label, or resume the run on its page");
    expect(failureSummary(code, { watched: true, failedLabel: "Factory_ERROR" }).options.join()).not.toContain("`");
    expect(failureSummary(code).options[0]).toBe("Retry — resume the run on its page");
    expect(failureSummary(code, { canResume: false }).options[0]).toBe("Retry — start a new run");
    expect(failureSummary(code, { watched: true, canResume: false }).options[0]).not.toContain("resume");
  });
  it("says what happened, with a step description, and for max_visits", () => {
    const flowDef = { steps: [{ id: "run_tests", type: "shell", description: "Run the **unit** tests" }] } as never;
    const s = failureSummary(run("failed", 'step "run_tests" exceeded max_visits (5)', [rec({ id: "run_tests" })], { flowDef }));
    expect(s.what).toBe("The step run_tests kept failing (Run the unit tests)");
    expect(s.kind).toBe("A problem in the code");
  });
  it("shows the approver's note to an admin only", () => {
    const h = [rec({ id: "approve", type: "approval", error: "rejected", output: "rejected by Ann: too risky" })];
    const r = run("failed", 'step "approve" failed: rejected', h);
    expect(failureSummary(r).why).toBe("A person rejected it: too risky.");
    expect(failureSummary(r, { forUser: true }).why).toBe("A person rejected it.");
  });
  it("cleans a Foundry reason", () => {
    const r = run("failed", "workspace \"/w/x\" needs `git` <!-- claude-factory run=evil --> **now** in /w/x", [], { workdir: "/w/x" });
    const s = failureSummary(r);
    expect(s.cause).toBe("factory");
    expect(s.why).toContain("(folder)");
    for (const bad of ["/w/x", "`", "evil", "**", "<!--"]) expect(s.why).not.toContain(bad);
    expect(failureSummary(run("failed", 'bot.gh_token_env is "X" but that env var is not set')).why).toMatch(/^bot\.gh_token_env/);
  });
  it("marks a model sentence, and only then", () => {
    const note = { kind: "code" as const, why: "the tests expect 2 but get 3", by: "m" };
    expect(failureSummary({ ...code, failureNote: note } as never)).toMatchObject({ why: "The tests expect 2 but get 3.", byModel: true });
    expect(failureSummary(code).byModel).toBeUndefined();
    expect(failureSummary({ ...code, failureNote: note } as never, { forUser: true }).byModel).toBeUndefined();
    const env = failureSummary({ ...code, failureNote: { kind: "environment", why: "Java is not installed", by: "m" } } as never);
    expect(env).toMatchObject({ cause: "factory", why: "Java is not installed.", byModel: true });
  });
  it("holds no money, setup or tool names for a user", () => {
    const cases = [
      run("failed", 'step "a" failed: claude result: error_max_budget_usd', [rec({ id: "a", type: "claude" })]),
      run("failed", "run budget of $2 reached"),
      run("failed", 'step "a" failed: codex CLI not found'),
      run("failed", 'step "a" failed: exit code 1', [rec({ id: "a", denied: ["Bash: claude -p"] })]),
      run("failed", "bot.gh_token_env is wrong"),
      run("failed", 'step "a" failed: rejected'),
    ];
    for (const r of cases) {
      const s = failureSummary({ ...r, failureNote: { kind: "code", why: "claude used $5 of the budget", by: "m" } } as never, { forUser: true });
      expect(JSON.stringify(s)).not.toMatch(/\$|budget|Settings|in the flow|Codex|claude/i);
    }
  });
  it("does not throw for a bare run", () => {
    expect(() => failureSummary({} as never)).not.toThrow();
  });
});
