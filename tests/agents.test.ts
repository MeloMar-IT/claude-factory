import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { codexSandbox } from "../src/agents/run.js";
import { parseSpec, resolveTarget, toTarget } from "../src/agents/targets.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { readTranscript } from "../src/engine/transcript.js";
import { withModel } from "../src/evals.js";
import { parseFlow } from "../src/flow/load.js";
import type { ClaudeStep } from "../src/flow/schema.js";
import { buildClaudeArgs } from "../src/steps/claude.js";
import { buildCodexArgs } from "../src/steps/codex.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
const PROVIDERS = ["anthropic", "openai", "ollama", "lmstudio"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  delete process.env.CODEX_API_KEY;
});

describe("model specs", () => {
  it("peels agent and provider off the front; the rest is the model", () => {
    expect(parseSpec("sonnet", PROVIDERS)).toEqual({ model: "sonnet" });
    expect(parseSpec("codex", PROVIDERS)).toEqual({ agent: "codex" });
    expect(parseSpec("codex:gpt-5", PROVIDERS)).toEqual({ agent: "codex", model: "gpt-5" });
    expect(parseSpec("ollama:qwen3-coder:30b", PROVIDERS)).toEqual({ provider: "ollama", model: "qwen3-coder:30b" });
    expect(parseSpec("codex:ollama:gpt-oss:20b", PROVIDERS)).toEqual({ agent: "codex", provider: "ollama", model: "gpt-oss:20b" });
    expect(parseSpec("", PROVIDERS)).toEqual({});
  });

  it("fills default providers and rejects impossible pairs", () => {
    const c = cfg();
    expect(toTarget({ agent: "codex" }, c)).toMatchObject({ agent: "codex", providerName: "openai", free: true });
    expect(toTarget({ model: "opus" }, c)).toMatchObject({ agent: "claude", providerName: "anthropic", free: false, label: "claude:anthropic:opus" });
    expect(toTarget({ provider: "ollama", model: "q" }, c)).toMatchObject({ agent: "claude", free: true });
    expect(() => toTarget({ provider: "openai" }, c)).toThrow(/use agent codex/);
    expect(() => toTarget({ agent: "codex", provider: "anthropic" }, c)).toThrow(/can't use/);
    expect(() => toTarget({ provider: "ollama" }, c)).toThrow(/needs a model/);
    expect(() => toTarget({ provider: "nope" }, c)).toThrow(/unknown provider/);
    const withDefault = cfg({ providers: { ollama: { kind: "ollama", default_model: "qwen3-coder" } } });
    expect(toTarget({ provider: "ollama" }, withDefault)).toMatchObject({ model: "qwen3-coder", provider: { base_url: "http://localhost:11434" } });
  });
});

describe("routing", () => {
  const flow = parseFlow(`
name: f
defaults: {model: sonnet}
steps:
  - {id: review, type: claude, model: opus, prompt: x}
  - {id: fix, type: claude, prompt: x}
  - {id: cross, type: claude, agent: codex, prompt: x}
`);
  const step = (id: string) => flow.steps.find((s) => s.id === id) as ClaudeStep;

  it("uses step model, then flow default; a switched agent doesn't inherit the other agent's model", () => {
    const c = cfg();
    expect(resolveTarget(step("review"), flow, c, 1).label).toBe("claude:anthropic:opus");
    expect(resolveTarget(step("fix"), flow, c, 1).label).toBe("claude:anthropic:sonnet");
    expect(resolveTarget(step("cross"), flow, c, 1).label).toBe("codex:openai");
  });

  it("lets the first matching rule win, even over a model set in the flow", () => {
    const c = cfg({ router: { rules: [
      { step: "^review$", model: "codex:gpt-5" },
      { step: "^fix$", min_visit: 2, model: "ollama:qwen3-coder:30b" },
    ] } });
    expect(resolveTarget(step("review"), flow, c, 1).label).toBe("codex:openai:gpt-5");
    expect(resolveTarget(step("fix"), flow, c, 1).label).toBe("claude:anthropic:sonnet");
    expect(resolveTarget(step("fix"), flow, c, 2).label).toBe("claude:ollama:qwen3-coder:30b");
  });

  it("maps permissions onto Codex sandboxes", () => {
    const f = parseFlow(`
name: f
steps:
  - {id: plan, type: claude, prompt: x, permission_mode: plan}
  - {id: ro, type: claude, prompt: x, permission_mode: dontAsk, allowed_tools: [Read, Grep]}
  - {id: rw, type: claude, prompt: x}
  - {id: yolo, type: claude, prompt: x, permission_mode: bypassPermissions}
`);
    const scope = { flow: f } as Parameters<typeof codexSandbox>[1];
    const mode = (id: string, sbx = false) => codexSandbox(f.steps.find((s) => s.id === id) as ClaudeStep, scope, sbx);
    expect([mode("plan"), mode("ro"), mode("rw"), mode("yolo"), mode("yolo", true)]).toEqual(["read-only", "read-only", "workspace-write", "danger-full-access", "workspace-write"]);
  });

  it("isolates Claude Code from the user's setup and passes effort", () => {
    const args = buildClaudeArgs({ prompt: "p", cwd: "/w", logFile: "/l", isolated: true, effort: "xhigh", systemPrompt: "extra" });
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--setting-sources", "project,local", "--disable-slash-commands", "--effort", "xhigh"]));
    const sys = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(sys).toContain("running unattended as one step of a claude-factory flow");
    expect(sys).toContain("extra");
    expect(buildClaudeArgs({ prompt: "p", cwd: "/w", logFile: "/l" })).not.toContain("--setting-sources");
    expect(buildCodexArgs({ prompt: "p", cwd: "/w", logFile: "/l", sandbox: "read-only", effort: "max" })).toContain('model_reasoning_effort="xhigh"');
  });

  it("builds codex exec args for new, local and resumed sessions", () => {
    const base = { prompt: "p", cwd: "/w", logFile: "/l", sandbox: "workspace-write" as const };
    expect(buildCodexArgs({ ...base, model: "gpt-5" })).toEqual(["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "-m", "gpt-5", "-C", "/w", "--color", "never", "-"]);
    expect(buildCodexArgs({ ...base, localProvider: "ollama" })).toContain('model_provider="ollama"');
    const r = buildCodexArgs({ ...base, resumeSessionId: "T1" });
    expect(r.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(r.slice(-2)).toEqual(["T1", "-"]);
  });
});

describe("running on other agents and providers", () => {
  let tmp: string;
  let repo: string;
  let runsDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-agents-"));
    repo = join(tmp, "repo");
    runsDir = join(tmp, "runs");
    mkdirSync(repo);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const start = (yaml: string, config = cfg()) => runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, config });

  it("runs a codex step, resumes its session, and records tokens at $0", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, agent: codex, model: gpt-5, prompt: "WRITE out.txt hi"}
  - {id: b, type: claude, agent: codex, resume: a, prompt: "SAY again"}
`);
    expect(s.status).toBe("succeeded");
    const [a, b] = s.history;
    expect(a!.agent).toBe("codex:openai:gpt-5");
    expect(a!.tokens).toEqual({ input: 1000, output: 50 });
    expect(a!.costUsd).toBe(0);
    expect(a!.output).toContain('sandbox_mode="workspace-write"');
    expect(b!.output).toBe("again");
    expect(b!.sessionId).toBe(a!.sessionId);

    const t = readTranscript(a!.logFile);
    expect(t.map((e) => e.kind)).toEqual(["tool", "tool", "text", "result"]);
    expect(t[0]).toMatchObject({ name: "Edit", input: { file_path: "out.txt" } });
    expect(t[1]).toMatchObject({ name: "Bash", result: "clean\n", isError: false });
  });

  it("points Claude Code at a local provider, without MCP, at $0", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, model: "ollama:qwen3-coder:30b", prompt: SHOWENV}
`);
    const out = s.history[0]!.output;
    expect(out).toContain("base=http://localhost:11434 token=ollama haiku=qwen3-coder:30b");
    expect(out).toContain("--strict-mcp-config");
    expect(out).toContain("--model qwen3-coder:30b");
    expect(s.history[0]!.costUsd).toBe(0);
    expect(s.history[0]!.agent).toBe("claude:ollama:qwen3-coder:30b");
  });

  it("falls back to the next model when one hits a usage limit", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "CLAUDE_LIMIT\\nSAY from codex"}
`, cfg({ router: { fallback: ["codex"] } }));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.agent).toBe("codex:openai");
    expect(s.history[0]!.output).toBe("from codex");
  });

  it("pauses the run on a usage limit when no fallback is left, and resumes where it stopped", async () => {
    const flow = `
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: echo before}
  - {id: b, type: claude, prompt: "{{vars.p}}"}
