import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { learningsFile, resumeRun, runFlow } from "../src/engine/runner.js";
import { dockerCommand } from "../src/engine/guards.js";
import { liveLogFile, saveRun } from "../src/engine/state.js";
import { mirrorEnvPrefixes, withScfAliases } from "../src/engine/template.js";
import { notifyRun } from "../src/notify.js";
import { COMMENT_KINDS, commentText, runNextStep } from "../src/next-step.js";
import { parseFlow } from "../src/flow/load.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let repo: string;
let runsDir: string;
const baseConfig = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-engine-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const start = (yaml: string, opts: { vars?: Record<string, string>; config?: Config; task?: string } = {}) =>
  runFlow(parseFlow(yaml), { task: opts.task ?? "t", repo, runsDir, claudeBin, vars: opts.vars, config: opts.config ?? baseConfig() });
const resume = (runId: string, extra: Partial<Parameters<typeof resumeRun>[0]> = {}) =>
  resumeRun({ runId, runsDir, claudeBin, config: baseConfig(), ...extra });

describe("next-step sentences in the step environment", () => {
  const names = COMMENT_KINDS.map((k) => k.toUpperCase());
  const print = (prefix: string) => names.map((n) => `echo "$${prefix}_NEXT_${n}"`).join("; ");

  it("gives shell steps FACTORY_NEXT_… and SCF_NEXT_… with the module's sentences", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: f, type: shell, run: '${print("FACTORY")}'}
  - {id: s, type: shell, run: '${print("SCF")}'}
`);
    expect(s.status).toBe("succeeded");
    const want = COMMENT_KINDS.map(commentText);
    expect(s.history[0]!.output.trim().split("\n")).toEqual(want);
    expect(s.history[1]!.output.trim().split("\n")).toEqual(want);
  });

  it("resumes a run whose stored flow has the old hard-coded text", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: ask, type: shell, run: 'echo "Reply **/approve** to continue or **/reject** to stop (optionally followed by a note)."'}
  - {id: gate, type: approval, message: "Go?"}
  - {id: after, type: shell, run: 'echo "$FACTORY_NEXT_APPROVAL"'}
`);
    expect(s.status).toBe("waiting");
    const r = await resume(s.runId, { decision: { approved: true, by: "marcel" } });
    expect(r.status).toBe("succeeded");
    expect(r.history.find((h) => h.id === "ask")!.output).toContain("Reply **/approve** to continue");
    expect(r.history.find((h) => h.id === "after")!.output.trim()).toBe(commentText("approval"));
  });
});

describe("approvals", () => {
  const FLOW = `
name: t
workspace: inplace
steps:
  - {id: before, type: shell, run: echo before}
  - {id: ok_to_push, type: approval, message: "Push {{vars.what}}?", on_failure: rejected}
  - {id: push, type: shell, run: echo pushed, on_success: end}
  - {id: rejected, type: shell, run: echo rejected, jump_only: true}
`;

  it("waits, then continues on approve", async () => {
    const s = await start(FLOW, { vars: { what: "branch x" } });
    expect(s.status).toBe("waiting");
    expect(s.waiting?.message).toBe("Push branch x?");
    expect(s.state.next).toBe("ok_to_push");
    const r = await resume(s.runId, { decision: { approved: true, by: "marcel" } });
    expect(r.status).toBe("succeeded");
    expect(r.history.map((h) => h.id)).toEqual(["before", "ok_to_push", "push"]);
    expect(r.history[1]!.output).toBe("approved by marcel");
  });

  it("follows on_failure on reject", async () => {
    const s = await start(FLOW, { vars: { what: "x" } });
    const r = await resume(s.runId, { decision: { approved: false, by: "marcel", note: "not yet" } });
    expect(r.history.map((h) => h.id)).toEqual(["before", "ok_to_push", "rejected"]);
    expect(r.history[1]!.output).toBe("rejected by marcel: not yet");
  });

  it("refuses a decision for a run that is not waiting", async () => {
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}");
    await expect(resume(s.runId, { decision: { approved: true } })).rejects.toThrow(/not waiting/);
  });
});

