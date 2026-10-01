import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  acquireLock, dropEmptyHomeVars, explicitHome, jsonFiles, lockHolder, lockPath, pidAlive, releaseLock, removeTree,
  replacePath, runningRuns, sameSnapshot, sleepSync, snapshot, type RunningRun,
} from "./home-migrate.js";
import { RESTART_CODE } from "./supervise.js";

export { explicitHome, dropEmptyHomeVars, runningRuns };

export const NOTE_NAME = "MOVED-TO-SPAGHETTI-CODE-FOUNDRY.txt";
export const MARKER_NAME = ".migrated-from";
const MIB = 1024 * 1024;

export interface HomePaths {
  oldHome: string;
  newHome: string;
  note: string;
  lock: string;
}

export function homePaths(): HomePaths {
  const oldHome = join(homedir(), ".claude-factory");
  const newHome = join(homedir(), ".spaghetti-code-foundry");
  return { oldHome, newHome, note: join(oldHome, NOTE_NAME), lock: lockPath(newHome) };
}

/** The old folder is used only while it exists, has no note, and the new folder does not exist. */
export function defaultHome(): string {
  const { oldHome, newHome, note } = homePaths();
  return !existsSync(newHome) && existsSync(oldHome) && !existsSync(note) ? oldHome : newHome;
}

/** The data folder in use. Chosen at CLI start by prepareDataHome(); a live binding for every importer. */
export let FACTORY_HOME: string = explicitHome(process.env) ?? defaultHome();

export interface MigrateResult {
  status: "migrated" | "skipped" | "postponed" | "failed";
  home: string;
  reason?: "running" | "space" | "busy" | "moved-missing" | "incomplete";
  message: string;
  warnings: string[];
  needBytes?: number;
}

export interface MigrateOptions {
  from: string;
  to: string;
  env?: NodeJS.ProcessEnv;
  log?: (m: string) => void;
  /** Test hooks. */
  copy?: (from: string, tmp: string) => void;
  freeBytes?: (dir: string) => number;
  sizeBytes?: (dir: string) => number;
  repair?: (repo: string, paths: string[]) => void;
  writeNote?: (from: string, to: string, extra: string[]) => void;
  checkConfig?: (path: string) => void;
  /** How long to wait for the lock before postponing (default 5 s). */
  lockWaitMs?: number;
}

interface Marker {
  from: string;
  state: "copying" | "repairing" | "done";
  at: string;
  /** Lines for the note, kept so a note written on a later start says the same. */
  noteExtra?: string[];
}

const readMarker = (home: string): Marker | undefined => {
  try {
    return JSON.parse(readFileSync(join(home, MARKER_NAME), "utf8")) as Marker;
  } catch {
    return undefined;
  }
};
const writeMarker = (home: string, m: Marker) => writeFileSync(join(home, MARKER_NAME), JSON.stringify(m, null, 2));

/** Like existsSync, but a dangling symlink counts. */
const pathExists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const defaultFree = (dir: string) => {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};
const defaultSize = (dir: string) => Number.parseInt(execFileSync("du", ["-sk", dir], { encoding: "utf8" }), 10) * 1024;

/** Re-points git's worktree links in `repo` at `paths`. */
export function repairWorktrees(repo: string, paths: string[]): void {
  execFileSync("git", ["-C", repo, "worktree", "repair", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
}

const repairCommand = (repo: string, paths: string[]) => `git -C ${repo} worktree repair ${paths.join(" ")}`;

const noteText = (from: string, to: string, extra: string[]) =>
  [
    `This folder is a backup. Everything was copied to ${to} on ${new Date().toISOString().slice(0, 10)}.`,
    "Nothing in this folder is used or changed anymore.",
    "Run workspaces here are no longer linked to your repositories.",
    "If you use the login service, run `scf service install` once (its log is still in this folder).",
    "You can delete this folder once everything works.",
    ...(extra.length ? ["", ...extra] : []),
    "",
  ].join("\n");

function defaultWriteNote(from: string, to: string, extra: string[]) {
  writeFileSync(join(from, NOTE_NAME), noteText(from, to, extra));
}

/** Leaf string values of a parsed YAML document, by key path (`watchers.0.flow`). */
function leaves(v: unknown, path: string[] = [], out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof v === "string") out.push([path.join("."), v]);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out);
  return out;
}

const pointsInto = (value: string, from: string) => replacePath(value, from, "\0") !== value;

