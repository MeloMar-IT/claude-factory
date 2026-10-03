/** Plain words for a raw failure reason. Pure; imports nothing from the project. The stored text is never changed. */
export type ErrorAbout = "run" | "watcher";

export interface Explained {
  /** What happened. One clause, no end punctuation. */
  what: string;
  /** Why. One clause, lower-case start unless a name. */
  why: string;
  /** What to do first. One verb phrase with a capital. */
  todo: string;
  /** The raw text, trimmed and otherwise unchanged. */
  detail: string;
  /** True when the fix is a change to the flow: it only counts for a new run, not for a resume. */
  startOver: boolean;
  /** Only for a user: a limit the administrator set stopped the run. */
  limit?: true;
}

type Parts = { what: string; why: string; todo: string; startOver?: boolean; limit?: true };
type Ctx = { step?: string };
interface Row {
  re: RegExp;
  only?: ErrorAbout;
  startOver?: true;
  /** What a user reads instead: no money, no setup. */
  user?: (m: RegExpExecArray, s: Ctx) => Parts;
  make: (m: RegExpExecArray, s: Ctx) => Parts;
}

const ASK = "Ask the administrator";
const RUN_PAGE_LOG = "Look at the steps and the log on the run page";
const WATCHER_TODO = "Look at Error details on the Watchers page";

const stepWhat = (s: Ctx) => (s.step ? `The step ${s.step} failed` : "The run failed");
const OUTPUT = "Look at the output of the step and fix the cause";
const LOG = "Look at the log of the step on the run page";

export const NOT_EXPLAINED = "the error is not one the Foundry can explain";

