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

export interface Finding extends FindingInput {
  firstSeen: string;
  lastSeen: string;
  /** In how many checks it was seen (since it was first seen or reopened). */
  count: number;
  /** Not seen for 24 hours. */
  gone: boolean;
}

export const GONE_AFTER_MS = 24 * 3_600_000;
export const PRUNE_AFTER_MS = 30 * 86_400_000;
export const MAX_FINDINGS = 500;

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
    if (have && !have.gone) {
      out.push({ ...input, firstSeen: have.firstSeen, lastSeen: at, count: have.count + 1, gone: false });
    } else {
      const f: Finding = { ...input, firstSeen: at, lastSeen: at, count: 1, gone: false };
      fresh.push(f);
      out.push(f);
    }
  }
  for (const f of stored) {
    if (seen.has(f.fingerprint)) continue;
    const age = t - Date.parse(f.lastSeen);
    if (f.gone) {
      if (age <= PRUNE_AFTER_MS) out.push(f);
    } else if (age >= GONE_AFTER_MS) {
      const g = { ...f, gone: true };
      gone.push(g);
      out.push(g);
    } else {
      out.push(f);
    }
  }
  let dropped = 0;
  if (out.length > MAX_FINDINGS) {
    // Gone ones go first, then the open ones that were seen longest ago.
    const order = [...out.filter((f) => f.gone).sort(byLastSeen), ...out.filter((f) => !f.gone).sort(byLastSeen)];
    const drop = new Set(order.slice(0, out.length - MAX_FINDINGS));
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
    return { findings: data.findings, broken: false };
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
