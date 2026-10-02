import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import { DEFAULT_FLOWS } from "../queue/watcher.js";
import { listFlows, parseFlow } from "./load.js";

/** Who uses a flow: watchers (enabled or not, also as their questions check) and flows that run it as a sub-flow. */
export function flowUsers(name: string, config: Config, repo: string): string[] {
  const users: string[] = [];
  for (const w of config.watchers) {
    const runs = w.flow === "default" ? DEFAULT_FLOWS[w.source] : w.flow;
    const state = w.enabled ? "enabled" : "disabled";
    if (runs === name) users.push(`watcher ${w.id} (${state})`);
    if (w.precheck_flow === name) users.push(`watcher ${w.id} (${state}, questions check)`);
  }
  for (const f of listFlows(repo)) {
    if (f.name === name || f.error) continue;
    try {
      const flow = parseFlow(readFileSync(f.path, "utf8"), f.path);
      if (flow.steps.some((s) => s.type === "flow" && s.flow === name)) users.push(`flow ${f.name} (runs it as a step)`);
    } catch {
      // a flow that doesn't parse can't run it either
    }
  }
  return users;
}
