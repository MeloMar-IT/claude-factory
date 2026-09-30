import { execFile, spawn } from "node:child_process";
import { withScfAliases } from "./engine/template.js";
import type { Config } from "./config.js";
import type { RunSummary } from "./engine/state.js";

function message(s: RunSummary): string {
  const what = s.vars.issue ? `${s.vars.github_repo}#${s.vars.issue}` : s.task.split("\n")[0] || s.flow;
  const detail = s.status === "waiting" ? `waiting for approval: ${s.waiting?.message ?? ""}` : (s.reason ?? "");
  return `${what}${detail ? ` — ${detail}` : ""}`.replace(/\s+/g, " ").slice(0, 300);
}

/** Tell the user a run finished (or needs them). Never throws. */
export async function notifyRun(config: Config, s: RunSummary): Promise<void> {
  if (process.env.FACTORY_NO_NOTIFY === "1") return;
  const n = config.notify;
  if (s.status === "running" || !n.on.includes(s.status)) return;
  const title = `claude-factory · ${s.flow} ${s.status}`;
  const msg = message(s);
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