describe("resume", () => {
  it("retries a failed step, keeping earlier outputs", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: echo first}
  - {id: b, type: shell, run: test -f ok}
  - {id: c, type: shell, run: 'echo "a said $FACTORY_OUT_A"'}
`);
    expect(s.status).toBe("failed");
    expect(s.state.next).toBe("b");
    writeFileSync(join(repo, "ok"), "");
    const r = await resume(s.runId);
    expect(r.status).toBe("succeeded");
    expect(r.resumes).toBe(1);
    expect(r.history.map((h) => h.id)).toEqual(["a", "b", "b", "c"]);
    expect(r.history.at(-1)!.output.trim()).toBe("a said first");
    expect(readFileSync(liveLogFile(r.runDir), "utf8")).toContain("↻ resuming run");
  });

  it("restarts at resume_from after a stop, or at the step that jumped to the handler", async () => {
    const flow = (resumeFrom: string) => `
name: t
workspace: inplace
steps:
  - {id: fetch, type: shell, run: echo fetched}
  - {id: plan, type: shell, run: test -f answered, on_failure: ask}
  - {id: ask, type: shell, run: echo asking, jump_only: true, on_success: stop${resumeFrom}}
  - {id: build, type: shell, run: echo built}
`;
    const s1 = await start(flow(", resume_from: fetch"));
    expect(s1.status).toBe("stopped");
    expect(s1.state.next).toBe("fetch");
    const s2 = await start(flow(""));
    expect(s2.state.next).toBe("plan");
    writeFileSync(join(repo, "answered"), "");
    const r = await resume(s2.runId);
    expect(r.history.map((h) => h.id)).toEqual(["fetch", "plan", "ask", "plan", "build"]);
  });
});

describe("control flow", () => {
  it("routes on output", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - id: triage
    type: shell
    run: 'echo "ROUTE: small"'
    routes: [{if: "^ROUTE: big", goto: big}, {if: "^ROUTE: small", goto: small}]
  - {id: big, type: shell, run: echo big, on_success: end}
  - {id: small, type: shell, run: echo small}
`);
    expect(s.history.map((h) => h.id)).toEqual(["triage", "small"]);
  });

  it("runs steps in parallel", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: both, type: parallel, steps: [a, b]}
  - {id: a, type: shell, run: sleep 1 && echo A, jump_only: true}
  - {id: b, type: shell, run: sleep 1 && echo B, jump_only: true}
`);
    expect(s.status).toBe("succeeded");
    // Both ran at the same time: each started before the other finished.
    const [a, b] = ["a", "b"].map((id) => s.history.find((h) => h.id === id)!);
    const end = (h: typeof a) => new Date(h!.startedAt).getTime() + h!.durationMs;
    expect(new Date(a!.startedAt).getTime()).toBeLessThan(end(b));
    expect(new Date(b!.startedAt).getTime()).toBeLessThan(end(a));
    expect(s.history.map((h) => h.id).sort()).toEqual(["a", "b", "both"]);
    expect(s.history.find((h) => h.id === "both")!.output).toContain("## a\nA");
  });

  it("runs a sub-flow in the same workspace with its own vars", async () => {
    mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "flows", "child.yaml"), `
name: child
workspace: inplace
vars: {greeting: hi}
steps:
  - {id: write, type: shell, run: 'echo "{{vars.greeting}} {{vars.who}}" > sub.txt'}
  - {id: read, type: shell, run: cat sub.txt}
`);
    const s = await start(`
name: t
workspace: inplace
vars: {name: world}
steps:
  - {id: call, type: flow, flow: child, vars: {who: "{{vars.name}}"}}
  - {id: after, type: shell, run: 'echo "got: $FACTORY_OUT_CALL"'}
`);
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.id)).toEqual(["call/write", "call/read", "call", "after"]);
    expect(s.history.at(-1)!.output.trim()).toBe("got: hi world");
  });
});

describe("budgets", () => {
  it("fails a run over its cost limit", async () => {
    const s = await start(`
name: t
workspace: inplace
limits: {max_cost_usd: 0.015}
steps:
  - {id: a, type: claude, prompt: one}
  - {id: b, type: claude, prompt: two}
  - {id: c, type: claude, prompt: three}
`);
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/run budget of \$0.015 reached/);
    expect(s.history).toHaveLength(2);
  });

  it("with cost limits off, records costs but never stops on money (fixed-price subscriptions)", async () => {
    const config = baseConfig({ cost_limits: false, daily_budget_usd: 0.01 });
    const s = await start(`
name: t
workspace: inplace
defaults: {max_budget_usd: 0.5}
limits: {max_cost_usd: 0.015}
steps:
  - {id: a, type: claude, prompt: one}
  - {id: b, type: claude, prompt: two}
  - {id: c, type: claude, prompt: three}
`, { config });
    expect(s.status).toBe("succeeded");
    expect(s.history).toHaveLength(3);
    expect(s.totalCostUsd).toBeCloseTo(0.03); // still recorded
    // Claude Code is not given a budget cap either.
    expect(s.history[0]!.output).not.toContain("--max-budget-usd");
  });

  it("stops (resumably) when the daily budget is spent", async () => {
    const config = baseConfig({ daily_budget_usd: 0.01 });
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: one}
  - {id: b, type: claude, prompt: two}
`, { config });
    expect(s.status).toBe("stopped");
    expect(s.reason).toMatch(/daily budget/);
    expect(s.state.next).toBe("b");
  });
});

