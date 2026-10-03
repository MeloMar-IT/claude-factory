import { execFile } from "node:child_process";
import { join } from "node:path";
import { listAllRepos } from "../auth/repos.js";
import { listUsers } from "../auth/users.js";
import type { Config } from "../config.js";
import { BLOCKED, liveRedactor, type Redactor } from "../credentials/redact.js";
import { TOOLS_DIR } from "../engine/guards.js";

/** What the monitor must never publish: the names of this install. `complete: false` when a list could not be read. */
export interface Names {
  /** The repository the story goes to (owner/repo); its name may stay. */
  target: string;
  /** Names of accounts (full names, and every word of them that is long enough). */
  users: string[];
  emails: string[];
  /** Every repository (owner/repo) this install knows. */
  repos: string[];
  /** Watcher ids. */
  watchers: string[];
  complete: boolean;
}

export const NO_NAMES: Names = { target: "", users: [], emails: [], repos: [], watchers: [], complete: true };

const lower = (s: string) => s.toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Reads the names from the accounts, the repositories and the config. Never throws. */
export function collectNames(target: string, config: Pick<Config, "watchers" | "monitor">): Names {
  let complete = true;
  const users = new Set<string>();
  const emails = new Set<string>();
  const repos = new Set<string>();
  try {
    for (const u of listUsers()) {
      if (u.name) users.add(u.name);
      if (u.email) emails.add(u.email);
    }
  } catch {
    complete = false;
  }
  try {
    for (const r of listAllRepos()) {
      const m = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(r.url);
      if (m) repos.add(m[1]!);
    }
  } catch {
    complete = false;
  }
  for (const w of config.watchers) if (w.github_repo) repos.add(w.github_repo);
  if (config.monitor.report_to) repos.add(config.monitor.report_to);
  return { target, users: [...users], emails: [...emails], repos: [...repos], watchers: config.watchers.map((w) => w.id), complete };
}

const isTarget = (names: Names, repo: string) => lower(repo) === lower(names.target);

