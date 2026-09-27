#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { resumeRun, runFlow, type RunSummary } from "./engine/runner.js";
import { listBlocks } from "./flow/blocks.js";
import { FACTORY_HOME, listFlows, loadFlow, resolveFlowPath } from "./flow/load.js";
import { startServer } from "./server/server.js";
import { loadConfig, WatcherSchema } from "./config.js";
import { cleanRuns } from "./clean.js";
import { runEval } from "./evals.js";
import { Scheduler } from "./queue/scheduler.js";
import { Watcher } from "./queue/watcher.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { fileURLToPath } from "node:url";

const USAGE = `claude-factory — run custom flows of headless Claude Code + shell steps

Usage:
  factory run <flow> --task "<text>" [options]   Run a flow against a repo
  factory resume <run-id> [--from <step>]        Continue a stopped/failed/interrupted run
  factory approve <run-id> [--note "..."]        Approve a run waiting at an approval step
  factory reject <run-id> [--note "..."]         Reject it (the flow's on_failure path runs)
  factory eval <suite.yaml> [--flows a,b] [--models sonnet,opus]
                                                 Benchmark flows/models on sample tasks
  factory clean [--older-than 7] [--purge] [--include-paused] [--dry-run]
                                                 Remove old run workspaces/worktrees (branches kept)
  factory flows [--repo <dir>]                   List available flows
  factory blocks [--repo <dir>]                  List reusable step blocks (the library)
  factory validate <flow|file.yaml>              Check a flow definition
  factory new <name> [--from <flow>] [--global]  Create your own flow (copies a template)
  factory ui [--port 4777] [--no-open]           Web UI + queue + watchers from config.yaml
  factory serve [--port 4777]                    Same without opening a browser (for services)
  factory service install|uninstall|status       Keep \`factory serve\` running as a macOS login agent
  factory watch [flow] --var github_repo=o/r     Every 5 min, run the flow (default github-issue) on
        [--every 5m] [--label claude-factory]    each open issue with the label; results are marked
        [--max 1] [--once] [--source pr-feedback]  with factory:* status labels; resumes runs when
                                                 questions are answered or /approve is commented

Run options:
  -t, --task <text>        Task description (or --task-file <path>); optional for ticket flows
  -r, --repo <dir>         Target repository (default: current directory)
  -v, --var key=value      Override a flow variable (repeatable)
      --runs-dir <dir>     Where run logs/worktrees go (default: ${join(FACTORY_HOME, "runs")})

Flows are looked up in <repo>/.claude-factory/flows, ${join(FACTORY_HOME, "flows")}, then built-ins.
`;

function parseVars(pairs: string[] = []): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq < 1) throw new Error(`--var expects key=value, got "${p}"`);
    vars[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return vars;
}

const STATUS_LINE: Record<RunSummary["status"], string> = {
  succeeded: "✔ succeeded",
  failed: "✘ failed",
  stopped: "■ stopped",
  waiting: "⏸ waiting for approval",
  cancelled: "✘ cancelled",
  running: "… running",
};