/** Rewrites paths into the old folder inside the copy's config.yaml. Returns changed keys and still-old keys. */
function rewriteConfig(file: string, root: string, from: string, to: string, check?: (p: string) => void): { changed: string[]; stale: string[] } {
  if (!existsSync(file)) return { changed: [], stale: [] };
  const text = readFileSync(file, "utf8");
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return { changed: [], stale: [] };
  }
  const pairs: Array<[string, string]> = [[from, to]];
  if (dirname(from) === homedir() && dirname(to) === homedir()) pairs.push([`~/${basename(from)}`, `~/${basename(to)}`]);
  const keys = leaves(doc).filter(([, v]) => pairs.some(([f]) => pointsInto(v, f))).map(([k]) => k);
  if (!keys.length) return { changed: [], stale: [] };
  // A symlinked config.yaml is only written when its target is inside the copy; never the original.
  if (lstatSync(file).isSymbolicLink() && !realpathSync(file).startsWith(realpathSync(root) + sep)) return { changed: [], stale: keys };
  let next = text;
  for (const [f, t] of pairs) next = replacePath(next, f, t);
  if (next === text) return { changed: [], stale: [] };
  writeFileSync(file, next);
  try {
    check?.(file);
    return { changed: keys, stale: [] };
  } catch {
    writeFileSync(file, text);
    return { changed: [], stale: keys };
  }
}

/** Worktrees of copied runs, by repo. Runs whose worktree can't be repaired are named in `warnings`. */
function worktreeGroups(home: string): { groups: Map<string, string[]>; warnings: string[] } {
  const groups = new Map<string, string[]>();
  const warnings: string[] = [];
  const runsDir = join(home, "runs");
  if (!existsSync(runsDir)) return { groups, warnings };
  for (const id of readdirSync(runsDir)) {
    let run: { workdir?: string; repo?: string };
    try {
      run = JSON.parse(readFileSync(join(runsDir, id, "run.json"), "utf8"));
    } catch {
      continue;
    }
    const workdir = run.workdir;
    if (!workdir || !workdir.startsWith(join(runsDir, id) + sep)) continue;
    let gitFile: string;
    try {
      if (!lstatSync(join(workdir, ".git")).isFile()) continue;
      gitFile = readFileSync(join(workdir, ".git"), "utf8");
    } catch {
      continue;
    }
    const gitdir = /^gitdir:\s*(.+)$/m.exec(gitFile)?.[1]?.trim();
    if (!gitdir || !existsSync(gitdir) || !run.repo || !existsSync(run.repo)) {
      warnings.push(`run ${id}: its worktree is not linked to a repository any more, so it was not repaired`);
      continue;
    }
    groups.set(run.repo, [...(groups.get(run.repo) ?? []), workdir]);
  }
  return { groups, warnings };
}

/**
 * Points the worktrees at their new paths, one path at a time. With `back`, a failure rolls back every path
 * done so far (and the failing one, as git may have changed it before it failed); paths that can't be put
 * back are thrown as manual commands.
 */
function repairAll(groups: Map<string, string[]>, repair: (repo: string, paths: string[]) => void, back?: (p: string) => string): string | undefined {
  const done: Array<[string, string]> = [];
  for (const [repo, paths] of groups) {
    for (const path of paths) {
      try {
        repair(repo, [path]);
        done.push([repo, path]);
      } catch (e) {
        const err = `git worktree repair failed in ${repo}: ${(e as Error).message.split("\n")[0]}`;
        if (!back) return err;
        const failed: string[] = [];
        for (const [r, p] of [...done, [repo, path] as [string, string]]) {
          try {
            repair(r, [back(p)]);
          } catch {
            failed.push(repairCommand(r, [back(p)]));
          }
        }
        if (failed.length) throw Object.assign(new Error(err), { manual: failed });
        return err;
      }
    }
  }
  return undefined;
}

const result = (status: MigrateResult["status"], home: string, message: string, extra: Partial<MigrateResult> = {}): MigrateResult =>
  ({ status, home, message, warnings: [], ...extra });

