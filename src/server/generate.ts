import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_HOME, flowDir, parseFlow } from "../flow/load.js";
import { runClaude } from "../steps/claude.js";

const SYSTEM = `You design workflow files for "Spaghetti Code Foundry". The reference you get describes the
complete format. Reply with ONLY the complete flow as YAML inside a single \`\`\`yaml code fence.
No other text. Use only the fields documented in the reference.`;

/** The flow-writing guide for AI assistants (docs/FLOW_AUTHORING.md); also printed by `factory flow-guide`. */
export const FLOW_GUIDE_PATH = join(flowDir("builtin", ""), "..", "docs", "FLOW_AUTHORING.md");

export function flowGuide(): string {
  if (existsSync(FLOW_GUIDE_PATH)) return readFileSync(FLOW_GUIDE_PATH, "utf8");
  return readFileSync(join(flowDir("builtin", ""), "feature.yaml"), "utf8"); // older installs
}

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
  const reference = flowGuide();
  const logDir = join(FACTORY_HOME, "generate");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${Date.now()}.log`);

  const prompt = current
    ? `Reference (the complete flow format):\n\n${reference}\n\nCurrent flow:\n\n\`\`\`yaml\n${current}\`\`\`\n\nChange it as follows: ${request}`
    : `Reference (the complete flow format):\n\n${reference}\n\nWrite a new flow for: ${request}`;

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
