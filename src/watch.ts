import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runFlow, type RunSummary } from "./engine/runner.js";
import type { Flow } from "./flow/schema.js";

const exec = promisify(execFile);

/** Status labels the watcher puts on issues. Remove one to have the issue picked up again. */
export const STATUS_LABELS = {
  working: { name: "factory:working", color: "1d4ed8", description: "claude-factory is working on this" },
  done: { name: "factory:done", color: "15803d", description: "claude-factory finished this" },
  needsInfo: { name: "factory:needs-info", color: "d97706", description: "claude-factory needs more information" },
  failed: { name: "factory:failed", color: "b91c1c", description: "claude-factory run failed" },
} as const;

const ALL_STATUS: string[] = Object.values(STATUS_LABELS).map((l) => l.name);

export interface WatchOptions {
  flow: Flow;
  repo: string;
  runsDir: string;
  vars: Record<string, string>;
  /** Issues with this label are picked up. */
  label: string;
  intervalMs: number;
  /** Max issues to process per check (runs are sequential). */
  maxPerTick: number;
  once?: boolean;
  signal?: AbortSignal;
  claudeBin?: string;
  log: (msg: string) => void;
}

/** "5m" | "30s" | "1h" | "10" (minutes) → ms. */
export function parseInterval(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`invalid interval "${text}" (use e.g. 30s, 5m, 1h)`);
  const n = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"];
  if (n < 10_000) throw new Error("interval must be at least 10s");
  return n;
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await exec(process.env.FACTORY_GH_BIN ?? "gh", args, { maxBuffer: 10_000_000 });
  return stdout;
}

interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
}

export async function findIssues(githubRepo: string, label: string): Promise<Issue[]> {
  const out = await gh(["issue", "list", "--repo", githubRepo, "--label", label, "--state", "open", "--limit", "50", "--json", "number,title,labels"]);
  const issues = JSON.parse(out) as Issue[];
  return issues
    .filter((i) => !i.labels.some((l) => ALL_STATUS.includes(l.name)))
    .sort((a, b) => a.number - b.number); // oldest first
}

async function setStatus(githubRepo: string, issue: number, add?: string) {
  const args = ["issue", "edit", String(issue), "--repo", githubRepo];
  for (const l of ALL_STATUS) if (l !== add) args.push("--remove-label", l);
  if (add) args.push("--add-label", add);
  await gh(args);
}

/** Label for a finished run; undefined (clear all) when cancelled, so the issue is retried. */
function statusLabelFor(s: RunSummary): string | undefined {
  if (s.status === "cancelled") return undefined;
  if (s.status === "succeeded") return STATUS_LABELS.done.name;
  if (s.status === "stopped") return STATUS_LABELS.needsInfo.name;
  return STATUS_LABELS.failed.name;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Poll GitHub for labelled issues and run the flow on each, one at a time.
 * A check never overlaps a running flow: the next check starts `intervalMs` after the previous one began,
 * or right after a long run finishes.
 */
export async function watch(o: WatchOptions): Promise<void> {
  const githubRepo = o.vars.github_repo ?? o.flow.vars.github_repo;
  if (!githubRepo || githubRepo === "owner/repo") throw new Error("set the GitHub repo: --var github_repo=owner/repo");
  if (!("issue" in o.flow.vars)) throw new Error(`flow "${o.flow.name}" has no "issue" variable, so it can't take tickets`);

  await gh(["repo", "view", githubRepo, "--json", "nameWithOwner"]).catch((e: Error) => {
    throw new Error(`cannot access ${githubRepo} with gh: ${e.message.split("\n")[0]}`);
  });
  for (const l of [{ name: o.label, color: "c2410c", description: "Let claude-factory work on this issue" }, ...Object.values(STATUS_LABELS)]) {
    await gh(["label", "create", l.name, "--repo", githubRepo, "--color", l.color, "--description", l.description, "--force"]);
  }
  o.log(`watching ${githubRepo} for open issues labelled "${o.label}" every ${Math.round(o.intervalMs / 1000)}s (flow ${o.flow.name})`);

  while (!o.signal?.aborted) {
    const started = Date.now();
    try {
      const issues = await findIssues(githubRepo, o.label);
      if (!issues.length) o.log(`${new Date().toLocaleTimeString()} no new issues`);
      for (const issue of issues.slice(0, o.maxPerTick)) {
        if (o.signal?.aborted) break;
        o.log(`▶ #${issue.number} ${issue.title}`);
        await setStatus(githubRepo, issue.number, STATUS_LABELS.working.name);
        const summary = await runFlow(o.flow, {
          task: "",
          repo: o.repo,
          runsDir: o.runsDir,
          vars: { ...o.vars, github_repo: githubRepo, issue: String(issue.number) },
          claudeBin: o.claudeBin,
          signal: o.signal,
          log: (m) => o.log(`  ${m}`),
        });
        await setStatus(githubRepo, issue.number, statusLabelFor(summary)).catch((e: Error) =>
          o.log(`  ! could not update labels on #${issue.number}: ${e.message.split("\n")[0]}`));
        o.log(`${summary.status === "succeeded" ? "✔" : summary.status === "stopped" ? "■" : "✘"} #${issue.number} ${summary.status}` +
          `${summary.reason ? ` — ${summary.reason}` : ""} · $${summary.totalCostUsd.toFixed(4)} · run ${summary.runId}`);
      }
    } catch (e) {
      o.log(`! check failed: ${(e as Error).message.split("\n")[0]}`);
    }
    if (o.once) return;
    await sleep(Math.max(0, o.intervalMs - (Date.now() - started)), o.signal);
  }
}
