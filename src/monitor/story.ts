import { createHash } from "node:crypto";
import type { Finding } from "./findings.js";

/** The hidden marker in a bug story: a hash of the fingerprint (the fingerprint itself may name things of this install). */
export const markerHash = (fingerprint: string): string => createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
export const markerFor = (fingerprint: string): string => `<!-- claude-factory monitor=${markerHash(fingerprint)} -->`;
/** The hash in a story's text, when it has the marker. */
export const hashIn = (body: string | undefined): string | undefined => /<!-- claude-factory monitor=([0-9a-f]{16}) -->/.exec(body ?? "")?.[1];

/** What the story names about the Foundry: the steps of every built-in flow, by flow name. */
export type BuiltinSteps = Record<string, string[]>;

export interface StoryOptions {
  /** Cleaned log lines; undefined when they could not be cleaned with certainty (or are left out on purpose). */
  lines: string[] | undefined;
  /** The issue number of an earlier story of the same problem that was closed. */
  previous?: number;
  builtinSteps: BuiltinSteps;
}

interface Template {
  title: string;
  happened: string;
  effect: string;
  expected: string;
  reproduce: string[];
  where: string[];
}

const TEMPLATES: Record<string, Template> = {
  "restart-loop": {
    title: "Runs that step aside are restarted in a loop",
    happened: "The same run was resumed again and again within a few minutes. It steps aside (it waits or stops) and is started again at once, and again.",
    effect: "The run makes no progress and uses up a worker and requests while it loops. Other work may wait behind it.",
    expected: "A run that steps aside waits until the reason is gone. It is resumed once, not over and over.",
    reproduce: ["Start a run of the flow below that has to wait at the step below (for example for an area that another run holds).", "Let the scheduler resume it while the reason to wait is still there.", "Look at the number of resumes of the run: it grows every few seconds."],
    where: ["`src/queue/scheduler.ts` (resuming runs that wait)", "`src/engine/runner.ts` (stepping aside)"],
  },
  "watcher-error": {
    title: "A watcher fails its checks again and again",
    happened: "A watcher failed many checks in a row with the same kind of error. It does not start or follow any work while it fails.",
    effect: "Stories of that watcher are not picked up and no status is kept up to date until the error is gone.",
    expected: "A watcher recovers from the error, or reports it once in a clear way and keeps checking.",
    reproduce: ["Run a watcher whose check fails with the kind of error in the evidence.", "Wait for several checks.", "The status of the watcher shows the same error, with a growing number of failed checks."],
    where: ["`src/queue/watcher.ts` (the check of a watcher)", "`src/queue/watchers.ts` (starting watchers)"],
  },
  "github-limit": {
    title: "The Foundry uses up GitHub's request limit",
    happened: "GitHub's request limit was used up or nearly used up, and calls of the Foundry were refused.",
    effect: "Watchers cannot read or write issues, so no new work starts and status comments are not updated until the limit is lifted.",
    expected: "The Foundry stays well under the limit, and backs off in a clear way when it is near.",
    reproduce: ["Run the watchers with many issues for an hour.", "Read the request limit with `gh api rate_limit`.", "The `used` number is close to the `limit`, or the limit is hit."],
    where: ["`src/github.ts` (every call to GitHub)", "`src/queue/watchers.ts` (reading the request limit)", "`src/queue/watcher.ts` (how often a watcher calls GitHub)"],
  },
  "watcher-silent": {
    title: "A watcher stops checking",
    happened: "An enabled watcher finished no check for many times its interval.",
    effect: "Its stories are not picked up and its runs are not followed while it is silent.",
    expected: "An enabled watcher finishes a check at its interval, or shows an error.",
    reproduce: ["Enable a watcher with a short interval.", "Wait for several intervals.", "The watcher's last check does not move forward and it shows no error."],
    where: ["`src/queue/watcher.ts` (the timer and the check)", "`src/queue/watchers.ts` (starting and stopping)"],
  },
  "unexplained-failure": {
    title: "A run fails with an error the Foundry cannot explain",
    happened: "A run failed with an error that no rule of the Foundry explains, so the person who owns the run only sees a raw error.",
    effect: "The run stops and its owner cannot tell what to do. The cause may be a defect of the Foundry.",
    expected: "The error is explained in plain words, or the defect behind it is fixed.",
    reproduce: ["Run a flow of the kind below until it reaches the step below.", "Let the step fail with the error in the evidence.", "The failure shows no plain explanation."],
    where: ["`src/errors.ts` (the rules that explain an error)", "`src/failure.ts` (how a failure is classified)"],
  },
  "self-update": {
    title: "A self-update of the Foundry fails",
    happened: "The running Foundry tried to update itself from main. The build or its tests failed, the new version did not start healthy, going back failed, or the update record cannot be read.",
    effect: "The Foundry keeps running an old version, so a fix that reached main does not take effect. When going back failed, self-update stays off until a person repairs the checkout.",
    expected: "A version of main that builds and passes its tests is installed, and the server starts healthy on it.",
    reproduce: ["Switch on self-update and publish a commit on main that fails in the stage named in the evidence.", "Wait for the check (every 5 minutes).", "The update fails and the old version keeps running."],
    where: ["`src/self-update.ts` (the check, staging and the install)", "`src/self-update-state.ts` (the record, going back)", "`src/supervise.ts` (the guard of the first start)"],
  },
  "detector-failed": {
    title: "A detector of the monitor crashes",
    happened: "A detector of the monitor threw an error, so the problems it looks for are not checked.",
    effect: "A whole class of problems goes unseen while the detector crashes.",
    expected: "Every detector finishes a check without an error.",
    reproduce: ["Run the monitor for one check.", "A detector throws while it looks at the state of the Foundry.", "A finding \"detector failed\" appears."],
    where: ["`src/monitor/detectors.ts` (the detectors)"],
  },
};

