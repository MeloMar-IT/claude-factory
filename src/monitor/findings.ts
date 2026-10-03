import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FACTORY_HOME } from "../flow/load.js";

export type Severity = "critical" | "major" | "minor";
const RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };

/** What a finding shows as proof. Never a run id; times are ISO text. */
export interface Evidence {
  counts?: Record<string, number>;
  /** At most 5 times. */
  times?: string[];
  steps?: string[];
  /** At most 5 cleaned lines. */
  lines?: string[];
  flows?: string[];
  watchers?: string[];
  repos?: string[];
}

/** What a detector returns. */
export interface FindingInput {
  detector: string;
  /** The same for the same problem again: never a run id or a time. */
  fingerprint: string;
  severity: Severity;
  /** One plain sentence. */
  summary: string;
  evidence: Evidence;
  /** "foundry": the Foundry's own mechanics. "project": may only mean that a watched project is broken. */
  about: "foundry" | "project";
  /** The repository (owner/repo) the problem concerns, when there is one. */
  repo?: string;
}

/** The bug story written for a finding (see report.ts). Times are ISO text. */
export interface StoryRef {
  /** owner/repo the story lives in. */
  repo: string;
  issue: number;
  url: string;
  /** When the story was made. */
  at: string;
  /** In how many checks the finding was seen since the story was made or adopted. */
  seen: number;
  /** When GitHub was last asked about this story (the "seen again" comment goes out at most every 6 hours). */
  lookedAt?: string;
  /** When the story was closed as completed. */
  closedAt?: string;
  /** The story was closed as not planned: no new story, until it is reopened. */
  muted?: boolean;
}

/** The local day of a time, as YYYY-MM-DD. */
export const dayOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface Finding extends FindingInput {
  firstSeen: string;
  lastSeen: string;
  /** In how many checks it was seen (since it was first seen or reopened). */
  count: number;
  /** Not seen for 24 hours. */
  gone: boolean;
  /** The last 3 different local days it was seen on (oldest first). */
  days?: string[];
  /** A bug story is owed since then (kept until it is made, also when the problem goes away). */
  due?: string;
  report?: StoryRef;
  /** A check after the story's creation that did not see the finding (proof that the problem went away). */
  missedAt?: string;
  /** In how many checks in a row it was seen (a missed check resets it). A story is owed for a problem that lasts: 2 in a row. */
  streak?: number;
  /** The reasons a story for this finding was skipped and written to the monitor's log already (once per finding and reason). */
  skipped?: string[];
}

export const GONE_AFTER_MS = 24 * 3_600_000;
export const PRUNE_AFTER_MS = 30 * 86_400_000;
export const MAX_FINDINGS = 500;
/** The limit for findings with a story or an owed story, which are not counted in MAX_FINDINGS. */
export const MAX_STORY_FINDINGS = 1000;

export const findingsFile = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "monitor-findings.json");

export interface Merged {
  findings: Finding[];
  fresh: Finding[];
  gone: Finding[];
  /** How many findings were dropped to keep the cap. */
  dropped: number;
}

const byLastSeen = (a: Finding, b: Finding) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen);