/** Copies the old data folder to the new one in a safe way. See docs/USER_GUIDE.md ("Upgrading"). */
export function migrateDataHome(o: MigrateOptions): MigrateResult {
  const { from, to } = o;
  const env = o.env ?? process.env;
  const note = join(from, NOTE_NAME);
  const writeNote = o.writeNote ?? defaultWriteNote;
  const repair = o.repair ?? repairWorktrees;
  const warnings: string[] = [];
  const tryNote = (extra: string[] = []) => {
    try {
      writeNote(from, to, extra);
    } catch (e) {
      warnings.push(`could not write ${note}: ${(e as Error).message}; it is written on a later start`);
    }
  };

  const explicit = explicitHome(env);
  if (explicit) return result("skipped", explicit, "the data folder is set explicitly");
  if (pathExists(to)) {
    const marker = readMarker(to);
    if (marker && marker.from === from && existsSync(from)) {
      if (marker.state === "repairing") {
        // an earlier move was interrupted after the rename: finish forward, never roll back
        const { groups, warnings: w } = worktreeGroups(to);
        const err = repairAll(groups, repair);
        if (err) return result("failed", to, `an earlier move to ${to} is not finished: ${err}; it is tried again on the next start`, { reason: "incomplete", warnings: w });
        writeMarker(to, { ...marker, state: "done" });
        if (!existsSync(note)) tryNote(marker.noteExtra);
        return result("migrated", to, `finished moving the data folder to ${to}`, { warnings: [...w, ...warnings] });
      }
      if (!existsSync(note)) {
        tryNote(marker.noteExtra);
        return result("skipped", to, "the data folder was already moved", { warnings });
      }
    }
    return result("skipped", to, "the new data folder already exists");
  }
  if (!existsSync(from)) return result("skipped", to, "there is no old data folder");
  if (existsSync(note)) {
    return result("failed", from, `the data folder was moved to ${to}, but that folder is missing. Restore it, set SCF_HOME to the folder you want, or delete ${note} to copy ${from} again.`, { reason: "moved-missing" });
  }

  const parent = dirname(to);
  const tmpBase = `${basename(to)}.migrating-`;
  const tmp = join(parent, `${tmpBase}${process.pid}`);
  const stagingBase = `${basename(to)}.staging-`;
  const staging = join(parent, `${stagingBase}${process.pid}`);
  // Stale temp folders of dead processes (only ours: they hold our marker) go before the space check.
  try {
    for (const n of readdirSync(parent)) {
      const isStaging = n.startsWith(stagingBase);
      const m = isStaging || n.startsWith(tmpBase) ? /^(\d+)$/.exec(n.slice((isStaging ? stagingBase : tmpBase).length)) : null;
      if (!m || (Number(m[1]) !== process.pid && pidAlive(Number(m[1])))) continue;
      // a staging folder is only ever made by us; a temp folder must hold our marker
      if (isStaging || readMarker(join(parent, n))) removeTree(join(parent, n));
    }
  } catch {
    // parent unreadable: the later steps report it
  }

  const running = runningRuns(join(from, "runs"));
  const blocked = (r: RunningRun[]) =>
    `${r.length} run(s) in ${from} are running: ${r.map((x) => `${x.id} (${x.why})`).join("; ")}. The move waits. Clear stale runs with \`scf resume <id>\`.`;
  if (running.length) return result("postponed", from, blocked(running), { reason: "running" });

  let need: number;
  try {
    need = Math.ceil((o.sizeBytes ?? defaultSize)(from) * 1.1) + 100 * MIB;
    const free = (o.freeBytes ?? defaultFree)(parent);
    if (free < need) return result("postponed", from, `not enough free space in ${parent}: need ${Math.ceil(need / MIB)} MiB, have ${Math.floor(free / MIB)} MiB. The move is tried again later.`, { reason: "space", needBytes: need });
  } catch (e) {
    return result("postponed", from, `could not check the free space: ${(e as Error).message}. The move is tried again later.`, { reason: "space" });
  }

  const before = snapshot(from);
  const lock = lockPath(to);
  let locked = false;
  const cleanup = () => {
    try {
      removeTree(staging);
      removeTree(tmp);
    } catch {
      // nothing more to do
    }
  };
  try {
    for (const d of [tmp, staging]) if (pathExists(d)) removeTree(d);
    // the marker goes in before the folder gets its final name, so a crash never leaves an unmarked temp folder
    mkdirSync(staging);
    writeMarker(staging, { from, state: "copying", at: new Date().toISOString() });
    renameSync(staging, tmp);
    (o.copy ?? defaultCopy)(from, tmp);
    for (const f of jsonFiles(tmp)) {
      const text = readFileSync(f, "utf8");
      const esc = (s: string) => JSON.stringify(s).slice(1, -1);
      const next = replacePath(text, esc(from), esc(to));
      if (next === text) continue;
      try {
        JSON.parse(next);
      } catch {
        continue;
      }
      writeFileSync(f, next);
    }
    const cfg = rewriteConfig(join(tmp, "config.yaml"), tmp, from, to, o.checkConfig);
    const extra: string[] = [];
    if (cfg.stale.length) {
      const w = `config.yaml still points into ${from} (${cfg.stale.join(", ")}); change these values before you delete the old folder`;
      warnings.push(w);
      extra.push(w);
    }
    writeMarker(tmp, { from, state: "repairing", at: new Date().toISOString(), noteExtra: extra });

    if (!acquireLock(lock, o.lockWaitMs ?? 5000)) {
      cleanup();
      if (pathExists(to)) return result("skipped", to, "the new data folder already exists");
      return result("postponed", from, `another scf process holds ${lock}; the move is tried again later`, { reason: "busy" });
    }
    locked = true;
    // Another migration may have finished while we copied: use its folder (before the snapshot sees its note).
    if (pathExists(to)) {
      cleanup();
      return result("skipped", to, "the new data folder already exists");
    }
    const again = runningRuns(join(from, "runs"));
    if (again.length || !sameSnapshot(before, snapshot(from))) {
      cleanup();
      return result("postponed", from, again.length ? blocked(again) : `${from} changed while it was copied; the move is tried again later`, { reason: "busy" });
    }
    // Node has no rename that never replaces; this check under the lock leaves a window of a few milliseconds.
    if (pathExists(to)) {
      cleanup();
      return result("skipped", to, "the new data folder already exists");
    }
    try {
      renameSync(tmp, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      cleanup();
      if (pathExists(to) && (code === "ENOTEMPTY" || code === "EEXIST")) return result("skipped", to, "the new data folder already exists");
      throw e;
    }

    const { groups, warnings: w } = worktreeGroups(to);
    warnings.push(...w);
    const back = (p: string) => from + p.slice(to.length);
    let err: string | undefined;
    try {
      err = repairAll(groups, repair, back);
    } catch (e) {
      // the rollback of the repairs failed: keep the new folder and show the manual commands
      const manual = ((e as { manual?: string[] }).manual ?? []).concat([...groups].map(([r, p]) => repairCommand(r, p)));
      warnings.push(`${(e as Error).message}; run these to finish: ${manual.join(" ; ")}`);
      extra.push("Worktrees need repairing. Run:", ...manual);
      tryNote(extra);
      return result("migrated", to, `moved the data folder to ${to}, but a worktree repair failed`, { warnings });
    }
    if (err) {
      try {
        renameSync(to, tmp);
        removeTree(tmp);
        return result("failed", from, `${err}. Nothing was changed; ${from} stays in use.`);
      } catch (e) {
        const manual = [...groups].map(([r, p]) => repairCommand(r, p));
        warnings.push(`${err}; could not put the old folder back (${(e as Error).message}); run: ${manual.join(" ; ")}`);
        extra.push("Worktrees need repairing. Run:", ...manual);
        tryNote(extra);
        return result("migrated", to, `moved the data folder to ${to}, but a worktree repair failed`, { warnings });
      }
    }
    try {
      writeMarker(to, { from, state: "done", at: new Date().toISOString(), noteExtra: extra });
    } catch (e) {
      warnings.push(`could not update ${join(to, MARKER_NAME)}: ${(e as Error).message}`);
    }
    tryNote(extra);
    const updated = cfg.changed.length ? ` Updated paths in config.yaml: ${cfg.changed.join(", ")}.` : "";
    return result("migrated", to, `moved the data folder: ${from} was copied to ${to}; ${from} is now a backup.${updated}`, { warnings });
  } catch (e) {
    cleanup();
    return result("failed", from, `could not move the data folder: ${(e as Error).message}. Nothing was changed; ${from} stays in use.`, { warnings });
  } finally {
    if (locked) releaseLock(lock);
  }
}

function defaultCopy(from: string, tmp: string) {
  cpSync(from, tmp, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (src) => {
      if (src === join(from, NOTE_NAME)) return false;
      const st = lstatSync(src);
      return !(st.isSocket() || st.isFIFO());
    },
  });
}

