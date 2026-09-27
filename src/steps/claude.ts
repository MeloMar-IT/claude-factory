import { runProcess } from "./process.js";

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
  onProgress?: (msg: string) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  output: string;
  sessionId?: string;
  costUsd?: number;
  numTurns?: number;
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
  message?: { content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }> };
}

export function buildClaudeArgs(o: ClaudeRunOptions): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (o.model) args.push("--model", o.model);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.allowedTools?.length) args.push("--allowedTools", o.allowedTools.join(","));
  if (o.systemPrompt) args.push("--append-system-prompt", o.systemPrompt);
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId);
  if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  // Pushing is a flow decision (shell steps + protected-branch hook), never Claude's.
  args.push("--disallowedTools", "Bash(git push*)");
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
  const bin = o.claudeBin ?? process.env.FACTORY_CLAUDE_BIN ?? "claude";
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
    error: ok ? undefined : `claude result: ${final.subtype ?? "error"}`,
  };
}
