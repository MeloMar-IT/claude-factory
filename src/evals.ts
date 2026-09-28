import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Config } from "./config.js";
import type { RunSummary } from "./engine/state.js";
import { FACTORY_HOME, loadFlow } from "./flow/load.js";
import type { Flow } from "./flow/schema.js";
import { Scheduler } from "./queue/scheduler.js";
import { runShell } from "./steps/shell.js";

const CaseSchema = z
  .object({
    name: z.string().regex(/^[\w.-]+$/),
    /** Plain directory (turned into a git repo), local git repo, or git URL — relative to the suite file. */
    repo: z.string(),
    task: z.string().default(""),
    vars: z.record(z.string(), z.string()).default({}),
    /** Shell command run in the workspace afterwards; exit 0 = pass. Default: the run succeeded. */
    check: z.string().optional(),
  })
  .strict();

export const SuiteSchema = z
  .object({
    name: z.string().regex(/^[\w.-]+$/),
    description: z.string().optional(),
    flows: z.array(z.string()).min(1),
    /** Optional: run every flow once per model (overrides all claude steps). */
    models: z.array(z.string()).optional(),
    repeat: z.number().int().positive().max(20).default(1),
    cases: z.array(CaseSchema).min(1),
  })
  .strict();

export type Suite = z.infer<typeof SuiteSchema>;

export interface EvalResult {
  variant: string;
  case: string;
  attempt: number;
  runId: string;
  status: RunSummary["status"];
  passed: boolean;
  checkOutput?: string;
  costUsd: number;
  tokens: number;
  minutes: number;
  fixLoops: number;
}

export interface VariantSummary {
  variant: string;
  runs: number;
  passRate: number;
  avgCostUsd: number;
  avgTokens: number;
  avgMinutes: number;
  avgFixLoops: number;
}

export interface EvalReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  results: EvalResult[];
  summary: VariantSummary[];
}

export const evalsDir = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "evals");

