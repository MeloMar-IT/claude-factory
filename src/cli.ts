#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { parseArgs } from "node:util";
import { mirrorEnvPrefixes } from "./engine/template.js";
import { resumeRun, runFlow, type RunSummary } from "./engine/runner.js";
import { listBlocks } from "./flow/blocks.js";
import { FACTORY_HOME, listFlows, loadFlow, resolveFlowPath } from "./flow/load.js";
import { startServer } from "./server/server.js";
import { loadConfig, WatcherSchema } from "./config.js";
import { cleanRuns } from "./clean.js";
import { runEval } from "./evals.js";
import { Scheduler } from "./queue/scheduler.js";
import { DEFAULT_FLOWS, Watcher } from "./queue/watcher.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildStamp, restartOnNewBuild, supervise } from "./supervise.js";
import { confirmStart, startGuard } from "./self-update-state.js";
import { SelfUpdater } from "./self-update.js";
import { dropEmptyHomeVars, prepareDataHome, watchDataHome } from "./home.js";

const usage = () => `Spaghetti Code Foundry (scf) — run custom flows of headless Claude Code + shell steps
("factory" still works as an alias for "scf".)

Usage:
  scf run <flow> --task "<text>" [options]       Run a flow against a repo
  scf resume <run-id> [--from <step>]            Continue a stopped/failed/interrupted run
  scf approve <run-id> [--note "..."]            Approve a run waiting at an approval step
  scf reject <run-id> [--note "..."]             Reject it (the flow's on_failure path runs)
  scf eval <suite.yaml> [--flows a,b] [--models sonnet,codex,ollama:qwen3-coder]
                                                 Benchmark flows/agents/models on sample tasks
  scf clean [--older-than 7] [--purge] [--include-paused] [--dry-run]
                                                 Remove old run workspaces/worktrees (branches kept)
  scf flows [--repo <dir>]                       List available flows
  scf blocks [--repo <dir>]                      List reusable step blocks (the library)
  scf validate <flow|file.yaml>                  Check a flow definition
  scf flow-guide                                 Print the flow-writing guide for AI assistants
                                                 (give it to any LLM, then ask it for a flow)
  scf new <name> [--from <flow>] [--global]      Create your own flow (copies a template)
  scf ui [--port 4777] [--no-open]               Web UI + queue + watchers from config.yaml
  scf serve [--port 4777]                        Same without opening a browser (for services)
  scf user create [--admin] [--name n] [--email e]
                                                 Create an account (the first one: --admin)
  scf user list                                  List accounts
  scf user password <e-mail>                     Set a new password
  scf user role <e-mail> admin|user              Change the role of an account
  scf user block <e-mail> [--stop-work] | unblock <e-mail>   Block or unblock an account
  scf user delete <e-mail>                       Delete an account and wipe its stored credentials
  scf credential rotate-key | check              Re-encrypt stored credentials; check the macOS Keychain
  scf service install|uninstall|status          Keep \`scf serve\` running as a macOS login agent
  scf watch [flow] --var github_repo=o/r         Every 5 min, run the flow (default issue-gitflow) on
        [--every 5m] [--label claude-factory]    each open issue with the label; results are marked
        [--max 1] [--once] [--source …]          with factory:* status labels; resumes runs when
                                                 questions are answered or /approve is commented.
                                                 --source pr-feedback: review comments on factory PRs
                                                 --source ci-failures: CI red on the default branch (name a flow)
                                                 --source schedule --every 7d --task "…": chore → PR

Run options:
  -t, --task <text>        Task description (or --task-file <path>); optional for ticket flows
  -r, --repo <dir>         Target repository (default: current directory)
  -v, --var key=value      Override a flow variable (repeatable)
      --runs-dir <dir>     Where run logs/worktrees go (default: ${join(FACTORY_HOME, "runs")})

Models: a step's model can be a spec like sonnet, codex, codex:gpt-5, ollama:qwen3-coder or
codex:ollama:gpt-oss:20b (Claude Code or Codex CLI, on Anthropic, OpenAI or a local model).
Routing rules and fallbacks live in config.yaml (router:) — or the Models page of the UI.

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

/** The starting point for `scf new` (see docs/FLOW_AUTHORING.md for everything a flow can do). */
const NEW_FLOW_TEMPLATE = `# A flow: steps run top to bottom; jumps make loops. See docs/FLOW_AUTHORING.md.
name: my-flow
description: Implement the task, test it, fix failures
workspace: worktree
one_per_repo: true
defaults:
  model: claude-sonnet-5-5
  permission_mode: acceptEdits