const ROWS: Row[] = [
  { re: /^exit code \S+/, make: (_m, s) => ({ what: stepWhat(s), why: "its command ended with an error", todo: OUTPUT }) },
  { re: /^timed out\b/, make: (_m, s) => ({ what: stepWhat(s), why: "it ran longer than its time limit", todo: "Look at the output of the step to see what took so long" }) },
  { re: /^claude exited with code/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent stopped without a result", todo: LOG }) },
  { re: /^codex CLI not found/, user: (_m, s) => ({ what: stepWhat(s), why: "an AI tool of the Foundry is not set up", todo: ASK }), make: (_m, s) => ({ what: stepWhat(s), why: "Codex is not installed on this computer", todo: "Install Codex on the computer that runs the Foundry" }) },
  { re: /codex login/i, only: "run", user: (_m, s) => ({ what: stepWhat(s), why: "the Foundry is signed out of an AI account", todo: ASK }), make: (_m, s) => ({ what: stepWhat(s), why: "Codex is not logged in", todo: "Log in to Codex on the computer that runs the Foundry" }) },
  { re: /^codex exited with code/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent stopped with an error", todo: LOG }) },
  { re: /^claude result: error_max_turns\b/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent used all its turns", todo: LOG }) },
  { re: /^claude result: error_max_budget_usd\b/, startOver: true, user: (_m, s) => ({ what: stepWhat(s), why: "the administrator's limit was reached", todo: ASK, startOver: true, limit: true }), make: (_m, s) => ({ what: stepWhat(s), why: "the agent used up the budget of the step", todo: "Give the step a larger budget in the flow" }) },
  { re: /^claude result: error_during_execution\b/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent hit an error while it worked", todo: LOG }) },
  { re: /^claude result: /, make: (_m, s) => ({ what: stepWhat(s), why: "the agent ended with an error", todo: LOG }) },
  { re: /^exceeded max_visits \((\d+)\)/, make: (_m, s) => ({ what: stepWhat(s), why: "it used all its attempts", todo: "Look at why the step keeps failing in its log on the run page" }) },
  { re: /^run budget of /, startOver: true, user: () => ({ what: "The run stopped", why: "the administrator's limit was reached", todo: ASK, startOver: true, limit: true }), make: () => ({ what: "The run reached its budget", why: "it used the amount the flow allows for one run", todo: "Allow a larger budget for one run in the flow" }) },
  { re: /^rejected\b/, make: (_m, s) => ({ what: stepWhat(s), why: "a person rejected it", todo: "Read the note of the person and change the work as asked" }) },
  { re: /^invalid interval\b/, only: "watcher", make: () => ({ what: "The watcher cannot start", why: "its check interval is not a valid time", todo: "Change the check interval of the watcher to a time like 5m" }) },
  { re: /^interval must be\b/, only: "watcher", make: () => ({ what: "The watcher cannot start", why: "its check interval is outside what is allowed", todo: "Change the check interval of the watcher to a time like 5m" }) },
  { re: /the check took longer than/, only: "watcher", make: () => ({ what: "The watcher did not finish its check", why: "it took too long and was given up", todo: "Press Check now on the Watchers page to try again" }) },
  { re: /^cannot access |could not resolve host|error connecting|dial tcp|timeout|ENOTFOUND|ECONNREFUSED|HTTP 5\d\d/i, only: "watcher", make: () => ({ what: "The watcher can't reach GitHub", why: "GitHub did not answer or did not let it in", todo: "Check the network and `gh auth status`" }) },
  { re: /API rate limit (?:already )?exceeded|secondary rate limit/i, only: "watcher", make: () => ({ what: "GitHub's request limit is used up", why: "the Foundry asked GitHub too much in the last hour", todo: "Nothing — GitHub lifts the limit within the hour, and the watcher continues by itself" }) },
  { re: /Command failed: gh\b/, only: "watcher", make: () => ({ what: "The watcher cannot reach the repository", why: "a call to GitHub failed", todo: "Check that gh is logged in and the repository is there" }) },
  { re: /^internal error\b/, make: () => ({ what: "The run failed", why: "the Foundry hit an error of its own", todo: RUN_PAGE_LOG }) },
];

/**
 * The one line of an error that is stored for a watcher. A failed command also keeps the first
 * line gh printed ("first — second"); any other error keeps its first line. At most 300 characters.
 */
export function errorLine(raw: string | undefined): string {
  const lines = (raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  const text = /Command failed: /.test(first) && lines[1] ? `${first} — ${lines[1]}` : first;
  return text.slice(0, 300);
}

/** A user cannot read the output of a step and has no "Details" row on the run page. */
const forUserTodo = (todo: string) => (/output of the step/.test(todo) ? "Look at the log on the run page" : todo === DETAILS ? ASK : todo);
const DETAILS = "Look at Details on the run page";

/**
 * Pure. Never throws; `undefined` and "" give the "no reason" text. For a user (`forUser`) the words hold no money
 * and no setup: a limit is "the administrator's limit", and what a user cannot fix says to ask the administrator.
 */
export function explainError(raw: string | undefined, about: ErrorAbout = "run", forUser = false): Explained {
  const detail = (raw ?? "").trim();
  const fin = (p: Parts): Explained => {
    const { limit, ...rest } = p;
    return { ...rest, ...(forUser ? { todo: forUserTodo(p.todo) } : {}), detail, startOver: p.startOver ?? false, ...(forUser && limit ? { limit } : {}) };
  };
  const general = (s: Ctx): Parts =>
    about === "watcher"
      ? { what: "The watcher has an error", why: "the error is not one the Foundry can explain", todo: WATCHER_TODO }
      : { what: stepWhat(s), why: "the error is not one the Foundry can explain", todo: DETAILS };
  if (!detail) {
    return fin(about === "watcher"
      ? { what: "The watcher has an error", why: "no reason was saved", todo: WATCHER_TODO }
      : { what: "The run failed", why: "no reason was saved", todo: RUN_PAGE_LOG });
  }

  // Unwrap "step "x" failed: " and "sub-flow x failed: ", keeping the innermost step id.
  let text = detail;
  const ctx: Ctx = {};
  for (let i = 0; i < 20; i++) {
    const a = /^step "([\w./-]+)" failed(?::\s*|$)/.exec(text);
    if (a) { ctx.step = a[1]; text = text.slice(a[0].length); continue; }
    const b = /^sub-flow [\s\S]*? (?:failed|stopped)(?::\s*|$)/.exec(text);
    if (b) { text = text.slice(b[0].length); continue; }
    break;
  }
  const maxVisits = /^step "([\w./-]+)" (exceeded max_visits \(\d+\))/.exec(text);
  if (maxVisits) { ctx.step = maxVisits[1]; text = maxVisits[2]!; }

  if (!text) return fin({ what: stepWhat(ctx), why: "no reason was saved", todo: RUN_PAGE_LOG });
  for (const row of ROWS) {
    if (row.only && row.only !== about) continue;
    const m = row.re.exec(text);
    if (m) return fin({ startOver: row.startOver ?? false, ...(forUser && row.user ? row.user(m, ctx) : row.make(m, ctx)) });
  }
  return fin(general(ctx));
}

/** Text that says GitHub's request limit was hit. */
export const GITHUB_LIMIT_RE = /API rate limit (?:already )?exceeded|secondary rate limit/i;

/** One line without what changes between two occurrences: run ids, folders, tokens, times, long numbers. */
export function cleanLine(line: string): string {
  return line
    .replace(/\b\d{8}-\d{6}-[0-9a-f]{4}\b/g, "<run>")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[\w-]{8,}/g, "<token>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<token>")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|\s?[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g, "<date>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[ap]m)?/gi, "<time>")
    .replace(/(?:[A-Za-z]:)?(?:\/[\w.@+~-]+){2,}\/?/g, "<path>")
    .replace(/\b\d{5,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** A short kind for an error text: the same error gives the same kind. */
export function errorKind(raw: string | undefined): string {
  return cleanLine(errorLine(raw)).slice(0, 80);
}
