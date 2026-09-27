import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { runClaude } from "../steps/claude.js";
import { runCodex } from "../steps/codex.js";
import { claudeProviderEnv, LOCAL_KINDS, providers, specOf, toTarget } from "./targets.js";

export interface ProviderStatus {
  name: string;
  kind: string;
  base_url?: string;
  ok: boolean;
  detail: string;
  /** Models the provider has available (local providers). */
  models: string[];
  /** Which agents can use it. */
  agents: string[];
}

export interface AgentStatus {
  agent: "claude" | "codex";
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  detail: string;
}

function run(cmd: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function agentStatuses(): Promise<AgentStatus[]> {
  const claudeBin = process.env.FACTORY_CLAUDE_BIN ?? "claude";
  const codexBin = process.env.FACTORY_CODEX_BIN ?? "codex";
  const [cv, xv, xl] = await Promise.all([run(claudeBin, ["--version"]), run(codexBin, ["--version"]), run(codexBin, ["login", "status"])]);
  return [
    { agent: "claude", installed: cv.ok, version: cv.ok ? cv.out.split("\n")[0] : undefined, detail: cv.ok ? "Claude Code CLI" : "not found — install Claude Code" },
    {
      agent: "codex",
      installed: xv.ok,
      version: xv.ok ? xv.out.split("\n")[0] : undefined,
      loggedIn: xv.ok ? xl.ok && !/not logged in/i.test(xl.out) : undefined,
      detail: !xv.ok ? "not found — npm i -g @openai/codex" : xl.ok && !/not logged in/i.test(xl.out) ? xl.out.split("\n")[0]! : "not logged in — run `codex login` (ChatGPT account) to use OpenAI models",
    },
  ];
}

export async function providerStatuses(config: Config): Promise<ProviderStatus[]> {
  return Promise.all(
    Object.entries(providers(config)).map(async ([name, p]): Promise<ProviderStatus> => {
      const base = { name, kind: p.kind, base_url: p.base_url, models: [] as string[] };
      try {
        switch (p.kind) {
          case "anthropic":
            return { ...base, ok: true, detail: "Claude Code's own login", agents: ["claude"] };
          case "openai":
            return { ...base, ok: true, detail: "Codex's own login (ChatGPT or CODEX_API_KEY)", agents: ["codex"] };
          case "ollama": {
            const d = await getJson(`${p.base_url}/api/tags`);
            const models = (d.models ?? []).map((m: { name: string }) => m.name);
            return { ...base, ok: true, models, detail: `${models.length} model(s)`, agents: ["claude", "codex"] };
          }
          case "lmstudio": {
            const d = await getJson(`${p.base_url}/v1/models`);
            const models = (d.data ?? []).map((m: { id: string }) => m.id);
            return { ...base, ok: true, models, detail: `${models.length} model(s)`, agents: ["claude", "codex"] };
          }
          case "anthropic-compatible": {
            const key = p.api_key_env ? process.env[p.api_key_env] : undefined;
            if (p.api_key_env && !key) return { ...base, ok: false, detail: `env var ${p.api_key_env} is not set`, agents: ["claude"] };
            return { ...base, ok: !!p.base_url, detail: p.base_url ? "configured" : "base_url missing", agents: ["claude"] };
          }
        }
      } catch (e) {
        return { ...base, ok: false, detail: `not reachable at ${p.base_url} (${(e as Error).message})`, agents: LOCAL_KINDS.includes(p.kind) ? ["claude", "codex"] : [] };
      }
    }),
  );
}

/** One tiny read-only prompt through a model spec, to check it really works end to end. */
export async function testSpec(spec: string, config: Config, bins: { claudeBin?: string } = {}) {
  const t = toTarget(specOf(spec, config), config);
  const dir = mkdtempSync(join(tmpdir(), "factory-test-"));
  const started = Date.now();
  const prompt = "Reply with exactly the word: OK";
  try {
    const r = t.agent === "codex"
      ? await runCodex({
          prompt, cwd: dir, logFile: join(dir, "log"), model: t.model, sandbox: "read-only", timeoutMs: 600_000,
          localProvider: LOCAL_KINDS.includes(t.provider.kind) ? t.provider.kind : undefined,
        })
      : await runClaude({
          prompt, cwd: dir, logFile: join(dir, "log"), model: t.model, claudeBin: bins.claudeBin, permissionMode: "plan",
          env: claudeProviderEnv(t), noMcp: LOCAL_KINDS.includes(t.provider.kind), timeoutMs: 600_000,
        });
    return { target: t.label, ok: r.ok && /\bOK\b/.test(r.output), output: r.output.slice(0, 500), error: r.error, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