function report(s: RunSummary): number {
  process.stdout.write(
    `\n${STATUS_LINE[s.status]}${s.reason ? `: ${s.reason}` : ""}` +
      ` · $${s.totalCostUsd.toFixed(4)}` +
      `\n  run:       ${s.runId}` +
      `\n  run log:   ${join(s.runDir, "run.json")}` +
      (s.workdir ? `\n  workspace: ${s.workdir}` : "") +
      (s.branch ? `\n  branch:    ${s.branch}` : "") +
      (s.status === "waiting" ? `\n  next:      factory approve ${s.runId}   (or: factory reject ${s.runId})` : "") +
      (s.status === "stopped" || s.status === "failed" ? `\n  next:      factory resume ${s.runId}` : "") +
      "\n",
  );
  return s.status === "succeeded" ? 0 : s.status === "waiting" || s.status === "stopped" ? 3 : 2;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string", short: "t" },
      "task-file": { type: "string" },
      repo: { type: "string", short: "r" },
      var: { type: "string", short: "v", multiple: true },
      "runs-dir": { type: "string" },
      global: { type: "boolean" },
      port: { type: "string", short: "p" },
      every: { type: "string" },
      source: { type: "string" },
      flows: { type: "string" },
      "older-than": { type: "string" },
      purge: { type: "boolean" },
      "include-paused": { type: "boolean" },
      "dry-run": { type: "boolean" },
      models: { type: "string" },
      label: { type: "string" },
      max: { type: "string" },
      once: { type: "boolean" },
      from: { type: "string" },
      note: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  const repo = resolve(values.repo ?? process.cwd());

  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return cmd || values.help ? 0 : 1;
  }

  switch (cmd) {
    case "run": {
      if (!arg) throw new Error("usage: factory run <flow> --task \"...\"");
      const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : undefined);
      // The task is optional: e.g. GitHub flows take their work from the ticket.
      if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);
      const { flow } = loadFlow(arg, repo);
      const summary = await runFlow(flow, {
        task: task?.trim() ?? "",
        repo,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        vars: parseVars(values.var),
        log: (m) => process.stdout.write(m + "\n"),
      });
      return report(summary);
    }

    case "resume":
    case "approve":
    case "reject": {
      if (!arg) throw new Error(`usage: factory ${cmd} <run-id>`);
      const summary = await resumeRun({
        runId: arg,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        from: cmd === "resume" ? values.from : undefined,
        decision: cmd === "resume" ? undefined : { approved: cmd === "approve", by: process.env.USER ?? "cli", note: values.note },
        log: (m) => process.stdout.write(m + "\n"),
      });
      return report(summary);
    }

    case "flows": {
      for (const f of listFlows(repo)) {
        const desc = f.error ? `INVALID — ${f.error.split("\n")[1]?.trim() ?? f.error}` : (f.description ?? "");
        process.stdout.write(`${f.name.padEnd(18)} ${desc}\n${"".padEnd(18)} ${f.path}\n`);
      }
      return 0;
    }

    case "blocks": {
      for (const b of listBlocks(repo)) {
        const label = b.block ? `${b.block.category} · ${b.block.name}` : `INVALID — ${b.error?.split("\n")[1]?.trim()}`;
        process.stdout.write(`${b.id.padEnd(16)} ${label}  [${b.scope}]\n`);
      }
      return 0;
    }

    case "validate": {
      if (!arg) throw new Error("usage: factory validate <flow>");
      const { flow, path } = loadFlow(arg, repo);
      process.stdout.write(`✔ ${path}\n  ${flow.name}: ${flow.steps.map((s) => s.id).join(" → ")}\n`);
      return 0;
    }

    case "new": {
      if (!arg || !/^[\w-]+$/.test(arg)) throw new Error("usage: factory new <name> (letters, digits, _ or -)");
      const dir = values.global ? join(FACTORY_HOME, "flows") : join(repo, ".claude-factory", "flows");
      const dest = join(dir, `${arg}.yaml`);
      if (existsSync(dest)) throw new Error(`${dest} already exists`);
      const template = readFileSync(resolveFlowPath(values.from ?? "feature", repo), "utf8");
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, template.replace(/^name:.*$/m, `name: ${arg}`));
      process.stdout.write(`created ${dest}\nedit it, then: factory run ${arg} --task "..."\n`);
      return 0;
    }

    case "watch": {
      const vars = parseVars(values.var);
      const { github_repo, ...rest } = vars;
      if (!github_repo || github_repo === "owner/repo") throw new Error("set the GitHub repo: --var github_repo=owner/repo");
      const cfg = WatcherSchema.parse({
        id: "cli",
        source: values.source ?? "issues",
        flow: arg ?? (values.source === "pr-feedback" ? "pr-feedback" : "github-issue"),
        github_repo,
        label: values.label ?? "claude-factory",
        every: values.every ?? "5m",
        max_per_tick: Number(values.max ?? 1),
        vars: rest,
      });
      const config = loadConfig();
      const runsDir = resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs"));
      const log = (m: string) => process.stdout.write(m + "\n");
      const scheduler = new Scheduler({ runsDir, config: () => config });
      const watcher = new Watcher(cfg, { scheduler, runsDir, repo, dailyBudget: () => config.daily_budget_usd, log });
      if (values.once) {
        await watcher.tick();
        if (watcher.status.lastError) throw new Error(watcher.status.lastError);
        await scheduler.idle();
        return 0;
      }
      let stopping = false;
      process.on("SIGINT", () => {
        if (stopping) {
          for (const a of scheduler.queue().active) scheduler.cancel(a.runId);
          log("cancelling running runs (they resume on the next start)…");
          setTimeout(() => process.exit(130), 3000).unref();
          return;
        }
        stopping = true;
        watcher.stop();
        const n = scheduler.queue().active.length;
        log(n ? `\nstopped watching; waiting for ${n} running run(s) — Ctrl+C again to cancel them` : "\nstopped");
        void scheduler.idle().then(() => process.exit(0));
      });
      log(`watching ${github_repo} (${cfg.source}) every ${cfg.every} with flow ${cfg.flow} — Ctrl+C to stop`);
      watcher.start();
      return new Promise<number>(() => {});
    }

    case "serve":
    case "ui": {
      const port = Number(values.port ?? 4777);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
      const { url, ctx } = await startServer({
        repo,
        port,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        log: (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`),
      });
      const n = ctx.config().watchers.filter((w) => w.enabled).length;
      process.stdout.write(`claude-factory → ${url}\n  repo: ${repo}\n  watchers: ${n}\n  Ctrl+C to stop\n`);
      if (cmd === "ui" && !values["no-open"] && process.platform === "darwin") execFile("open", [url]);
      return new Promise<number>(() => {}); // run until killed
    }

    case "eval": {
      if (!arg) throw new Error("usage: factory eval <suite.yaml> [--flows a,b] [--models sonnet,opus]");
      const split = (v?: string) => v?.split(",").map((x) => x.trim()).filter(Boolean);
      const { report, file } = await runEval({
        suitePath: arg,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        config: loadConfig(),
        flowsFilter: split(values.flows),
        modelsOverride: split(values.models),
        log: (m) => process.stdout.write(m + "\n"),
      });
      const rows = report.summary.map((s) =>
        `${s.variant.padEnd(28)} ${String(Math.round(s.passRate * 100) + "%").padStart(5)}  $${s.avgCostUsd.toFixed(3).padStart(7)}  ${s.avgMinutes.toFixed(1).padStart(5)}m  ${s.avgFixLoops.toFixed(1).padStart(5)}`);
      process.stdout.write(`\n${"variant".padEnd(28)}  pass   avg cost   time  loops\n${rows.join("\n")}\n\nreport: ${file}\n`);
      return 0;
    }

    case "clean": {
      const days = Number(values["older-than"] ?? 7);
      if (!(days >= 0)) throw new Error("--older-than must be a number of days");
      const r = cleanRuns({
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        olderThanDays: days,
        purge: values.purge,
        includePaused: values["include-paused"],
        dryRun: values["dry-run"],
      });
      const verb = values["dry-run"] ? "would remove" : "removed";
      process.stdout.write(
        `${verb} ${r.workspaces.length} workspace(s)${r.runs.length ? ` and ${r.runs.length} run(s)` : ""} · ${r.freedMb} MB\n` +
          (r.kept.length ? `kept ${r.kept.length} paused/running run(s) — use --include-paused to clean them too\n` : ""),
      );
      return 0;
    }

    case "service": {
      const sub = arg ?? "status";
      if (sub === "install") {
        const port = Number(values.port ?? 4777);
        process.stdout.write(installService({ cliPath: fileURLToPath(import.meta.url), port, repo }) + "\n");
      } else if (sub === "uninstall") process.stdout.write(uninstallService() + "\n");
      else if (sub === "status") process.stdout.write(serviceStatus() + "\n");
      else throw new Error("usage: factory service install|uninstall|status");
      return 0;
    }

    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  },
);
