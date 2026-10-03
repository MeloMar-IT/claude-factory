import { z } from "zod";
import { RepoError } from "./repo-url.js";

/** Per-repository settings an admin sets. They are stored and shown only; runs do not use them yet. */
export const MAX_BRANCH = 200;
export const MAX_DOC_PATH = 300;
export const MAX_COMMAND = 500;
export const MAX_LIST = 50;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A branch name by git's rules (git check-ref-format), at most 200 characters, and not "@". */
export function validBranchName(name: unknown): boolean {
  if (typeof name !== "string" || !name || name.length > MAX_BRANCH) return false;
  if (name === "@" || name === "HEAD" || CONTROL.test(name)) return false;
  if (/[ ~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

/** A branch pattern: a branch name where "*" matches any text and "?" one character. No "[…]". */
export const validBranchPattern = (pattern: unknown): boolean => typeof pattern === "string" && validBranchName(pattern.replace(/[*?]/g, "x"));

/** A path inside the repository: relative, no "." or ".." parts, no empty parts, no backslash. */
export function validDocPath(path: unknown): boolean {
  if (typeof path !== "string" || !path || path.length > MAX_DOC_PATH || CONTROL.test(path)) return false;
  if (/^[/~-]/.test(path) || path.includes("\\")) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const validCommand = (c: unknown) => typeof c === "string" && c.length >= 1 && c.length <= MAX_COMMAND && !CONTROL.test(c) && c === c.trim();
const list = (valid: (x: unknown) => boolean) => z.array(z.string()).min(1).max(MAX_LIST).refine((a) => a.every(valid) && new Set(a).size === a.length);

/** The stored form: strict, never empty, every value already checked. */
export const RepoSettingsSchema = z
  .object({
    testCommand: z.string().refine(validCommand),
    docs: list(validDocPath),
    protectedBranches: list(validBranchPattern),
    mainBranch: z.string().refine(validBranchName),
    developBranch: z.string().refine(validBranchName),
  })
  .partial()
  .strict()
  .refine((s) => Object.keys(s).length > 0);

export type RepoSettings = z.infer<typeof RepoSettingsSchema>;

const bad = (message: string) => new RepoError("bad-settings", message);
const KEYS = ["testCommand", "docs", "protectedBranches", "mainBranch", "developBranch"];
const PATTERN_HELP = '"*" matches any text, "?" one character';
const shown = (t: string) => JSON.stringify(t.replace(CONTROL_G, "?").slice(0, 80));
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f]/g;

function checkList(name: string, v: unknown, valid: (x: string) => boolean, what: string, cut: (x: string) => string = (x) => x.trim()): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad(`${name} must be a list`);
  if (v.length > MAX_LIST) throw bad(`${name} may have at most ${MAX_LIST} entries`);
  const out: string[] = [];
  for (const e of v) {
    if (typeof e !== "string") throw bad(`every entry of ${name} must be text`);
    const t = cut(e);
    if (!t) continue;
    if (!valid(t)) throw bad(`${shown(t)} is not ${what}`);
    if (!out.includes(t)) out.push(t);
  }
  return out.length ? out : undefined;
}

function branch(name: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`${name} must be text`);
  const t = v.trim();
  if (!t) return undefined;
  if (!validBranchName(t)) throw bad(`${name} must be a valid git branch name (at most ${MAX_BRANCH} characters, not "@")`);
  return t;
}

/** Checks the input from an admin and returns the settings to store: trimmed, without empty entries or repeats. `{}` clears them. */
export function checkRepoSettings(input: unknown): RepoSettings {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw bad("the settings must be an object");
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw bad(`unknown setting ${shown(k.slice(0, 40))}`);
  const out: RepoSettings = {};
  if (o.testCommand !== undefined && o.testCommand !== null) {
    if (typeof o.testCommand !== "string") throw bad("testCommand must be text");
    const c = o.testCommand.trim();
    if (CONTROL.test(c)) throw bad("testCommand must be one line without control characters");
    if (c.length > MAX_COMMAND) throw bad(`testCommand must be at most ${MAX_COMMAND} characters`);
    if (c) out.testCommand = c;
  }
  const docs = checkList("docs", o.docs, validDocPath, 'a path inside the repository (not starting with "/", "~" or "-"; no "." or ".." parts; no backslash)', (x) => x.trim().replace(/\/$/, ""));
  if (docs) out.docs = docs;
  const prot = checkList("protectedBranches", o.protectedBranches, validBranchPattern, `a branch pattern (${PATTERN_HELP}; no "[…]")`);
  if (prot) out.protectedBranches = prot;
  const main = branch("mainBranch", o.mainBranch);
  if (main) out.mainBranch = main;
  const dev = branch("developBranch", o.developBranch);
  if (dev) out.developBranch = dev;
  return out;
}
