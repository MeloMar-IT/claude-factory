import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `SCF_HOME || FACTORY_HOME`; an empty value counts as unset. */
export function explicitHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SCF_HOME || env.FACTORY_HOME || undefined;
}

/** Removes empty home variables, so `process.env.FACTORY_HOME ?? FACTORY_HOME` readers agree with explicitHome. */
export function dropEmptyHomeVars(env: NodeJS.ProcessEnv = process.env): void {
  for (const k of ["SCF_HOME", "FACTORY_HOME"]) if (env[k] === "") delete env[k];
}

/** A pid is alive when kill(pid, 0) works or fails with EPERM. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The lock next to the data folder, e.g. `~/.spaghetti-code-foundry.lock`. */
export const lockPath = (to: string) => join(dirname(to), `.${basename(to).replace(/^\./, "")}.lock`);

/** Pid of a live process holding the lock (-1: just created, pid not written yet), or undefined. */
export function lockHolder(lock: string): number | undefined {
  if (!existsSync(lock)) return undefined;
  let pid: number | undefined;
  try {
    pid = Number(readFileSync(join(lock, "pid"), "utf8").trim()) || undefined;
  } catch {
    // just created: the pid file is not written yet
  }
  if (pid === undefined) {
    try {
      return Date.now() - statSync(lock).mtimeMs < 5000 ? -1 : undefined;
    } catch {
      return undefined;
    }
  }
  return pidAlive(pid) ? pid : undefined;
}

/** `mkdir` plus a pid file; a lock whose pid is dead is broken. Waits up to `waitMs`. */
export function acquireLock(lock: string, waitMs = 0): boolean {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (lockHolder(lock) === undefined) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= until) return false;
    sleepSync(50);
  }
}

export function releaseLock(lock: string): void {
  rmSync(lock, { recursive: true, force: true });
}

export interface RunningRun {
  id: string;
  why: string;
}

/** Runs that block a move: unreadable run.json, `running` without pid, or `running` with a live pid. */
export function runningRuns(runsDir: string): RunningRun[] {
  if (!existsSync(runsDir)) return [];
  const out: RunningRun[] = [];
  for (const e of readdirSync(runsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const s = JSON.parse(readFileSync(join(runsDir, e.name, "run.json"), "utf8")) as { status?: string; pid?: number };
      if (s.status !== "running") continue;
      if (typeof s.pid !== "number") out.push({ id: e.name, why: "running, no pid recorded (started by an older version)" });
      else if (pidAlive(s.pid)) out.push({ id: e.name, why: `running (pid ${s.pid})` });
    } catch {
      out.push({ id: e.name, why: "run.json can't be read (delete the folder if it is a leftover)" });
    }
  }
  return out;
}

const isWorkspace = (r: string[]) => r[0] === "runs" && r.length === 3 && r[2] === "workspace";

/** Relative path → size and mtime for files ("d" for folders); nothing inside runs/<id>/workspace. */
export function snapshot(root: string, skip: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = [...rel, e.name];
      const key = r.join("/");
      if (skip.includes(key)) continue;
      if (e.isDirectory()) {
        out.set(key, "d");
        if (!isWorkspace(r)) walk(join(dir, e.name), r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        const st = lstatSync(join(dir, e.name));
        out.set(key, `${st.size}:${Math.floor(st.mtimeMs)}`);
      }
    }
  };
  walk(root, []);
  return out;
}

export function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Every `*.json` outside runs/<id>/workspace. */
export function jsonFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = [...rel, e.name];
      if (e.isDirectory()) {
        if (!isWorkspace(r)) walk(join(dir, e.name), r);
      } else if (e.isFile() && e.name.endsWith(".json")) out.push(join(dir, e.name));
    }
  };
  walk(root, []);
  return out;
}

const chmodAll = (p: string) => {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const n of readdirSync(p)) chmodAll(join(p, n));
  } catch {
    // best effort
  }
};

/** Removes a folder; retries after making everything writable. */
export function removeTree(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    chmodAll(p);
    rmSync(p, { recursive: true, force: true });
  }
}

/** Replaces `from` with `to` in text unless the next character continues a name (`[\w.-]`). */
export function replacePath(text: string, from: string, to: string): string {
  const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w.-])", "g");
  return text.replace(re, () => to);
}
