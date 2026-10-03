import type { RunSummary } from "./engine/state.js";
import type { NextStep } from "./next-step.js";
import { needsUser } from "./your-turn.js";

/** The board: where every story is. Pure: the server passes in what it knows. */

export type Phase = "planning" | "coding" | "reviewing" | "merging";
export type ColumnId = "your_turn" | "waiting" | "queued" | Phase | "done" | "failed";

export const COLUMNS: readonly { id: ColumnId; title: string }[] = [
  { id: "your_turn", title: "Your turn" },
  { id: "waiting", title: "Waiting for another story" },
  { id: "queued", title: "Queued" },
  { id: "planning", title: "Planning" },
  { id: "coding", title: "Coding" },
  { id: "reviewing", title: "Reviewing" },
  { id: "merging", title: "Merging" },
  { id: "done", title: "Done" },
  { id: "failed", title: "Failed" },
];

export const DONE_WEEK_MS = 7 * 86_400_000;
export const EMPTY_BOARD = "No stories yet. A story shows here when a watcher tracks issues of a repository, or when you start a run on an issue.";

export type BoardRun = Pick<RunSummary, "runId" | "status" | "flowDef" | "state" | "history">;

export interface BoardSource {
  next: NextStep;
  /** The run the record is about (next.runId): step line and title. */
  run?: BoardRun;
  /** The story's newest run, when the record names none: the page to open. */
  runId?: string;
  since?: string;
  /** Lower wins; default 1. */
  rank?: number;
  /** Id of the issues watcher that tracks it. */
  watcher?: string;
  /** A bug story: it goes before other stories. */
  goesFirst?: boolean;
}

export interface BoardCard {
  key: string;
  issue: number;
  title: string;
  column: ColumnId;
  next: NextStep;
  /** "coding — step 16 of 41" */
  step?: string;
  runId?: string;
  /** Open dependencies, ascending. */
  after: number[];
  /** Every story that holds it back, ascending. */
  chain: number[];
  since?: string;
  /** Done only. */
  group?: string;
  watcher?: string;
  goesFirst?: true;
}

export interface BoardColumn { id: ColumnId; title: string; cards: BoardCard[] }
export interface Board { repos: { repo: string; columns: BoardColumn[] }[]; empty?: string }

// The phase of a step is a guess from its name: these steps start a phase, every other step stays in the phase of the step before.
const PHASE_STARTS: Record<string, Phase> = {};
const starts = (phase: Phase, ids: string[]) => { for (const id of ids) PHASE_STARTS[id] = phase; };
starts("planning", [
  "pull_ticket", "check_repo", "pull_repo", "clone", "feature_branch", "daily_branch", "baseline_tests", "baseline_failed",
  "wait_for_merge", "triage", "split_ticket", "plan", "plan_review", "revise_plan", "send_back", "ask_for_info", "push_plan",
  "split_gate", "approve_split", "create_split", "size_gate", "force_split", "risk_gate", "approve_plan", "claim_areas", "post_plan",
]);
starts("coding", ["implement"]);
starts("reviewing", ["review", "review_1", "review_2"]);
starts("merging", ["commit", "push", "push_feature", "push_result", "merge_develop", "open_pr", "wait_ci", "report"]);

/** The phase of every step of a flow, by position. Steps before the first known name are coding. */
export function phasesOf(stepIds: string[]): Phase[] {
  let phase: Phase = "coding";
  return stepIds.map((id) => (phase = PHASE_STARTS[id] ?? phase));
}

export interface StepProgress { phase: Phase; index: number; total: number }

/** Where a running run is in its flow. */
export function stepProgress(run: BoardRun | undefined): StepProgress | undefined {
  const steps = run?.flowDef?.steps;
  if (!run || !steps?.length || run.status === "succeeded") return undefined;
  const id = run.state?.next ?? (run.status === "running" && !run.history?.length ? steps.find((s) => !s.jump_only)?.id : undefined);
  const index = id ? steps.findIndex((s) => s.id === id) : -1;
  if (index < 0) return undefined;
  return { phase: phasesOf(steps.map((s) => s.id))[index]!, index, total: steps.length };
}