`;
    const s = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg(), vars: { p: "CLAUDE_LIMIT" } });
    expect(s.status).toBe("stopped");
    expect(s.reason).toMatch(/^usage limit reached: You've hit your limit .* continues automatically/);
    expect(s.state.next).toBe("b");
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg() });
    expect(r.status).toBe("stopped"); // still limited (same prompt) — but no visits were used up
    expect(r.state.visits.b ?? 0).toBe(0);
  });

  it("does not treat a long answer that mentions quota as a limit", async () => {
    const long = "x".repeat(500);
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "SAY quota exceeded ${long}", pass_if: NEVER}
`, cfg({ router: { fallback: ["codex"] } }));
    expect(s.status).toBe("failed");
    expect(s.history).toHaveLength(1);
  });

  it("does not fall back on ordinary failures", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "ERROR"}
`, cfg({ router: { fallback: ["codex"] } }));
    expect(s.status).toBe("failed");
    expect(s.history[0]!.agent).toBe("claude:anthropic");
  });

  it("continues on a free fallback when the run budget is used up", async () => {
    const flow = `
name: t
workspace: inplace
limits: {max_cost_usd: 0.005}
steps:
  - {id: a, type: claude, prompt: "SAY paid"}
  - {id: b, type: claude, prompt: "SAY free"}
`;
    const paused = await start(flow);
    expect(paused.status).toBe("failed");
    expect(paused.reason).toMatch(/run budget/);

    const s = await start(flow, cfg({ router: { fallback: ["sonnet", "codex"] } }));
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.agent)).toEqual(["claude:anthropic", "codex:openai"]);
    // Resuming keeps honouring it.
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, from: "b", config: cfg({ router: { fallback: ["codex"] } }) });
    expect(r.history.at(-1)!.agent).toBe("codex:openai");
  });

  it("does not resume a session across agents", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "SAY first"}
  - {id: b, type: claude, agent: codex, resume: a, prompt: "SAY second"}
`);
    expect(s.status).toBe("succeeded");
    expect(s.history[1]!.sessionId).not.toBe(s.history[0]!.sessionId);
  });
});

describe("evals", () => {
  it("withModel overrides agent and provider on every agent step", () => {
    const f = withModel(parseFlow(`
name: f
defaults: {agent: codex}
steps:
  - {id: a, type: claude, agent: codex, provider: openai, prompt: x}
`), "ollama:qwen3-coder");
    expect(f.name).toBe("f@ollama:qwen3-coder");
    const s = f.steps[0] as ClaudeStep;
    expect([s.agent, s.provider, s.model, f.defaults.agent]).toEqual([undefined, undefined, "ollama:qwen3-coder", undefined]);
  });
});
