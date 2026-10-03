import type { RunSummary } from "./engine/state.js";
import { nextStep, type NextBase, type NextData, type NextStep } from "./next-step.js";

/** Where the record of an issue comes from, in the order they are tried. */
export type IssueSource = "live" | "queued" | "hold" | "run" | "done" | "start";

export interface IssueRecordInput {
  base: NextBase;
  data: NextData;
  run?: RunSummary;
  /** The issue's run is running or queued. */
  live: boolean;
  /** A queued job of the issue (used when it has no run file yet). */
  queuedJob?: { waitingFor?: string; behindPriority?: boolean };
  /** The watcher's record for the issue (why it is not started, a question, a closed issue …). */
  hold?: NextStep;
  /** The issue carries the done label. */
  done?: boolean;
  /** The server waits to restart: an issue that was not started yet says so. */
  restart?: boolean;
  restartWhy?: NextData["restartWhy"];
  /** The record of a run. */
  nextOf: (run: RunSummary) => NextStep;
}

/**
 * The record of an issue a watcher tracks, from the first source that knows something: its live run,
 * a queued job, the watcher's hold, its newest run, the done label, else "not started yet".
 */
export function issueRecord(i: IssueRecordInput): { source: IssueSource; next: NextStep } {
  if (i.run && i.live) return { source: "live", next: i.nextOf(i.run) };
  if (i.queuedJob && !i.run) {
    return { source: "queued", next: nextStep(i.queuedJob.waitingFor ? "one_at_a_time" : i.queuedJob.behindPriority ? "bug_first" : "queued", i.base, { ...i.data, blockingRun: i.queuedJob.waitingFor }) };
  }
  if (i.hold) return { source: "hold", next: i.hold };
  if (i.run) return { source: "run", next: i.nextOf(i.run) };
  if (i.done) return { source: "done", next: nextStep("done", i.base, i.data) };
  return { source: "start", next: nextStep(i.restart ? "restart" : "starting", i.base, { ...i.data, restartWhy: i.restartWhy }) };
}

/** One record per issue when several watchers track it: a running one first, a finished one last. */
export const issueRank = (live: boolean, done: boolean): number => (live ? 0 : done ? 2 : 1);