const GENERIC: Template = {
  title: "The monitor found a problem of the Foundry",
  happened: "The monitor of the Foundry found a problem that lasted for more than one check.",
  effect: "Work of the Foundry may be slowed down or stopped.",
  expected: "The problem does not occur.",
  reproduce: ["Run the Foundry in the same situation as in the evidence.", "Wait for the monitor to check.", "The same problem is found again."],
  where: ["`src/monitor/detectors.ts` (the detectors of the monitor)"],
};

/** A name that is safe to print: lower-case words with dashes, no long run of letters or digits that could be a key. */
const safeId = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 40 && /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*$/.test(v) && v.split(/[-.]/).every((p) => p.length <= 14) ? v : undefined;

const timeText = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const countText = (counts: unknown): string[] => {
  if (!counts || typeof counts !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(counts).slice(0, 12)) {
    if (/^[a-z][a-z_]{0,39}$/.test(k) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9) out.push(`${k.replace(/_/g, " ")}: ${v}`);
  }
  return out;
};

const list = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

/** A fence longer than any run of backticks in the text. */
function fenced(lines: string[]): string {
  const safe = lines.map((l) => l.replace(/`/g, "'").replace(/[\r\n]+/g, " "));
  return ["````", ...safe, "````"].join("\n");
}

/**
 * The text of a bug story, from a fixed template per detector. Values of the finding are checked one by one
 * (a name, a count, a time) and left out when they are not what they should be; the raw summary and fingerprint never appear.
 */
export function buildStory(f: Finding, o: StoryOptions): { title: string; body: string } {
  const t = TEMPLATES[f.detector] ?? GENERIC;
  const ev = f.evidence ?? {};
  const flows = (Array.isArray(ev.flows) ? ev.flows : []).map((x) => safeId(x)).filter((x): x is string => !!x && x in o.builtinSteps);
  const customFlow = Array.isArray(ev.flows) && ev.flows.length > flows.length;
  const flowName = flows.length ? flows.join(", ") : customFlow ? "a custom flow" : undefined;
  const flowKey = flows[0] ?? ""; // a step is only named when it is a step of the built-in flow
  const stepNames = (Array.isArray(ev.steps) ? ev.steps : []).slice(0, 5).map((s) => (typeof s === "string" && /^[\w-]{1,40}$/.test(s) && (o.builtinSteps[flowKey] ?? []).includes(s) ? `\`${s}\`` : "a step"));
  const stepText = stepNames.length ? [...new Set(stepNames)].join(", ") : undefined;
  const times = (Array.isArray(ev.times) ? ev.times : []).slice(0, 5).map(timeText).filter((x): x is string => !!x);
  const counts = countText(ev.counts);
  const first = timeText(f.firstSeen);
  const last = timeText(f.lastSeen);
  const checks = Number.isFinite(f.count) && f.count >= 0 ? f.count : undefined;

  const evidence: string[] = [];
  if (flowName) evidence.push(`Flow: ${flowName}`);
  if (stepText) evidence.push(`Step: ${stepText}`);
  evidence.push(...counts);
  if (times.length) evidence.push(`Times: ${times.join("; ")}`);
  const evidenceText = [
    evidence.length ? list(evidence) : "No numbers were recorded.",
    o.lines === undefined ? "The log lines are left out: they could not be cleaned with certainty." : o.lines.length ? fenced(o.lines) : "",
  ].filter(Boolean).join("\n\n");

  const since = [
    first ? `First seen: ${first}.` : "",
    last ? `Last seen: ${last}.` : "",
    checks !== undefined ? `Seen in ${checks} check${checks === 1 ? "" : "s"}.` : "",
  ].filter(Boolean).join(" ");

  const where = (flowName ? [`The detector watches flow ${flowName}${stepText ? `, ${stepText}` : ""}.`] : []).concat(t.where.map((w) => `Look at ${w}.`));
  const body = [
    "## What happened",
    o.previous !== undefined ? `**Came back after the fix.** An earlier story, #${o.previous}, was closed, and the problem occurs again.\n\n${t.happened}` : t.happened,
    "## Since when and how often",
    since || "Not recorded.",
    "## Effect on work",
    t.effect,
    "## Evidence",
    evidenceText,
    "## What should happen instead",
    t.expected,
    "## How to see it again",
    t.reproduce.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    "## Where to look in the code",
    list(where),
    "## Acceptance criteria",
    "- [ ] The symptom no longer occurs.\n- [ ] A test covers the situation.",
    "## About this story",
    "The monitor of the Foundry wrote this story from a fixed template. It checked its text and left out names of other repositories, people, folders and keys.",
    markerFor(f.fingerprint),
  ].join("\n\n");
  return { title: t.title, body };
}

/** The short comment on an open story when the problem is seen again. */
export function seenAgainComment(f: Finding): string {
  const n = f.report?.seen ?? 0;
  const since = f.report ? f.report.at.slice(0, 10) : f.firstSeen.slice(0, 10);
  return `Seen again: ${n} time${n === 1 ? "" : "s"} since ${since}.\n\n<!-- claude-factory monitor-seen -->`;
}
