import { adoptRun, listRunBriefs } from "../engine/state.js";
import { basename, join } from "node:path";
import { StoreError } from "./store.js";
import { findUserByEmail, firstAdmin, listUsers } from "./users.js";

/** The source of a run the server started for a refinement session: "refinement <session id>". Set by server code only. */
export const REFINEMENT_SOURCE = "refinement ";
export const isRefinementRun = (source?: string): boolean => typeof source === "string" && source.startsWith(REFINEMENT_SOURCE);

/** The id of the first admin, or undefined when there is none or users.json cannot be read. Never throws. */
export function defaultOwner(): string | undefined {
  try {
    return firstAdmin()?.id;
  } catch {
    return undefined;
  }
}

/** The account a watcher's runs belong to: the account with its `owner` e-mail, else the first admin. Never throws. */
export function watcherOwner(email?: string): string | undefined {
  try {
    const found = email?.trim() ? findUserByEmail(email) : undefined;
    return found?.id ?? firstAdmin()?.id;
  } catch {
    return undefined;
  }
}

const same = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * A sentence when a watcher names an owner that is no account, and that owner is new or changed (a setting that was
 * saved before stays valid). Undefined when all is well.
 */
export function watcherOwnerProblem(next: { id: string; owner?: string }[], current: { id: string; owner?: string }[]): string | undefined {
  for (const w of next) {
    const owner = w.owner?.trim();
    if (!owner) continue;
    if (current.some((c) => c.id === w.id && same(c.owner, owner))) continue;
    let known = false;
    try {
      known = findUserByEmail(owner) !== undefined;
    } catch {
      known = false;
    }
    if (!known) return `watcher "${w.id}": the owner "${owner}" is not the e-mail of an account`;
  }
  return undefined;
}

/** Account names by id (empty when users.json cannot be read). */
export function ownerNames(): Map<string, string> {
  try {
    return new Map(listUsers().map((u) => [u.id, u.name]));
  } catch {
    return new Map();
  }
}

/** Gives every run without an owner to the first admin. Returns how many were changed; 0 without an admin. */
export function adoptRuns(runsDir: string, log?: (msg: string) => void): number {
  let owner: string | undefined;
  try {
    owner = firstAdmin()?.id;
  } catch (e) {
    // not "no admin yet": the account file is broken, which the operator should see
    // only the file name and the kind, as the sign-in code logs it: a message can hold a path
    const what = e instanceof StoreError ? `${basename(e.file)} ${e.kind}` : "error";
    log?.(`! runs without an owner cannot be given to the first admin: ${what}`);
    return 0;
  }
  if (!owner) return 0;
  let n = 0;
  for (const b of listRunBriefs(runsDir)) {
    // the folder name, never the runId stored in the file, decides which file is changed
    if (!b.owner && !isRefinementRun(b.source) && /^[\w-]+$/.test(b.dirName) && adoptRun(join(runsDir, b.dirName), owner)) n++;
  }
  if (n) log?.(`${n} run${n === 1 ? "" : "s"} without an owner given to the first admin`);
  return n;
}