// ---- process side ---------------------------------------------------------------------------

let last: MigrateResult | undefined;

export function setFactoryHome(dir: string): void {
  FACTORY_HOME = dir;
}

/** Chooses the data folder at CLI start and moves the old one when it is safe. */
export function prepareDataHome(
  o: { env?: NodeJS.ProcessEnv; log?: (m: string) => void; waitMs?: number; checkConfig?: (p: string) => void } & Pick<MigrateOptions, "freeBytes" | "sizeBytes"> = {},
): MigrateResult {
  const env = o.env ?? process.env;
  const log = o.log ?? ((m: string) => process.stderr.write(m + "\n"));
  dropEmptyHomeVars(env);
  const explicit = explicitHome(env);
  if (explicit) {
    FACTORY_HOME = explicit;
    return (last = result("skipped", explicit, "the data folder is set explicitly"));
  }
  const { oldHome, newHome, lock } = homePaths();
  const until = Date.now() + (o.waitMs ?? 120_000);
  for (let pid = lockHolder(lock); pid !== undefined; pid = lockHolder(lock)) {
    if (Date.now() >= until) throw new Error(`another scf process (pid ${pid}) holds ${lock}; try again in a moment`);
    sleepSync(200);
  }
  const r = migrateDataHome({ from: oldHome, to: newHome, log, checkConfig: o.checkConfig, env, freeBytes: o.freeBytes, sizeBytes: o.sizeBytes });
  FACTORY_HOME = r.home;
  last = r;
  if (r.status !== "skipped" && r.reason !== "moved-missing" && r.reason !== "incomplete") log(`note: ${r.message}`);
  for (const w of r.warnings) log(`warning: ${w}`);
  return r;
}

