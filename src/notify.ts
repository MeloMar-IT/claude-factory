import { execFile, spawn } from "node:child_process";
import { withScfAliases } from "./engine/template.js";
import type { Config } from "./config.js";
import type { RunSummary } from "./engine/state.js";
import { releaseAtFor, runNextStep, trackingWatcher, type NextStep } from "./next-step.js";
import { labelNames } from "./queue/watcher.js";

function message(config: Config, s: RunSummary): string {
  const what = s.vars.issue ? `${s.vars.github_repo}#${s.vars.issue}` : s.task.split("\n")[0] || s.flow;
  const w = trackingWatcher(config.watchers, s);
  const next = runNextStep(s, { watched: !!w, failedLabel: w && labelNames(w).failed, releaseAt: releaseAtFor(config.watchers, s) });
  return fit(what, next);
}

const MAX_MESSAGE = 300;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

/** "<what> — <why> — <what to do>." in at most 300 characters; only what and why are shortened, never the action. */
function fit(what: string, next: NextStep): string {
  const tail = next.text.slice(next.why.length).replace(/\s+/g, " "); // " — <what to do>."
  const room = MAX_MESSAGE - tail.length - 3; // 3: the " — " after what
  if (room < 0) return flat(next.text).slice(0, MAX_MESSAGE);
  const w = flat(what);
  const why = flat(next.why);
  const whyLen = Math.min(why.length, Math.max(0, room - Math.min(w.length, 20)));
  return `${cut(w, room - whyLen)} — ${cut(why, whyLen)}${tail}`.slice(0, MAX_MESSAGE);
}

/** Tell the user a run finished (or needs them). Never throws. */
export async function notifyRun(config: Config, s: RunSummary): Promise<void> {
  if (process.env.FACTORY_NO_NOTIFY === "1") return;
  const n = config.notify;
  if (s.status === "running" || !n.on.includes(s.status)) return;
  const title = `Foundry · ${s.flow} ${s.status}`;
  const msg = message(config, s);
  const jobs: Promise<unknown>[] = [];

  if (n.macos && process.platform === "darwin") {
    const q = (t: string) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    jobs.push(new Promise((r) => execFile("osascript", ["-e", `display notification ${q(msg)} with title ${q(title)}`], () => r(null))));
  }
  if (n.slack_webhook) {
    jobs.push(
      fetch(n.slack_webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `*${title}*\n${msg}\nrun \`${s.runId}\` · $${s.totalCostUsd.toFixed(3)}` }),
      }).catch(() => {}),
    );
  }
  if (n.command) {
    jobs.push(
      new Promise((r) => {
        const child = spawn("/bin/sh", ["-c", n.command!], {
          stdio: "ignore",
          env: withScfAliases({
            ...process.env,
            FACTORY_EVENT: "run.finished",
            FACTORY_RUN_ID: s.runId,
            FACTORY_FLOW: s.flow,
            FACTORY_STATUS: s.status,
            FACTORY_MESSAGE: msg,
          }),
        });
        child.on("close", r);
        child.on("error", r);
      }),
    );
  }
  await Promise.all(jobs);
}