/** Pure. Joins what a check found with what is stored. */
export function mergeFindings(stored: Finding[], found: FindingInput[], now: Date): Merged {
  const at = now.toISOString();
  const t = now.getTime();
  const old = new Map(stored.map((f) => [f.fingerprint, f]));
  const seen = new Set<string>();
  const fresh: Finding[] = [];
  const gone: Finding[] = [];
  const out: Finding[] = [];
  for (const input of found) {
    if (seen.has(input.fingerprint)) continue;
    seen.add(input.fingerprint);
    const have = old.get(input.fingerprint);
    const carry = have ? { ...(have.report ? { report: have.report } : {}), ...(have.due ? { due: have.due } : {}), ...(have.missedAt ? { missedAt: have.missedAt } : {}), ...(have.skipped ? { skipped: have.skipped } : {}) } : {};
    const days = [...new Set([...(have?.days ?? []), dayOf(now)])].slice(-3);
    if (have && !have.gone) {
      out.push({ ...input, firstSeen: have.firstSeen, lastSeen: at, count: have.count + 1, gone: false, streak: (have.streak ?? have.count) + 1, days, ...carry });
    } else {
      const f: Finding = { ...input, firstSeen: at, lastSeen: at, count: 1, gone: false, streak: 1, days, ...carry };
      fresh.push(f);
      out.push(f);
    }
  }
  for (const f of stored) {
    if (seen.has(f.fingerprint)) continue;
    const age = t - Date.parse(f.lastSeen);
    if (f.gone) {
      // A story that is made or owed is never pruned: it must survive a long outage of GitHub.
      if (age <= PRUNE_AFTER_MS || f.report || f.due) out.push(f);
    } else if (age >= GONE_AFTER_MS) {
      const g = { ...f, gone: true, streak: 0, ...(f.report ? { missedAt: at } : {}) };
      gone.push(g);
      out.push(g);
    } else {
      // A missed check ends the streak of consecutive sightings.
      out.push({ ...f, streak: 0, ...(f.report ? { missedAt: at } : {}) });
    }
  }
  let dropped = 0;
  // Findings that owe a story or have one are counted apart, so they never crowd out new findings (and are not evicted by them).
  const held = (f: Finding) => !!(f.report || f.due);
  const plain = out.filter((f) => !held(f));
  const keptStories = out.filter(held);
  const drop = new Set<Finding>();
  if (plain.length > MAX_FINDINGS) {
    // Gone ones go first, then the open ones that were seen longest ago.
    const order = [...plain].sort((a, b) => Number(b.gone) - Number(a.gone) || byLastSeen(a, b));
    for (const f of order.slice(0, plain.length - MAX_FINDINGS)) drop.add(f);
  }
  if (keptStories.length > MAX_STORY_FINDINGS) {
    // Only archived ones (gone, story made, nothing owed) can go, the oldest first.
    const archived = keptStories.filter((f) => f.gone && !f.due).sort(byLastSeen);
    for (const f of archived.slice(0, keptStories.length - MAX_STORY_FINDINGS)) drop.add(f);
  }
  if (drop.size) {
    dropped = drop.size;
    const kept = out.filter((f) => !drop.has(f));
    out.length = 0;
    out.push(...kept);
    // What was not stored is not announced: only stored findings are new or gone.
    for (const list of [fresh, gone]) {
      const keep = list.filter((f) => !drop.has(f));
      list.length = 0;
      list.push(...keep);
    }
  }
  out.sort((a, b) => Number(a.gone) - Number(b.gone) || RANK[a.severity] - RANK[b.severity] || byLastSeen(b, a));
  return { findings: out, fresh, gone, dropped };
}

const isTime = (x: unknown): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x));
const validReport = (r: unknown): r is StoryRef => {
  const x = r as StoryRef;
  return !!x && typeof x === "object" && typeof x.repo === "string" && Number.isInteger(x.issue) && typeof x.url === "string" && isTime(x.at)
    && typeof x.seen === "number" && (x.lookedAt === undefined || isTime(x.lookedAt)) && (x.closedAt === undefined || isTime(x.closedAt))
    && (x.muted === undefined || typeof x.muted === "boolean");
};
/** The optional fields of a stored finding: a malformed one is dropped, the finding stays. */
function tidy(f: Finding): Finding {
  const { days, due, report, missedAt, streak, skipped, ...rest } = f;
  return {
    ...rest,
    ...(Number.isInteger(streak) && streak! >= 0 ? { streak } : {}),
    ...(Array.isArray(days) && days.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? { days: days.slice(-3) } : {}),
    ...(isTime(due) ? { due } : {}),
    ...(validReport(report) ? { report } : {}),
    ...(isTime(missedAt) ? { missedAt } : {}),
    ...(Array.isArray(skipped) && skipped.length <= 10 && skipped.every((x) => typeof x === "string" && x.length <= 40) ? { skipped } : {}),
  };
}

const SEVERITIES = new Set(["critical", "major", "minor"]);
const valid = (f: unknown): f is Finding => {
  const x = f as Finding;
  return !!x && typeof x === "object" && typeof x.detector === "string" && typeof x.fingerprint === "string" && SEVERITIES.has(x.severity)
    && typeof x.summary === "string" && typeof x.firstSeen === "string" && typeof x.lastSeen === "string"
    && typeof x.count === "number" && typeof x.gone === "boolean" && !!x.evidence && typeof x.evidence === "object";
};

/** Reads the findings. A missing file is empty. A broken file is kept as `<file>.broken` and reads as empty. */
export function loadFindings(file = findingsFile()): { findings: Finding[]; broken: boolean } {
  if (!existsSync(file)) return { findings: [], broken: false };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { findings?: unknown };
    if (!Array.isArray(data.findings) || !data.findings.every(valid)) throw new Error("wrong shape");
    return { findings: data.findings.map(tidy), broken: false };
  } catch {
    try {
      renameSync(file, `${file}.broken`);
    } catch {
      // nothing more to do: the file is read as empty anyway
    }
    return { findings: [], broken: true };
  }
}

/** Writes through a temporary file, so a crash never leaves half a file. */
export function saveFindings(findings: Finding[], file = findingsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: 1, findings }, null, 1));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