/** The new folder when this process uses the old one and the folder was moved. */
export function homeMoved(): string | undefined {
  if (explicitHome(process.env)) return undefined;
  const { oldHome, newHome, note } = homePaths();
  if (FACTORY_HOME !== oldHome) return undefined;
  return existsSync(newHome) || existsSync(note) ? newHome : undefined;
}

/**
 * Wraps a write into the data folder: processes on the old folder take the move lock for a moment, and refuse once
 * the folder moved. `fail` builds the error for "busy" (detail: the lock) and "moved" (detail: the new folder).
 */
export function claimHomeWrite(path: string, write: () => void, waitMs: number, fail: (kind: "busy" | "moved", detail: string) => Error): void {
  const { oldHome, lock } = homePaths();
  if (explicitHome(process.env) || FACTORY_HOME !== oldHome || !(resolve(path) + sep).startsWith(oldHome + sep)) return write();
  if (!acquireLock(lock, waitMs)) throw fail("busy", lock);
  try {
    const moved = homeMoved();
    if (moved) throw fail("moved", moved);
    write();
  } finally {
    releaseLock(lock);
  }
}

/** Wraps the first write of a run: processes on the old folder take a short lock, and refuse once it moved. */
export function claimRunStart(runsDir: string, write: () => void, waitMs = 120_000): void {
  claimHomeWrite(runsDir, write, waitMs, (kind, detail) =>
    new Error(kind === "busy" ? `could not start the run: another scf process holds ${detail}` : `the data folder moved to ${detail}; restart scf to continue`));
}

/** Why a long-running server should restart, if it should. */
export function homeRestartReason(o: { freeBytes?: (dir: string) => number } = {}): string | undefined {
  if (explicitHome(process.env)) return undefined;
  const { oldHome, newHome } = homePaths();
  if (FACTORY_HOME !== oldHome) return undefined;
  const moved = homeMoved();
  if (moved) return `the data folder moved to ${moved}`;
  if (last?.status !== "postponed" || (last.reason !== "running" && last.reason !== "busy" && last.reason !== "space")) return undefined;
  if (runningRuns(join(oldHome, "runs")).length) return undefined;
  if (last.reason === "space") {
    try {
      if ((o.freeBytes ?? defaultFree)(dirname(newHome)) < (last.needBytes ?? 0)) return undefined;
    } catch {
      return undefined;
    }
  }
  return `the data folder can move to ${newHome} now`;
}

/** Every minute: restart the server (when idle) so it picks up a moved or movable data folder. */
export function watchDataHome(o: {
  idle: () => boolean;
  beforeExit: () => void;
  log: (m: string) => void;
  /** Called once, when the restart has to wait for active runs. */
  busy?: () => void;
  everyMs?: number;
  reason?: () => string | undefined;
  exit?: (code: number) => void;
}): () => void {
  const reasonFn = o.reason ?? homeRestartReason;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  let told = "";
  const timer = setInterval(() => {
    const reason = reasonFn();
    if (!reason) return;
    if (process.env.FACTORY_SUPERVISED !== "1") {
      if (told !== "unsupervised") o.log(`${reason} — restart scf to use it`);
      told = "unsupervised";
      return;
    }
    if (!o.idle()) {
      if (told !== "busy") {
        o.log(`${reason} — restarting as soon as no run is active`);
        o.busy?.();
      }
      told = "busy";
      return;
    }
    clearInterval(timer);
    o.log(`${reason} — restarting`);
    o.beforeExit();
    exit(RESTART_CODE);
  }, o.everyMs ?? 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