vars:
  test_cmd: npm test
steps:
  - id: implement
    type: claude
    prompt: |
      {{task}}
      Add tests. Do not commit.
  - id: test
    type: shell
    run: "{{vars.test_cmd}}"
    on_success: end
    on_failure: fix
  - id: fix
    type: claude
    jump_only: true
    resume: implement
    max_visits: 3
    prompt: |
      The tests fail. Fix the code (never weaken or delete tests).
      {{steps.test.output}}
    on_success: test
`;

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
      (s.status === "waiting" ? `\n  next:      scf approve ${s.runId}   (or: scf reject ${s.runId})` : "") +
      (s.status === "stopped" || s.status === "failed" ? `\n  next:      scf resume ${s.runId}` : "") +
      "\n",
  );
  return s.status === "succeeded" ? 0 : s.status === "waiting" || s.status === "stopped" ? 3 : 2;
}

async function main(argv: string[]): Promise<number> {
  dropEmptyHomeVars();
  mirrorEnvPrefixes();
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
      admin: { type: "boolean" },
      "stop-work": { type: "boolean" },
      name: { type: "string" },
      email: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  const repo = resolve(values.repo ?? process.cwd());

  if (values.help || !cmd) {
    process.stdout.write(usage());
    return cmd || values.help ? 0 : 1;
  }

  const moved = prepareDataHome({ checkConfig: (p) => void loadConfig(p) });
  if (moved.reason === "moved-missing" || moved.reason === "incomplete") throw new Error(moved.message);

  switch (cmd) {
    case "run": {
      if (!arg) throw new Error("usage: scf run <flow> --task \"...\"");
      const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : undefined);
      // The task is optional: e.g. GitHub flows take their work from the ticket.
      if (!existsSync(repo)) throw new Error(`repo not found: ${repo}`);
      const { flow } = loadFlow(arg, repo);
      const summary = await runFlow(flow, {
        task: task?.trim() ?? "",
        repo,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        vars: parseVars(values.var),
        source: "cli",
        log: (m) => process.stdout.write(m + "\n"),
      });
      return report(summary);
    }

    case "resume":
    case "approve":
    case "reject": {
      if (!arg) throw new Error(`usage: scf ${cmd} <run-id>`);
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

    case "flow-guide": {
      const { flowGuide } = await import("./server/generate.js");
      process.stdout.write(flowGuide());
      return 0;
    }

    case "validate": {
      if (!arg) throw new Error("usage: scf validate <flow>");
      const { flow, path } = loadFlow(arg, repo);
      process.stdout.write(`✔ ${path}\n  ${flow.name}: ${flow.steps.map((s) => s.id).join(" → ")}\n`);
      return 0;
    }

    case "new": {
      if (!arg || !/^[\w-]+$/.test(arg)) throw new Error("usage: scf new <name> (letters, digits, _ or -)");
      const dir = values.global ? join(FACTORY_HOME, "flows") : join(repo, ".claude-factory", "flows");
      const dest = join(dir, `${arg}.yaml`);
      if (existsSync(dest)) throw new Error(`${dest} already exists`);
      const template = values.from ? readFileSync(resolveFlowPath(values.from, repo), "utf8") : NEW_FLOW_TEMPLATE;
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, template.replace(/^name:.*$/m, `name: ${arg}`));
      process.stdout.write(`created ${dest}\nedit it, then: scf run ${arg} --task "..."\n`);
      return 0;
    }

    case "watch": {
      if (values.source === "monitor") throw new Error("the monitor only runs inside the server: add a watcher with source monitor on the Watchers page");
      const vars = parseVars(values.var);
      const { github_repo, ...rest } = vars;
      if (!github_repo || github_repo === "owner/repo") throw new Error("set the GitHub repo: --var github_repo=owner/repo");
      const cfg = WatcherSchema.parse({
        id: "cli",
        source: values.source ?? "issues",
        flow: arg ?? DEFAULT_FLOWS[(values.source ?? "issues") as keyof typeof DEFAULT_FLOWS] ?? (() => { throw new Error(`--source ${values.source}: name the flow to run (there is no default for it)`); })(),
        github_repo,
        label: values.label ?? "claude-factory",
        every: values.every ?? "5m",
        max_per_tick: Number(values.max ?? 1),
        vars: rest,
        task: values.task,
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
      // Run the server as a child that is restarted when a new build is installed.
      if (process.env.FACTORY_SUPERVISED !== "1" && process.env.FACTORY_NO_SUPERVISE !== "1") {
        // supervise() sets FACTORY_SUPERVISED/FACTORY_NO_OPEN for the child; drop the SCF_ copies so its mirror can't undo them.
        delete process.env.SCF_SUPERVISED;
        delete process.env.SCF_NO_OPEN;
        delete process.env.SCF_START_GUARD;
        const say = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
        return supervise(fileURLToPath(import.meta.url), process.argv.slice(2), say, startGuard(say));
      }
      const stamp = buildStamp(dirname(fileURLToPath(import.meta.url)));
      const { url, ctx } = await startServer({
        repo,
        port,
        runsDir: resolve(values["runs-dir"] ?? join(FACTORY_HOME, "runs")),
        log: (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`),
      });
      const n = ctx.config().watchers.filter((w) => w.enabled).length;
      process.stdout.write(`Spaghetti Code Foundry → ${url}\n  repo: ${repo}\n  data: ${FACTORY_HOME}\n  watchers: ${n}\n  Ctrl+C to stop\n`);
      const { adminHint } = await import("./auth/cli.js");
      const hint = adminHint();
      if (hint) process.stdout.write(`  ${hint}\n`);
      if (cmd === "ui" && !values["no-open"] && !process.env.FACTORY_NO_OPEN && process.platform === "darwin") execFile("open", [url]);
      // While the server waits to restart nothing queued starts, so only the active runs are waited for (queued jobs are saved).
      const queueIdle = () => { const q = ctx.scheduler.queue(); return q.active.length === 0 && (ctx.scheduler.draining || q.pending.length === 0); };
      const log = (m: string) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);
      const drain = () => {
        ctx.restart = { why: "new_version", since: new Date().toISOString() };
        ctx.scheduler.drain();
        ctx.watchers.stopAll(); // watchers start again with the new version
      };
      const updater = new SelfUpdater({ config: () => ctx.config().self_update, idle: queueIdle, drain, beforeExit: () => beforeExit(), log: ctx.opts.log ?? log });
      const beforeExit = () => {
        updater.stop();
        ctx.watchers.stopAll();
      };
      // a step of the updater runs in its own process group: it must not outlive the server
      for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) process.on(sig, () => { updater.stop(); process.exit(code); });
      // other restarts wait while the updater builds
      const idle = () => queueIdle() && !updater.busy();
      restartOnNewBuild({
        distDir: dirname(fileURLToPath(import.meta.url)),
        idle,
        drain,
        beforeExit,
        log,
      });
      watchDataHome({ idle, beforeExit, log, busy: () => {
        ctx.restart ??= { why: "data_folder", since: new Date().toISOString() };
        ctx.scheduler.drain();
        ctx.watchers.stopAll(); // drain, as for a new version: start nothing new while the restart waits
      } });
      ctx.selfUpdate = updater;
      void confirmStart(url, { stamp, log });
      updater.start();
      return new Promise<number>(() => {}); // run until killed
    }

    case "eval": {
      if (!arg) throw new Error("usage: scf eval <suite.yaml> [--flows a,b] [--models sonnet,opus]");
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
        `${s.variant.padEnd(34)} ${String(Math.round(s.passRate * 100) + "%").padStart(5)}  $${s.avgCostUsd.toFixed(3).padStart(7)}  ${String(Math.round((s.avgTokens ?? 0) / 1000) + "k").padStart(6)}  ${s.avgMinutes.toFixed(1).padStart(5)}m  ${s.avgFixLoops.toFixed(1).padStart(5)}`);
      process.stdout.write(`\n${"variant".padEnd(34)}  pass   avg cost  tokens   time  loops\n${rows.join("\n")}\n\nreport: ${file}\n`);
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
      else throw new Error("usage: scf service install|uninstall|status");
      return 0;
    }

    case "user": {
      const { userCommand, terminalIo } = await import("./auth/cli.js");
      const { help: _h, ...given } = values;
      return userCommand({ positionals: positionals.slice(1), values: given }, terminalIo());
    }

    case "credential": {
      const { credentialCommand } = await import("./credentials/cli.js");
      return credentialCommand(positionals.slice(1), (line) => void process.stdout.write(line + "\n"));
    }

    default:
      throw new Error(`unknown command "${cmd}"\n\n${usage()}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  async (err: Error) => {
    // the stored secrets are hidden from displayed errors; if that cannot load, show nothing from the message
    let text = "(message hidden: the stored credentials cannot be read)";
    try {
      text = (await import("./credentials/redact.js")).redactText(err.message);
    } catch {
      // keep the safe text
    }
    process.stderr.write(`error: ${text}\n`);
    process.exit(1);
  },
);
