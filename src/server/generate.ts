import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_HOME, flowDir, parseFlow } from "../flow/load.js";
import { runClaude } from "../steps/claude.js";

const SYSTEM = `You design workflow files for "claude-factory", a tool that runs YAML flows of
headless Claude Code CLI steps and shell steps against a git repository.
Reply with ONLY the complete flow as YAML inside a single \`\`\`yaml code fence. No other text.
Use only the fields documented in the reference. Keep prompts specific and actionable.
Prefer loops with on_failure/on_success + max_visits for verify/fix cycles, and pass_if gates for reviews.`;

function extractYaml(text: string): string {
  const m = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
  return (m ? m[1]! : text).trim() + "\n";
}

export interface GenerateResult {
  yaml: string;
  error?: string;
  costUsd: number;
}

/**
 * Ask the local claude CLI to draft (or revise) a flow. Retries once with the
 * validation error if the first draft is not a valid flow.
 */
export async function generateFlow(request: string, current?: string, claudeBin?: string): Promise<GenerateResult> {
  const reference = readFileSync(join(flowDir("builtin", ""), "feature.yaml"), "utf8");
  const logDir = join(FACTORY_HOME, "generate");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${Date.now()}.log`);

  const prompt = current
    ? `Reference flow (documents the format):\n\n${reference}\n\nCurrent flow:\n\n\`\`\`yaml\n${current}\`\`\`\n\nChange it as follows: ${request}`
    : `Reference flow (documents the format):\n\n${reference}\n\nWrite a new flow for: ${request}`;

  const base = {
    cwd: tmpdir(),
    logFile,
    claudeBin,
    model: "sonnet",
    systemPrompt: SYSTEM,
    permissionMode: "dontAsk",
    timeoutMs: 180_000,
  };
  let r = await runClaude({ ...base, prompt });
  let cost = r.costUsd ?? 0;
  if (!r.ok) return { yaml: current ?? "", error: r.error ?? "claude failed", costUsd: cost };

  let yaml = extractYaml(r.output);
  try {
    parseFlow(yaml);
    return { yaml, costUsd: cost };
  } catch (e) {
    r = await runClaude({
      ...base,
      resumeSessionId: r.sessionId,
      prompt: `That flow is invalid:\n${(e as Error).message}\nReply with the corrected complete YAML only.`,
    });
    cost += r.costUsd ?? 0;
    if (r.ok) yaml = extractYaml(r.output);
    try {
      parseFlow(yaml);
      return { yaml, costUsd: cost };
    } catch (e2) {
      return { yaml, error: (e2 as Error).message, costUsd: cost };
    }
  }
}