/** Replaces the names of this install in a text. The target repository's name stays. Pure. */
export function cleanText(text: string, names: Names): string {
  let t = text;
  // Issues and pull requests of other repositories (links first, then the short form).
  t = t.replace(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/\d+\S*/gi, (m, repo: string) => (isTarget(names, repo) ? m : "an issue"));
  t = t.replace(/\b([\w.-]+\/[\w.-]+)#\d+\b/g, (m, repo: string) => (isTarget(names, repo) ? m : "an issue"));
  // Known repositories, longest first (so `a/b-c` is not cut at `a/b`).
  for (const repo of [...names.repos].filter((r) => !isTarget(names, r)).sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`https?://github\\.com/${esc(repo)}\\S*|(?<![\\w.-])${esc(repo)}(?![\\w-])`, "gi"), "another repository");
  }
  // Other links: only the target's stay.
  t = t.replace(/\bhttps?:\/\/[^\s)>\]"'`]+/gi, (m) => (names.target && lower(m).startsWith(`https://github.com/${lower(names.target)}`) ? m : "<url>"));
  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>");
  for (const e of names.emails) t = t.replace(new RegExp(esc(e), "gi"), "<email>");
  t = t.replace(/(?:\/Users|\/home)\/[^\s/"'`]+(?:\/[^\s"'`]*)?|[A-Za-z]:\\Users\\[^\s\\"'`]+(?:\\[^\s"'`]*)?|~\/[^\s"'`]*/g, "<path>");
  t = t.replace(/(?<![\w.])@[A-Za-z0-9][\w-]*/g, "<user>");
  // A whole registered name is removed whatever its length; the single words of a name only from 3 characters on.
  const users = names.users.flatMap((u) => [u.trim(), ...u.split(/\s+/).filter((w) => w.length >= 3)]);
  for (const u of [...new Set(users)].filter(Boolean).sort((a, b) => b.length - a.length)) t = t.replace(new RegExp(`(?<![\\w-])${esc(u)}(?![\\w-])`, "gi"), "<user>");
  for (const w of [...names.watchers].filter(Boolean).sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(?<![\\w-])${esc(w)}(?![\\w-])`, "gi"), "a watcher");
  }
  t = t.replace(/\b(?:gh[pousr]_|github_pat_|sk-)[\w-]{8,}/g, "<token>");
  return t;
}

/**
 * Cuts a log line to the part that says what went wrong: no time or tag in front, no "step … failed:" lead,
 * the first line only, at most 160 characters.
 */
export function cutLine(line: string): string {
  let t = (line.split("\n").find((l) => l.trim()) ?? "").trim();
  t = t.replace(/^(?:\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s*|\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?\s*)/i, ""); // a time in front
  t = t.replace(/^(?:\[[^\]]*\]\s*)+(?:[!>]\s*)?/, ""); // tags like [monitor]
  t = t.replace(/^(?:step "[\w./-]+" failed:\s*|(?:\w*Error|Error):\s*)/, ""); // the lead of the message
  return t.trim().slice(0, 160);
}

const WORDS = new Set(`a an and are as at be been but by can cannot could did do does done down each empty error errors even every fail failed failing fails failure fetch
for from get got had has have if in into is it its more most no non not of off on once only or other out over per run runs same since so some such than that the their then there
these they this those to too under until up use used uses using was were what when where which while who will with within without would yet zero one two three four five six seven
eight nine ten all any both either few many much new old own very
access accessible aborted abort accept accepted action actions add added address after again agent already also always another answer api approve approval area areas argument arguments
ask asked attempt attempts auth authentication available bad base before begin between block blocked body both branch branches broken buffer build built busy bytes cache call called calls cancel
cancelled canceled cannot change changed changes check checked checks child clean clone close closed code command commands comment commit commits complete completed config configuration connect connected
connection content context continue copy count create created credentials current data date deadline default delete deleted denied dependency detail details directory disabled disk does done download
duplicate email enabled end ended ends enough entry env environment error exceeded exceeds exist exists exit exited expected expired expires failed fatal field file files find finish finished first flag flow
flows folder format found full function git github given handle handler head header hit hook hour hours http https id ignored illegal invalid input install instead internal interval issue issues job json
key kill killed known label labels large last late left length less level limit limited line lines list load loaded local lock locked log logs long lost low match matched max maximum memory merge merged message
method minute minutes missing mode model module more must name named needs network next node none not found note nothing number object open opened operation option options order output pass pattern pending
permission permissions pipe plan point port possible process prompt protected pull push quota rate read ready reason received record refused rejected remote remove removed repository request requests required
reset resolve resolved resource response result results resume resumed retry return returned review rule rules running schedule script secondary seconds secret send sent server service session set setting
settings short shell should signal size skipped slow socket source space specified start started state status step steps stop stopped stream string success successfully support supported syntax system target task
temporary test tests text threshold time timed timeout times token tokens tool tools total trace tracking tree trigger true try type unable unauthorized unexpected unknown unrecognized unsupported update
upload url user valid value values version wait waiting want warning watcher watchers work working write written wrong yaml
pass_if pass if ok eof dns tcp tls ssh sha url uri utf json http https api cli gh
bad gateway service unavailable too many requests internal server not modified forbidden unauthorized conflict unprocessable entity gone found moved
enoent eacces eperm eexist enotdir eisdir econnreset econnrefused etimedout enotfound epipe emfile enospc eai_again eaddrinuse enomem ebusy enotempty exdev eio`.split(/\s+/));

/** The only placeholders a text may hold: the ones this cleaner and `cleanLine` write themselves. */
const PLACEHOLDERS = new Set(["<path>", "<email>", "<user>", "<url>", "<token>", "<run>", "<time>", "<date>", "<n>"]);

/**
 * Words that must never be published even when they are common words: names of people and watchers, and the owner
 * and name of every repository except the target. Lower case; a name of any length counts.
 */
export function blockedWords(names: Names): Set<string> {
  const out = new Set<string>();
  const add = (w: string) => {
    for (const p of w.toLowerCase().split(/[\s/@._-]+/)) if (p) out.add(p);
  };
  for (const u of names.users) add(u);
  for (const e of names.emails) add(e);
  for (const w of names.watchers) add(w);
  for (const r of names.repos) if (!isTarget(names, r)) add(r);
  return out;
}

/**
 * Keeps only words of a fixed public list, numbers of up to 5 digits and our own placeholders (`<path>`).
 * Everything else (a user name, a repository name, a branch name) becomes `…`. Undefined when no word is left.
 */
export function safeWords(line: string, blocked: ReadonlySet<string> = new Set()): string | undefined {
  const pieces = line.trim().split(/(\s+)/);
  const out: string[] = [];
  let kept = 0;
  const known = (core: string) => {
    if (PLACEHOLDERS.has(core)) return true;
    if (/^\d{1,5}$/.test(core)) return true;
    const parts = core.split(/[-_]/).filter(Boolean);
    // A word that is also a name of this install (another repository, an owner, a person) is never kept, even if it is on the list.
    if (blocked.has(lower(core)) || parts.some((p) => blocked.has(lower(p)))) return false;
    return parts.length > 0 && (WORDS.has(lower(core)) || parts.every((p) => WORDS.has(lower(p)) || /^\d{1,5}$/.test(p)));
  };
  for (const piece of pieces) {
    if (!piece.trim()) {
      out.push(piece);
      continue;
    }
    const m = /^([("'`[{]*)(.*?)([)"'`\]},.:;!?]*)$/.exec(piece)!;
    const core = m[2]!;
    if (!core) {
      out.push(piece);
    } else if (known(core)) {
      out.push(piece);
      kept++;
    } else {
      out.push("…");
    }
  }
  const text = out.join("").replace(/(?:…\s*)+…/g, "…").replace(/\s+/g, " ").trim();
  return kept === 0 ? undefined : text;
}

/** Runs `secret-scan --text` over a text (the existing secret scan). Rejects when it cannot run. */
export function scanText(text: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile(join(TOOLS_DIR, "secret-scan"), ["--text"], { timeout: timeoutMs, maxBuffer: 1_000_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    p.stdin?.on("error", () => {});
    p.stdin?.end(text);
  });
}

export interface CleanDeps {
  redactor?: () => Redactor;
  scan?: (text: string) => Promise<string>;
}

/** Looks like something that must not be published, after all cleaning. */
const LEFTOVER = [/[\w.+-]+@[\w-]+\.[\w.-]+/, /\/(?:Users|home)\//, /\b(?:gh[pousr]_|github_pat_|sk-|AKIA|ASIA)[\w-]{8,}/, /-----BEGIN /, /https?:\/\//, /\b[0-9a-f]{32,}\b/i];

/**
 * Cleans log lines for a bug story: cut, names removed, stored secrets and the secret scan applied, only known words kept.
 * Returns undefined when it cannot be sure (the story then leaves the evidence out). Never throws.
 */
export async function cleanLines(lines: string[] | undefined, names: Names, deps: CleanDeps = {}): Promise<string[] | undefined> {
  try {
    if (!names.complete || !lines) return undefined;
    const redactor = (deps.redactor ?? liveRedactor)();
    if (redactor === BLOCKED) return undefined;
    const cut = lines.slice(0, 5).map((l) => redactor.redact(cutLine(l))).map((l) => cleanText(l, names)).filter(Boolean);
    if (!cut.length) return undefined;
    const scanned = (await (deps.scan ?? scanText)(cut.join("\n"))).split("\n");
    if (scanned.length !== cut.length) return undefined;
    // Nothing may be left after the first passes: a leftover means a pass missed something, so the evidence is dropped.
    const after = scanned.join("\n");
    if (LEFTOVER.some((re) => re.test(after.replace(/<url>/g, ""))) || cleanText(after, names) !== after) return undefined;
    const out: string[] = [];
    const blocked = blockedWords(names);
    for (const l of scanned) {
      const words = safeWords(l.replace(/\[removed\]/g, "<token>"), blocked);
      if (words) out.push(words);
    }
    if (!out.length) return undefined;
    const joined = out.join("\n");
    if (LEFTOVER.some((re) => re.test(joined)) || cleanText(joined, names) !== joined || redactor.redact(joined) !== joined) return undefined;
    return [...new Set(out)];
  } catch {
    return undefined;
  }
}