describe("safety", () => {
  it("blocks pushes to protected branches via a pre-push hook", async () => {
    const remote = join(tmp, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "f"), "x");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    git("remote", "add", "origin", remote);
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: to_main, type: shell, run: git push -q origin HEAD:main 2>&1, on_failure: next}
  - {id: to_feature, type: shell, run: git push -q origin HEAD:refs/heads/factory/x 2>&1}
`, { config: baseConfig({ protected_branches: ["main", "release/*"] }) });
    expect(s.history[0]!.ok).toBe(false);
    expect(s.history[0]!.output).toContain("Spaghetti Code Foundry: pushing to protected branch 'main' is blocked");
    expect(s.history[1]!.ok).toBe(true);
    expect(s.status).toBe("succeeded");
  });

  it("tells Claude it may not push", async () => {
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: claude, prompt: hi}");
    expect(s.history[0]!.output).toContain("--disallowedTools Bash(git push*)");
  });
});

describe("context", () => {
  it("merges repo config vars and exposes learnings", async () => {
    mkdirSync(join(repo, ".claude-factory"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "config.yaml"), "vars:\n  test_cmd: make test\n");
    const lf = learningsFile({}, repo);
    mkdirSync(join(lf, ".."), { recursive: true });
    writeFileSync(lf, "- tests need a running db\n");
    const s = await start(`
name: t
workspace: inplace
vars: {test_cmd: npm test}
steps:
  - {id: a, type: shell, run: 'echo "{{vars.test_cmd}}"; cat "$FACTORY_LEARNINGS_FILE"'}
  - {id: b, type: claude, prompt: "Known issues: {{learnings}}"}
`);
    expect(s.history[0]!.output).toContain("make test");
    expect(s.history[0]!.output).toContain("running db");
    expect(s.history[1]!.output).toContain("Known issues: - tests need a running db");
  });
});

describe("schema", () => {
  it("validates new step types", () => {
    expect(() => parseFlow("name: t\nsteps:\n  - {id: p, type: parallel, steps: [a, nope]}\n  - {id: a, type: shell, run: x}")).toThrow(/unknown step "nope"/);
    expect(() => parseFlow("name: t\nsteps:\n  - {id: a, type: shell, run: x, routes: [{if: '(', goto: a}]}")).toThrow(/invalid regex/);
    expect(existsSync("flows")).toBe(true);
  });
});

describe("SCF_ names", () => {
  it("gives steps every FACTORY_ variable also as SCF_", async () => {
    const s = await start(`
name: t
workspace: inplace
vars: {x: hello}
steps:
  - {id: a, type: shell, run: 'echo first'}
  - {id: b, type: shell, run: 'printf "%s|%s|%s|%s|%s" "$SCF_TASK" "$SCF_RUN_ID" "$SCF_VAR_X" "$SCF_OUT_A" "$SCF_TOOLS"'}
  - {id: c, type: shell, run: 'printf "%s|%s|%s|%s|%s" "$FACTORY_TASK" "$FACTORY_RUN_ID" "$FACTORY_VAR_X" "$FACTORY_OUT_A" "$FACTORY_TOOLS"'}
`);
    const b = s.history.find((h) => h.id === "b")!.output;
    expect(b).toBe(s.history.find((h) => h.id === "c")!.output);
    expect(b).toContain(s.runId);
    expect(b).toContain("hello");
    expect(b.startsWith("|")).toBe(false);
  });

  it("copes with large step outputs under both names", async () => {
    const steps = Array.from({ length: 20 }, (_, i) => `  - {id: s${i + 1}, type: shell, run: "printf '%020000d' 0"}`).join("\n");
    const s = await start(`name: t\nworkspace: inplace\nsteps:\n${steps}\n  - {id: last, type: shell, run: 'echo "\${#SCF_OUT_S1} \${#FACTORY_OUT_S20}"'}\n`);
    expect(s.status).toBe("succeeded");
    expect(s.history.at(-1)!.output.trim()).toBe("20000 20000");
  });

  it("withScfAliases adds SCF_ copies without touching the input", () => {
    const input = { FACTORY_A: "1", SCF_A: "stale", OTHER: "x" };
    expect(withScfAliases(input)).toEqual({ FACTORY_A: "1", SCF_A: "1", OTHER: "x" });
    expect(input.SCF_A).toBe("stale");
  });

  it("mirrorEnvPrefixes lets SCF_ win and fills the gaps", () => {
    const env: NodeJS.ProcessEnv = { SCF_HOME: "/new", FACTORY_HOME: "/old", FACTORY_NO_OPEN: "1", SCF_CLAUDE_BIN: "/c", PATH: "/bin" };
    expect(mirrorEnvPrefixes(env)).toBe(env);
    expect(env.SCF_HOME).toBe("/new");
    expect(env.FACTORY_HOME).toBe("/new");
    expect(env.SCF_NO_OPEN).toBe("1");
    expect(env.FACTORY_CLAUDE_BIN).toBe("/c");
    expect(env.PATH).toBe("/bin");
  });

  it("dockerCommand passes SCF_TOOLS itself and the other names through", () => {
    const { args } = dockerCommand("img", "/w", "c", ["FACTORY_TASK", "SCF_TASK", "FACTORY_TOOLS", "SCF_TOOLS"]);
    expect(args).toContain("SCF_TOOLS=/factory-tools");
    expect(args).toContain("FACTORY_TOOLS=/factory-tools");
    const i = args.indexOf("SCF_TASK");
    expect(args[i - 1]).toBe("-e");
    expect(args).not.toContain("SCF_TOOLS");
    expect(args).not.toContain("FACTORY_TOOLS");
  });

  it("notify commands get both names", async () => {
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    const out = join(tmp, "n");
    const saved = process.env.FACTORY_NO_NOTIFY;
    delete process.env.FACTORY_NO_NOTIFY;
    try {
      await notifyRun(baseConfig({ notify: { macos: false, command: `printf "%s %s" "$SCF_STATUS" "$FACTORY_STATUS" > ${out}` } }), s);
    } finally {
      process.env.FACTORY_NO_NOTIFY = saved;
    }
    expect(readFileSync(out, "utf8")).toBe("succeeded succeeded");
  });

  it("FACTORY_MESSAGE says who has to do what", async () => {
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    const out = join(tmp, "msg");
    const messageFor = async (run: typeof s) => {
      const saved = process.env.FACTORY_NO_NOTIFY;
      delete process.env.FACTORY_NO_NOTIFY;
      try {
        await notifyRun(baseConfig({ notify: { macos: false, command: `printf "%s" "$FACTORY_MESSAGE" > ${out}` } }), run);
      } finally {
        process.env.FACTORY_NO_NOTIFY = saved;
      }
      return readFileSync(out, "utf8");
    };
    const waiting = { ...s, status: "waiting", waiting: { stepId: "gate", message: "Deploy now?", since: "x" } } as typeof s;
    const w = await messageFor(waiting);
    expect(w).toContain("approve or reject it on the run page");
    expect(w.endsWith(runNextStep(waiting).text)).toBe(true);
    const failed = { ...s, status: "failed", reason: 'step "a" failed: boom' } as typeof s;
    const f = await messageFor(failed);
    expect(f).toContain("resume the run on its page");
    expect(f.endsWith(runNextStep(failed).text)).toBe(true);

    // A long task and a long reason are shortened; the action stays whole.
    const long = { ...s, task: "t".repeat(400), status: "failed", reason: `step "a" failed: ${"boom ".repeat(100)}` } as typeof s;
    const l = await messageFor(long);
    expect(l.length).toBeLessThanOrEqual(300);
    expect(l.endsWith("resume the run on its page.")).toBe(true);
  });

  it("notifyRun does not post to Slack, but still runs the command", async () => {
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    let posts = 0;
    const server = createServer((req, res) => {
      posts++;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const out = join(tmp, "cmd");
    const saved = process.env.FACTORY_NO_NOTIFY;
    delete process.env.FACTORY_NO_NOTIFY;
    try {
      const slack_webhook = `http://127.0.0.1:${port}/hook`;
      await notifyRun(baseConfig({ notify: { macos: false, slack_webhook } }), s);
      await notifyRun(baseConfig({ notify: { macos: false, slack_webhook } }), { ...s, status: "failed" } as typeof s);
      expect(posts).toBe(0);
      await notifyRun(baseConfig({ notify: { macos: false, slack_webhook, command: `printf ran > ${out}` } }), s);
      expect(posts).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("ran");
    } finally {
      process.env.FACTORY_NO_NOTIFY = saved;
      server.close();
    }
  });

  it("names the product when a run is too old to resume", async () => {
    const s = await start("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n");
    saveRun({ ...s, flowDef: undefined } as unknown as typeof s);
    await expect(resume(s.runId)).rejects.toThrow("older version of Spaghetti Code Foundry");
  });
});
