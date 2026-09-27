#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runFlow } from "./engine/runner.js";
import { FACTORY_HOME, listFlows, loadFlow, resolveFlowPath } from "./flow/load.js";

const USAGE = `claude-factory — run custom flows of headless Claude Code + shell steps

Usage:
  factory run <flow> --task "<text>" [options]   Run a flow against a repo
  factory flows [--repo <dir>]                   List available flows
  factory validate <flow|file.yaml>              Check a flow definition
  factory new <name> [--from <flow>] [--global]  Create your own flow (copies a template)

Run options:
  -t, --task <text>        Task description (or --task-file <path>)
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
      from: { type: "string" },
      global: { type: "boolean" },
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
      if (!task?.trim()) throw new Error("a task is required: --task \"...\" or --task-file <path>");
      if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);
      const { flow } = loadFlow(arg, repo);
      const summary = await runFlow(flow, {
        task: task.trim(),
        repo,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        vars: parseVars(values.var),
        log: (m) => process.stdout.write(m + "\n"),
      });
      const ok = summary.status === "succeeded";
      process.stdout.write(
        `\n${ok ? "✔ succeeded" : `✘ failed: ${summary.reason}`}` +
          ` · $${summary.totalCostUsd.toFixed(4)}` +
          `\n  run log:   ${join(summary.runDir, "run.json")}` +
          (summary.workdir ? `\n  workspace: ${summary.workdir}` : "") +
          (summary.branch ? `\n  branch:    ${summary.branch}` : "") +
          "\n",
      );
      return ok ? 0 : 2;
    }

    case "flows": {
      for (const f of listFlows(repo)) {
        const desc = f.error ? `INVALID — ${f.error.split("\n")[1]?.trim() ?? f.error}` : (f.description ?? "");
        process.stdout.write(`${f.name.padEnd(18)} ${desc}\n${"".padEnd(18)} ${f.path}\n`);
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
