import { closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ZodType } from "zod";
import { FACTORY_HOME, claimHomeWrite } from "../home.js";
import { acquireLock, releaseLock } from "../home-migrate.js";

export type StoreErrorKind = "unreadable" | "not-json" | "wrong-format" | "locked" | "cannot-write";

/** A problem with a store file. The message names the file and the kind of problem, never a value from the file. */
export class StoreError extends Error {
  constructor(
    public kind: StoreErrorKind,
    public file: string,
    detail: string,
  ) {
    super(`${file} ${detail}`);
    this.name = "StoreError";
  }
}

/** The data folder, read on every call so tests and the data-folder move keep working. */
export const dataHome = () => process.env.FACTORY_HOME ?? FACTORY_HOME;

const LOCK_NAME = "auth.lock";
const WAIT_MS = 2000;

/** The lock this process holds (the account folder), set only inside withAuthLock. */
let held: string | undefined;

/** True while this process is inside withAuthLock. */
export const authLockHeld = () => held !== undefined;

const lockHeldByUs = (lock: string) => {
  try {
    return readFileSync(join(lock, "pid"), "utf8").trim() === String(process.pid);
  } catch {
    return false;
  }
};

/** Runs `fn` with `<home>/auth.lock` held. Creates a missing data folder (mode 0700); waits at most `waitMs`. */
export function withAuthLock<T>(fn: () => T, waitMs = WAIT_MS): T {
  if (held) throw new Error("withAuthLock is not re-entrant");
  const home = dataHome();
  const lock = join(home, LOCK_NAME);
  const until = Date.now() + waitMs;
  let result!: { value: T };
  claimHomeWrite(
    lock,
    () => {
      try {
        mkdirSync(home, { recursive: true, mode: 0o700 });
      } catch (e) {
        throw new StoreError("cannot-write", home, `cannot be created (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      let got: boolean;
      try {
        got = acquireLock(lock, Math.max(0, until - Date.now()));
      } catch (e) {
        throw new StoreError("cannot-write", lock, `cannot be locked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      }
      if (!got) throw new StoreError("locked", lock, "is held by another scf process; try again, or delete this folder if no scf is running");
      held = lock;
      let failed = false;
      try {
        result = { value: fn() };
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        held = undefined;
        try {
          releaseLock(lock);
        } catch (e) {
          // a failed release must not hide the error of `fn`
          if (!failed) throw new StoreError("cannot-write", lock, `cannot be unlocked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
        }
      }
    },
    waitMs,
    (kind, detail) =>
      kind === "busy"
        ? new StoreError("locked", detail, "is held by another scf process; try again in a moment")
        : new StoreError("cannot-write", home, `cannot be changed: the data folder moved to ${detail}; restart scf`),
  );
  return result.value;
}

const lstatOk = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Reads and checks a JSON file. A missing file gives `empty`; anything else wrong is a StoreError. */
export function readJsonFile<T>(path: string, schema: ZodType<T>, empty: T): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !lstatOk(path)) return empty; // a dangling symlink is an existing, unreadable entry
    throw new StoreError("unreadable", path, `cannot be read (${code ?? "error"})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoreError("not-json", path, "is not valid JSON");
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const at = r.error.issues[0]?.path.join(".") || "(top level)";
    throw new StoreError("wrong-format", path, `has the wrong format at ${at}`);
  }
  return r.data;
}

/** Writes the file through `<path>.tmp` (created 0600) and a rename. Only inside withAuthLock. */
export function writeJsonFile(path: string, data: unknown): void {
  if (!held) throw new Error("writeJsonFile must run inside withAuthLock");
  if (dirname(path) !== dirname(held)) throw new Error("writeJsonFile: the file is not in the locked folder");
  const tmp = `${path}.tmp`;
  try {
    rmSync(tmp, { force: true });
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (!lockHeldByUs(held)) throw new StoreError("locked", held, "was taken over while writing; try again");
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
    if (e instanceof StoreError) throw e;
    throw new StoreError("cannot-write", path, `cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

export interface AppendFile {
  /** Appends one line (no newline in it); a cut-off last line in the file is first ended with a newline. */
  append(line: string): void;
  close(): void;
}

/**
 * Opens a file for appending (created or set to 0600), only inside withAuthLock. Checks what can fail before the caller
 * changes anything: the path must be a regular file or missing, and the lock must still be ours.
 */
export function openAppendLocked(path: string): AppendFile {
  if (!held) throw new Error("openAppendLocked must run inside withAuthLock");
  if (dirname(path) !== dirname(held)) throw new Error("openAppendLocked: the file is not in the locked folder");
  const fail = (e: unknown) => new StoreError("cannot-write", path, `cannot be written (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  const notFile = () => Object.assign(new Error("not a regular file"), { code: "ENOTSUP" });
  let fd: number | undefined;
  let needsBreak = false;
  try {
    try {
      if (!lstatSync(path).isFile()) throw notFile();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    fd = openSync(path, "a+", 0o600);
    if (!fstatSync(fd).isFile()) throw notFile();
    fchmodSync(fd, 0o600);
    const size = fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      needsBreak = last[0] !== 0x0a;
    }
    if (!lockHeldByUs(held)) throw new StoreError("locked", held, "was taken over while writing; try again");
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (e instanceof StoreError) throw e;
    throw fail(e);
  }
  const open = fd;
  let closed = false;
  return {
    append(line) {
      if (closed) throw fail({ code: "EBADF" });
      if (line.includes("\n")) throw new Error("append: a line must not hold a newline");
      const buf = Buffer.from((needsBreak ? "\n" : "") + line + "\n", "utf8");
      try {
        let off = 0;
        while (off < buf.length) off += writeSync(open, buf, off, buf.length - off);
      } catch (e) {
        throw fail(e);
      }
      needsBreak = false;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(open);
      } catch {
        // nothing more to do
      }
    },
  };
}