export const stepText = (p: StepProgress): string => `${p.phase} — step ${p.index + 1} of ${p.total}`;

/** The issue title as the pull_ticket step printed it ("# #37: Title"). */
export function ticketTitle(run: BoardRun | undefined): string {
  const out = run?.state?.steps?.pull_ticket?.output;
  return typeof out === "string" ? /^# #\d+: (.+)$/m.exec(out)?.[1]?.trim() ?? "" : "";
}

/** The column of a record; `phase` is where running work is. No column: the card is not shown. */
export function columnOf(next: NextStep, phase?: Phase): ColumnId | undefined {
  switch (next.kind) {
    case "failed": return "failed";
    case "dependency": case "one_at_a_time": case "area_lock": case "bug_first": return "waiting";
    case "usage_limit": case "daily_budget": case "queued": case "checking": case "starting": case "restart": return "queued";
    case "running": return phase ?? "coding";
    case "done": return "done";
    case "superseded": return undefined;
    case "release": return needsUser(next) ? "your_turn" : "merging";
    case "interrupted": case "cancelled": return next.who === "You" ? "your_turn" : "queued";
    default: return "your_turn";
  }
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** The cards of every repository, in columns. One card per story. */
export function buildBoard(sources: BoardSource[], o: { now?: Date; repos?: string[] } = {}): Board {
  const now = o.now ?? new Date();
  const picked = new Map<string, BoardSource>();
  for (const s of sources) {
    if (!s.next.issue || !s.next.repo) continue;
    const key = `${s.next.repo}#${s.next.issue}`;
    const have = picked.get(key);
    if (!have) { picked.set(key, s); continue; }
    const better = needsUser(s.next) !== needsUser(have.next) ? needsUser(s.next) : (s.rank ?? 1) < (have.rank ?? 1);
    if (better) picked.set(key, s);
  }

  const cards = new Map<string, BoardCard>();
  for (const [key, s] of picked) {
    const n = s.next;
    const progress = stepProgress(s.run);
    const column = columnOf(n, progress?.phase);
    if (!column) continue;
    let group: string | undefined;
    if (column === "done") {
      const t = time(s.since);
      if (Number.isNaN(t)) continue;
      if (sameDay(new Date(t), now)) group = "Today";
      else if (now.getTime() - t <= DONE_WEEK_MS) group = "This week";
      else continue;
    }
    const showStep = progress && n.kind !== "done" && s.run?.runId === n.runId;
    cards.set(key, {
      key, issue: n.issue!, title: n.title || ticketTitle(s.run), column, next: n,
      ...(showStep ? { step: stepText(progress) } : {}),
      runId: n.runId ?? s.runId,
      after: [...new Set((n.blockers ?? []).map((b) => b.issue))].sort((a, b) => a - b),
      chain: [],
      since: s.since,
      ...(group ? { group } : {}),
      watcher: s.watcher,
      ...(s.goesFirst && column !== "done" ? { goesFirst: true as const } : {}),
    });
  }

  for (const card of cards.values()) {
    const repo = card.next.repo;
    const seen = new Set<number>();
    const todo = [...(card.next.blockers ?? [])];
    while (todo.length) {
      const b = todo.pop()!;
      if (b.issue === card.issue || seen.has(b.issue)) continue;
      seen.add(b.issue);
      todo.push(...(b.next?.blockers ?? cards.get(`${repo}#${b.issue}`)?.next.blockers ?? []));
    }
    card.chain = [...seen].sort((a, b) => a - b);
  }

  const repos = [...new Set([...(o.repos ?? []), ...[...cards.values()].map((c) => c.next.repo)])].sort();
  return {
    repos: repos.map((repo) => {
      const mine = [...cards.values()].filter((c) => c.next.repo === repo);
      return {
        repo,
        columns: COLUMNS.map(({ id, title }) => {
          const list = mine.filter((c) => c.column === id);
          list.sort(id === "done" ? (a, b) => time(b.since) - time(a.since) : (a, b) => a.issue - b.issue);
          return { id, title, cards: list };
        }),
      };
    }),
    ...(repos.length ? {} : { empty: EMPTY_BOARD }),
  };
}
