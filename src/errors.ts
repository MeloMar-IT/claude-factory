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
}

type Parts = { what: string; why: string; todo: string; startOver?: boolean };
type Ctx = { step?: string };
interface Row {
  re: RegExp;
  only?: ErrorAbout;
  startOver?: true;
  make: (m: RegExpExecArray, s: Ctx) => Parts;
}

const RUN_PAGE_LOG = "Look at the steps and the log on the run page";
const WATCHER_TODO = "Look at Error details on the Watchers page";

const stepWhat = (s: Ctx) => (s.step ? `The step ${s.step} failed` : "The run failed");
const OUTPUT = "Look at the output of the step and fix the cause";
const LOG = "Look at the log of the step on the run page";

const ROWS: Row[] = [
  { re: /^exit code \S+/, make: (_m, s) => ({ what: stepWhat(s), why: "its command ended with an error", todo: OUTPUT }) },
  { re: /^timed out\b/, make: (_m, s) => ({ what: stepWhat(s), why: "it ran longer than its time limit", todo: "Look at the output of the step to see what took so long" }) },
  { re: /^claude exited with code/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent stopped without a result", todo: LOG }) },
  { re: /^codex CLI not found/, make: (_m, s) => ({ what: stepWhat(s), why: "Codex is not installed on this computer", todo: "Install Codex on the computer that runs the Foundry" }) },
  { re: /codex login/i, only: "run", make: (_m, s) => ({ what: stepWhat(s), why: "Codex is not logged in", todo: "Log in to Codex on the computer that runs the Foundry" }) },
  { re: /^codex exited with code/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent stopped with an error", todo: LOG }) },
  { re: /^claude result: error_max_turns\b/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent used all its turns", todo: LOG }) },
  { re: /^claude result: error_max_budget_usd\b/, startOver: true, make: (_m, s) => ({ what: stepWhat(s), why: "the agent used up the budget of the step", todo: "Give the step a larger budget in the flow" }) },
  { re: /^claude result: error_during_execution\b/, make: (_m, s) => ({ what: stepWhat(s), why: "the agent hit an error while it worked", todo: LOG }) },
  { re: /^claude result: /, make: (_m, s) => ({ what: stepWhat(s), why: "the agent ended with an error", todo: LOG }) },
  { re: /^exceeded max_visits \((\d+)\)/, make: (_m, s) => ({ what: stepWhat(s), why: "it used all its attempts", todo: "Look at why the step keeps failing in its log on the run page" }) },
  { re: /^run budget of /, startOver: true, make: () => ({ what: "The run reached its budget", why: "it used the amount the flow allows for one run", todo: "Allow a larger budget for one run in the flow" }) },
  { re: /^rejected\b/, make: (_m, s) => ({ what: stepWhat(s), why: "a person rejected it", todo: "Read the note of the person and change the work as asked" }) },
  { re: /^invalid interval\b/, only: "watcher", make: () => ({ what: "The watcher cannot start", why: "its check interval is not a valid time", todo: "Change the check interval of the watcher to a time like 5m" }) },
  { re: /^interval must be\b/, only: "watcher", make: () => ({ what: "The watcher cannot start", why: "its check interval is outside what is allowed", todo: "Change the check interval of the watcher to a time like 5m" }) },
  { re: /the check took longer than/, only: "watcher", make: () => ({ what: "The watcher did not finish its check", why: "it took too long and was given up", todo: "Press Check now on the Watchers page to try again" }) },
  { re: /^cannot access /, only: "watcher", make: () => ({ what: "The watcher cannot reach the repository", why: "GitHub did not let it in or could not find it", todo: "Check the repository name and that gh is logged in" }) },
  { re: /Command failed: gh\b/, only: "watcher", make: () => ({ what: "The watcher cannot reach the repository", why: "a call to GitHub failed", todo: "Check that gh is logged in and the repository is there" }) },
  { re: /^internal error\b/, make: () => ({ what: "The run failed", why: "the Foundry hit an error of its own", todo: RUN_PAGE_LOG }) },
];

/** Pure. Never throws; `undefined` and "" give the "no reason" text. */
export function explainError(raw: string | undefined, about: ErrorAbout = "run"): Explained {
  const detail = (raw ?? "").trim();
  const fin = (p: Parts): Explained => ({ ...p, detail, startOver: p.startOver ?? false });
  const general = (s: Ctx): Parts =>
    about === "watcher"
      ? { what: "The watcher has an error", why: "the error is not one the Foundry can explain", todo: WATCHER_TODO }
      : { what: stepWhat(s), why: "the error is not one the Foundry can explain", todo: "Look at Details on the run page" };
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
    if (m) return fin({ ...row.make(m, ctx), startOver: row.startOver ?? false });
  }
  return fin(general(ctx));
}
