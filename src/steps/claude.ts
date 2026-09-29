import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./process.js";

/** Where the Claude desktop app keeps its bundled Claude Code, one folder per version. */
const DESKTOP_CLAUDE_CODE = join(homedir(), "Library/Application Support/Claude/claude-code");

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;
function cmpVersion(a: string, b: string): number {
  const x = VERSION_RE.exec(a)?.slice(1).map(Number) ?? [0, 0, 0];
  const y = VERSION_RE.exec(b)?.slice(1).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

let pathVersion: string | null | undefined;

/**
 * FACTORY_CLAUDE_BIN, else the newest Claude Code on this Mac: `claude` on PATH or the one
 * bundled with the Claude desktop app (which updates itself). Newer models need a recent CLI.
 */
export function resolveClaudeBin(): string {
  if (process.env.FACTORY_CLAUDE_BIN) return process.env.FACTORY_CLAUDE_BIN;
  if (pathVersion === undefined) {
    try {
      pathVersion = VERSION_RE.exec(execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 15_000 }))?.[0] ?? null;
    } catch {
      pathVersion = null;
    }
  }
  let bundled: { version: string; bin: string } | undefined;
  try {
    for (const v of readdirSync(DESKTOP_CLAUDE_CODE).filter((d) => VERSION_RE.test(d)).sort(cmpVersion).reverse()) {
      const bin = join(DESKTOP_CLAUDE_CODE, v, "claude.app/Contents/MacOS/claude");
      try {
        accessSync(bin, constants.X_OK);
        bundled = { version: v, bin };
        break;
      } catch {
        // incomplete download of that version
      }
    }
  } catch {
    // no desktop app
  }
  if (bundled && (!pathVersion || cmpVersion(bundled.version, pathVersion) > 0)) return bundled.bin;
  return "claude";
}

/**
 * Unattended factory steps should not inherit the user's personal Claude Code setup (MCP
 * servers, plugins, skills, hooks, env): it bloats every turn and invites off-task detours.
 */
export const FACTORY_AGENT_NOTE = [
  "You are running unattended as one step of a claude-factory flow. Do only the task in the prompt.",
  "Ignore instructions from global or home-folder configuration about spawning agents or swarms,",
  "memory tools, hooks or other orchestration. Do not use skills. Do not look at other projects",
  "or at ~/.claude. Work only inside the current workspace.",
].join(" ");

export interface ClaudeRunOptions {
  prompt: string;
  cwd: string;
  logFile: string;
  claudeBin?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Sandbox Claude's bash tool (writes limited to the workspace). */
  sandbox?: boolean;
  /** Load no MCP servers (keeps the prompt small for local models). */
  noMcp?: boolean;
  /** Skip the user's personal setup: MCP servers, user settings (hooks, plugins, env), skills. */
  isolated?: boolean;
  /** low | medium | high | xhigh | max */
  effort?: string;
  onProgress?: (msg: string) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  output: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
}

export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.effort) args.push("--effort", o.effort);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(","));
  const system = [o.isolated ? FACTORY_AGENT_NOTE : "", o.systemPrompt ?? ""].filter(Boolean).join("\n\n");
  if (system) args.push("--append-system-prompt", system);
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);
  if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  // Pushing is a flow decision (shell steps + protected-branch hook), never Claude's.
  args.push("--disallowedTools", "Bash(git push*)");
  if (o.noMcp || o.isolated) args.push("--strict-mcp-config");
  if (o.isolated) args.push("--setting-sources", "project,local", "--disable-slash-commands");
  if (o.sandbox) args.push("--settings", JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }));
  return args;
}

function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const hint = input.file_path ?? input.command ?? input.pattern ?? input.description;
  const s = typeof hint === "string" ? hint.replace(/\s+/g, " ").slice(0, 80) : "";
  return s ? `${name}: ${s}` : name;
}

/** Run the local Claude Code CLI headlessly. The prompt goes via stdin. */
export async function runClaude(o: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const bin = o.claudeBin ?? resolveClaudeBin();
  let final: StreamEvent | undefined;

  const res = await runProcess(bin, buildClaudeArgs(o), {
    cwd: o.cwd,
    env: o.env,
    stdin: o.prompt,
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    logFile: o.logFile,
    onLine: (line) => {
      let ev: StreamEvent;
      try {
        ev = JSON.parse(line) as StreamEvent;
      } catch {
        return;
      }
      if (ev.type === "result") final = ev;
      else if (ev.type === "assistant" && o.onProgress) {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "tool_use" && c.name) o.onProgress(describeToolUse(c.name, c.input));
        }
      }
    },
  });

  if (res.aborted) return { ok: false, output: final?.result ?? "", error: "cancelled" };
  if (res.timedOut) return { ok: false, output: final?.result ?? "", error: "timed out" };
  if (!final) {
    return {
      ok: false,
      output: "",
      error: `claude exited with code ${res.exitCode} and no result. ${res.stderr.trim().slice(-500)}`,
    };
  }
  const ok = !final.is_error && final.subtype === "success" && res.exitCode === 0;
  return {
    ok,
    output: final.result ?? "",
    sessionId: final.session_id,
    costUsd: final.total_cost_usd,
    numTurns: final.num_turns,
    inputTokens: final.usage ? (final.usage.input_tokens ?? 0) + (final.usage.cache_read_input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0) : undefined,
    outputTokens: final.usage?.output_tokens,
    error: ok ? undefined : `claude result: ${final.subtype ?? "error"}`,
  };
}
