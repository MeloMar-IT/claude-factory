import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { runProcess } from "./process.js";

/** Codex CLIs that ship inside apps (the ChatGPT desktop app bundles one). */
const BUNDLED_CODEX = ["/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/Codex.app/Contents/Resources/codex"];

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** FACTORY_CODEX_BIN, else `codex` on PATH, else the one bundled with the ChatGPT app. */
export function resolveCodexBin(): string {
  if (process.env.FACTORY_CODEX_BIN) return process.env.FACTORY_CODEX_BIN;
  const onPath = (process.env.PATH ?? "").split(delimiter).some((d) => d && executable(join(d, "codex")));
  if (onPath) return "codex";
  return BUNDLED_CODEX.find(executable) ?? "codex";
}

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexRunOptions {
  prompt: string;
  cwd: string;
  logFile: string;
  codexBin?: string;
  model?: string;
  /** ollama | lmstudio: run on a local model instead of OpenAI. */
  localProvider?: string;
  /** Base URL of the local provider, if not the default port. */
  localBaseUrl?: string;
  systemPrompt?: string;
  sandbox: CodexSandbox;
  resumeSessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onProgress?: (msg: string) => void;
}

export interface CodexRunResult {
  ok: boolean;
  output: string;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

interface CodexItem {
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  query?: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
  message?: string;
}

const toml = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string

export function buildCodexArgs(o: CodexRunOptions): string[] {
  const args = ["exec"];
  if (o.resumeSessionId) args.push("resume");
  args.push("--json", "--skip-git-repo-check", "-c", `sandbox_mode=${toml(o.sandbox)}`, "-c", `approval_policy=${toml("never")}`);
  if (o.model) args.push("-m", o.model);
  if (o.localProvider) args.push("-c", `model_provider=${toml(o.localProvider)}`);
  if (o.resumeSessionId) args.push(o.resumeSessionId);
  else args.push("-C", o.cwd, "--color", "never");
  args.push("-");
  return args;
}

function describe(item: CodexItem): string | undefined {
  switch (item.type) {
    case "command_execution": return `Bash: ${(item.command ?? "").replace(/\s+/g, " ").slice(0, 80)}`;
    case "file_change": return `Edit: ${(item.changes ?? []).map((c) => c.path).join(", ").slice(0, 80)}`;
    case "mcp_tool_call": return `${item.server}.${item.tool}`;
    case "web_search": return `WebSearch: ${item.query ?? ""}`;
    default: return undefined;
  }
}

/** Run the OpenAI Codex CLI headlessly (`codex exec --json`). The prompt goes via stdin. */
export async function runCodex(o: CodexRunOptions): Promise<CodexRunResult> {
  const bin = o.codexBin ?? resolveCodexBin();
  const prompt = o.systemPrompt ? `<instructions>\n${o.systemPrompt}\n</instructions>\n\n${o.prompt}` : o.prompt;
  let sessionId: string | undefined;
  let last = "";
  let failure: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  const env: NodeJS.ProcessEnv = { ...o.env, NO_COLOR: "1" };
  if (o.localProvider && o.localBaseUrl) env.CODEX_OSS_BASE_URL = `${o.localBaseUrl.replace(/\/$/, "")}/v1`;

  let res;
  try {
    res = await runProcess(bin, buildCodexArgs(o), {
      cwd: o.cwd,
      env,
      stdin: prompt,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      logFile: o.logFile,
      onLine: (line) => {
        let ev: CodexEvent;
        try {
          ev = JSON.parse(line) as CodexEvent;
        } catch {
          return;
        }
        if (ev.type === "thread.started") sessionId = ev.thread_id;
        else if (ev.type === "turn.completed") {
          inputTokens += ev.usage?.input_tokens ?? 0;
          outputTokens += ev.usage?.output_tokens ?? 0;
        } else if (ev.type === "turn.failed") failure = ev.error?.message ?? "turn failed";
        else if (ev.type === "error") failure = ev.message ?? "error";
        else if (ev.type === "item.completed" && ev.item) {
          if (ev.item.type === "agent_message") last = ev.item.text ?? "";
          const d = describe(ev.item);
          if (d) o.onProgress?.(d);
        }
      },
    });
  } catch (e) {
    const msg = /ENOENT/.test((e as Error).message) ? `codex CLI not found — install it with: npm i -g @openai/codex` : (e as Error).message;
    return { ok: false, output: "", inputTokens, outputTokens, error: msg };
  }

  const base = { output: last, sessionId, inputTokens, outputTokens };
  if (res.aborted) return { ...base, ok: false, error: "cancelled" };
  if (res.timedOut) return { ...base, ok: false, error: "timed out" };
  if (failure || res.exitCode !== 0) {
    const err = failure ?? `codex exited with code ${res.exitCode}. ${res.stderr.trim().slice(-500)}`;
    return { ...base, ok: false, error: /not logged in|401|unauthorized/i.test(err) ? `${err} — run \`codex login\`` : err };
  }
  return { ...base, ok: true };
}