export function loadSuite(path: string): Suite {
  const res = SuiteSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!res.success) throw new Error(`${path}: invalid suite\n${res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return res.data;
}

/** Force one model spec (e.g. sonnet, codex:gpt-5, ollama:qwen3-coder) on every agent step. */
export function withModel(flow: Flow, model: string): Flow {
  const f = structuredClone(flow);
  f.name = `${flow.name}@${model}`;
  f.defaults.model = model;
  delete f.defaults.agent;
  delete f.defaults.provider;
  for (const s of f.steps) {
    if (s.type !== "claude") continue;
    s.model = model;
    delete s.agent;
    delete s.provider;
  }
  return f;
}

/** A git repo for the case: fixtures are copied and committed, URLs cloned once per eval. */
function prepareRepo(spec: string, suiteDir: string, cache: Map<string, string>): string {
  if (cache.has(spec)) return cache.get(spec)!;
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });
  let dir: string;
  if (/^(https?:|git@|ssh:)/.test(spec)) {
    dir = mkdtempSync(join(tmpdir(), "factory-eval-"));
    git(dir, "clone", "-q", spec, ".");
  } else {
    const src = resolve(suiteDir, spec);
    if (!existsSync(src)) throw new Error(`case repo not found: ${src}`);
    if (existsSync(join(src, ".git"))) dir = src;
    else {
      dir = mkdtempSync(join(tmpdir(), `factory-eval-${basename(src)}-`));
      cpSync(src, dir, { recursive: true });
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "-c", "user.email=eval@factory", "-c", "user.name=eval", "commit", "-qm", "fixture");
    }
  }
  cache.set(spec, dir);
  return dir;
}

function summarize(results: EvalResult[]): VariantSummary[] {
  const by = new Map<string, EvalResult[]>();
  for (const r of results) by.set(r.variant, [...(by.get(r.variant) ?? []), r]);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  return [...by].map(([variant, rs]) => ({
    variant,
    runs: rs.length,
    passRate: round(rs.filter((r) => r.passed).length / rs.length, 3),
    avgCostUsd: round(avg(rs.map((r) => r.costUsd))),
    avgTokens: Math.round(avg(rs.map((r) => r.tokens ?? 0))),
    avgMinutes: round(avg(rs.map((r) => r.minutes)), 2),
    avgFixLoops: round(avg(rs.map((r) => r.fixLoops)), 2),
  }));
}

export async function runEval(o: {
  suitePath: string;
  runsDir: string;
  config: Config;
  flowsFilter?: string[];
  modelsOverride?: string[];
  claudeBin?: string;
  log: (m: string) => void;
}): Promise<{ report: EvalReport; file: string }> {
  const suite = loadSuite(o.suitePath);
  const suiteDir = dirname(resolve(o.suitePath));
  const flowNames = o.flowsFilter?.length ? o.flowsFilter : suite.flows;
  const models = o.modelsOverride?.length ? o.modelsOverride : suite.models;
  const variants: Flow[] = flowNames.flatMap((name) => {
    const { flow } = loadFlow(name, suiteDir);
    return models?.length ? models.map((m) => withModel(flow, m)) : [flow];
  }).map((f) => ({ ...f, one_per_repo: false })); // cases get their own worktrees: run them in parallel
  // Routing rules would override the model under test.
  const config = models?.length ? { ...o.config, router: { ...o.config.router, rules: [] } } : o.config;
  const scheduler = new Scheduler({ runsDir: o.runsDir, config: () => config, claudeBin: o.claudeBin });
  const repos = new Map<string, string>();
  const startedAt = new Date().toISOString();
  const jobs: Promise<EvalResult>[] = [];

  o.log(`eval ${suite.name}: ${variants.length} variant(s) × ${suite.cases.length} case(s) × ${suite.repeat} = ${variants.length * suite.cases.length * suite.repeat} runs (concurrency ${o.config.concurrency})`);
  for (const flow of variants) {
    for (const c of suite.cases) {
      const repo = prepareRepo(c.repo, suiteDir, repos);
      for (let attempt = 1; attempt <= suite.repeat; attempt++) {
        const runId = scheduler.submit({ kind: "run", flow, task: c.task, repo, vars: c.vars }, { source: `eval ${suite.name}` });
        jobs.push((async () => {
          const s = (await scheduler.wait(runId))!;
          let passed = s.status === "succeeded";
          let checkOutput: string | undefined;
          if (c.check && s.workdir && existsSync(s.workdir)) {
            const logFile = join(s.runDir, "eval-check.log");
            const r = await runShell({ command: c.check, cwd: s.workdir, env: {}, logFile, timeoutMs: 600_000 });
            passed = r.ok;
            checkOutput = r.output.slice(-2000);
          }
          const res: EvalResult = {
            variant: flow.name, case: c.name, attempt, runId, status: s.status, passed, checkOutput,
            costUsd: s.totalCostUsd,
            tokens: s.history.reduce((n, h) => n + (h.tokens ? h.tokens.input + h.tokens.output : 0), 0),
            minutes: s.finishedAt ? (new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000 : 0,
            fixLoops: s.history.reduce((n, h) => n + (h.visit > 1 ? 1 : 0), 0),
          };
          o.log(`${passed ? "✔" : "✘"} ${flow.name} · ${c.name}#${attempt} · ${s.status} · $${s.totalCostUsd.toFixed(3)} · run ${runId}`);
          return res;
        })());
      }
    }
  }
  const results = await Promise.all(jobs);
  const report: EvalReport = { suite: suite.name, startedAt, finishedAt: new Date().toISOString(), results, summary: summarize(results) };
  mkdirSync(evalsDir(), { recursive: true });
  const file = join(evalsDir(), `${suite.name}-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return { report, file };
}

export function listEvalReports(limit = 20): (Omit<EvalReport, "results"> & { file: string })[] {
  const dir = evalsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      const { results: _results, ...rest } = JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalReport;
      return { ...rest, file: join(dir, f) };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
