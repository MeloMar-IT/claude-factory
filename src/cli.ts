#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { resumeRun, runFlow, type RunSummary } from "./engine/runner.js";
import { listBlocks } from "./flow/blocks.js";
import { FACTORY_HOME, listFlows, loadFlow, resolveFlowPath } from "./flow/load.js";
import { startServer } from "./server/server.js";
import { parseInterval, watch } from "./watch.js";

const USAGE = `claude-factory — run custom flows of headless Claude Code + shell steps

Usage:
  factory run <flow> --task "<text>" [options]   Run a flow against a repo
  factory resume <run-id> [--from <step>]        Continue a stopped/failed/interrupted run
  factory approve <run-id> [--note "..."]        Approve a run waiting at an approval step
  factory reject <run-id> [--note "..."]         Reject it (the flow's on_failure path runs)
  factory flows [--repo <dir>]                   List available flows
  factory blocks [--repo <dir>]                  List reusable step blocks (the library)
  factory validate <flow|file.yaml>              Check a flow definition
  factory new <name> [--from <flow>] [--global]  Create your own flow (copies a template)
  factory ui [--port 4777] [--no-open]           Web UI: build flows, start and watch runs
  factory watch [flow] --var github_repo=o/r     Every 5 min, run the flow (default github-issue) on
        [--every 5m] [--label claude-factory]    each open issue with the label; results are marked
        [--max 1] [--once]                       with factory:done / needs-info / failed labels

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
      const { flow } = loadFlow(arg ?? "github-issue", repo);
      const max = Number(values.max ?? 1);
      if (!Number.isInteger(max) || max < 1) throw new Error("--max must be a positive integer");
      const controller = new AbortController();
      let stopping = false;
      process.on("SIGINT", () => {
        if (stopping) process.exit(130);
        stopping = true;
        process.stdout.write("\nstopping… (cancelling the current run; press Ctrl+C again to force)\n");
        controller.abort();
      });
      await watch({
        flow,
        repo,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        vars: parseVars(values.var),
        label: values.label ?? "claude-factory",
        intervalMs: parseInterval(values.every ?? "5m"),
        maxPerTick: max,
        once: values.once,
        signal: controller.signal,
        log: (m) => process.stdout.write(m + "\n"),
      });
      return 0;
    }

    case "ui": {
      const port = Number(values.port ?? 4777);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
      const { url } = await startServer({
        repo,
        port,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
      });
      process.stdout.write(`claude-factory UI → ${url}\n  repo: ${repo}\n  Ctrl+C to stop\n`);
      if (!values["no-open"] && process.platform === "darwin") execFile("open", [url]);
      return new Promise<number>(() => {}); // run until killed
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
