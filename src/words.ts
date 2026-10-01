import type { NextKind } from "./next-step.js";

/** What the glossary fills in from a record. */
export interface WordFacts {
  /** Label of the schedule watcher's release, e.g. "17:00" (a release without a pull request). */
  releaseAt?: string;
  /** Issue numbers a dependency waits for. */
  blockers?: number[];
}

interface Words {
  status: string | ((f: WordFacts) => string);
  help: string | ((f: WordFacts) => string);
}

const list = (f: WordFacts) => (f.blockers?.length ? f.blockers.map((n) => `#${n}`).join(", ") : "another story");
const scheduled = (f: WordFacts) => !!f.releaseAt;

/**
 * The words the Foundry uses. Every help text is exactly two sentences: what it means, then what
 * happens next or what to do. No ".", "!" or "?" inside a sentence (no "e.g.", no decimals).
 */
const GLOSSARY: Record<NextKind, Words> = {
  questions: { status: "waiting for you — questions", help: "The Foundry has questions about this issue before it starts. Answer them on the issue, or reply /defaults to go with the recommendations." },
  planner_questions: { status: "waiting for you — questions", help: "The planner has questions that the issue and the code do not answer. Answer them and the work goes on." },
  approve_plan: { status: "waiting for you — risky plan", help: "The plan is risky, or you asked to check it, so coding waits for your decision. Approve it to start coding, or reject it and say what to change." },
  approve_split: { status: "waiting for you — split", help: "The issue is too big for one change, so the Foundry proposes smaller issues. Approve and it creates them and closes this one, or reject it and say what to change." },
  approval: { status: "waiting for you — approval", help: "A step of the run asks for your approval before it goes on. Approve or reject it, and the run goes on with your decision." },
  stopped: { status: "waiting for you — stopped", help: "The run stopped at a step that needs a person. Look at the run, fix what it asks for and resume it." },
  release: {
    status: (f) => (scheduled(f) ? `in develop (ships with the ${f.releaseAt} release)` : "waiting for you — release pull request"),
    help: (f) => (scheduled(f)
      ? `The work is finished and waits for the ${f.releaseAt} release. Nothing to do now — the release pull request then brings it to main.`
      : "A release pull request brings finished work to main, and this one is not merged yet. Merge it and the Foundry goes on."),
  },
  dependency: {
    status: (f) => `waiting for ${list(f)}`,
    help: (f) => `It needs ${list(f)} to be done first. Nothing to do — it starts by itself after that.`,
  },
  one_at_a_time: { status: "waiting for another run", help: "Only one run at a time works here, and another run is active. Nothing to do — it starts when that run is finished." },
  area_lock: { status: "waiting for another run in the same code", help: "Another run is changing the same part of the code. Nothing to do — it goes on when that run is finished." },
  usage_limit: { status: "paused — usage limit", help: "The usage limit of the AI account is reached. Nothing to do — the Foundry tries again after the limit resets." },
  daily_budget: { status: "paused — daily budget", help: "Today's budget is used up. Nothing to do — it goes on tomorrow." },
  checking: { status: "checking for questions", help: "The Foundry reads the new issues and looks for questions only you can answer. Nothing to do — an issue without questions starts after the check." },
  starting: { status: "starting soon", help: "Nothing is in the way, it only waits for the watcher's next check. Nothing to do — it starts by itself." },
  queued: { status: "queued", help: "It waits in the queue until a run finishes. Nothing to do — it starts by itself." },
  running: { status: "working", help: "The Foundry is working on it right now. Nothing to do — you can follow it on the run page." },
  interrupted: { status: "interrupted", help: "The run was cut off, for example by a restart of the server. A watched issue resumes by itself at the next check, any other run you resume on its page." },
  cancelled: { status: "cancelled", help: "Someone cancelled the run. A watched issue resumes by itself at the next check, any other run you resume on its page if you still want it." },
  failed: { status: "failed", help: "A step failed and the run could not go on. Fix the cause if needed, then start over or resume the run at the failed step." },
  watcher_error: { status: "watcher error", help: "The watcher could not do its check, so its issues do not move. Look at the error on the Watchers page and fix the cause, it then tries again at the next check." },
  restart: { status: "restarting soon", help: "The server waits to restart and starts nothing new until then. Nothing to do — it restarts when the active runs are done." },
  superseded: { status: "replaced by a newer run", help: "A newer run took over the same work. Nothing to do with this run." },
  done: { status: "done", help: "The work is finished. Nothing to do." },
};

export const KINDS = Object.keys(GLOSSARY) as NextKind[];

const pick = (v: string | ((f: WordFacts) => string), f: WordFacts) => (typeof v === "function" ? v(f) : v);

/** The short plain status name of a kind. */
export function statusName(kind: NextKind, facts: WordFacts = {}): string {
  return pick(GLOSSARY[kind].status, facts);
}

/** Two sentences: what it means, and what happens next or what to do. */
export function statusHelp(kind: NextKind, facts: WordFacts = {}): string {
  return pick(GLOSSARY[kind].help, facts);
}

export type WatcherStateName = "active" | "error" | "disabled";

/** A watcher's own state, in the same words as a record: `name`, plain `status` and two-sentence `help`. */
export interface WatcherState { name: WatcherStateName; status: string; help: string }

const WATCHER_STATES = {
  active: { status: "active", help: "The watcher checks GitHub on its schedule and starts runs. Nothing to do — it works by itself." },
  disabled: { status: "disabled", help: "The watcher is switched off, so it checks nothing and starts nothing. Enable it on the Watchers page when you want it to work again." },
} as const;

/** The words for a watcher's state (active, error or disabled). An error uses the "watcher error" words. */
export function watcherState(name: WatcherStateName): WatcherState {
  if (name === "error") return { name, status: statusName("watcher_error"), help: statusHelp("watcher_error") };
  return { name, ...WATCHER_STATES[name] };
}

/** Descriptions of the labels on GitHub (at most 100 characters each). */
export const LABEL_WORDS = {
  working: "The Foundry is working on this issue. Nothing to do — it continues by itself.",
  done: "Done — the Foundry finished this issue. Nothing to do.",
  needsInfo: "Waiting for you — questions. Answer the Foundry on the issue, or reply /defaults.",
  waiting: "Waiting for you — approval. Reply /approve or /reject to the Foundry on the issue.",
  failed: "Failed — the Foundry could not finish this. Remove the label to start over, or resume the run.",
  trigger: "Add this label to let the Foundry work on the issue. Remove it and nothing new starts.",
  review: "Add this label to check the plan yourself. The Foundry then waits for your /approve.",
  triggerReview: "Add this label to let the Foundry work on the issue. It waits for your /approve of the plan.",
} as const;
