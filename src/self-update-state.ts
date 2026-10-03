import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FACTORY_HOME } from "./flow/load.js";
import type { PendingUpdate, StartGuard } from "./supervise.js";

/**
 * The record of the self-update (`self-update.json` in the data folder) and what both the server and the supervisor do with it:
 * git calls, the install steps, going back to the previous version and confirming a healthy start.
 */

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const STAGES = ["install", "build", "test", "apply", "start"] as const;
export type FailStage = (typeof STAGES)[number];

const StateSchema = z.object({
  /** An install that is not confirmed yet. */
  pending: z.object({ from: Sha, to: Sha, phase: z.enum(["apply", "installed"]), stamp: z.number().optional() }).optional(),
  /** The commit of main that built and passed its tests in the stage folder. */
  tested: z.object({ commit: Sha, at: z.string() }).optional(),
  failed: z
    .object({ commit: Sha, stage: z.enum(STAGES), back: Sha.optional(), backOk: z.boolean().optional(), lines: z.array(z.string().max(300)).max(5).optional(), at: z.string() })
    .optional(),
  updated: z.object({ from: Sha, to: Sha, at: z.string() }).optional(),
});
export type UpdateState = z.infer<typeof StateSchema>;

export const updateFile = (): string => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "self-update.json");

/** The folder of the Foundry itself (the parent of `dist/`). */
export const foundryDir = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads the record. Missing file: empty. A file that cannot be read or is not valid: `broken`, and it is never overwritten. */
export function loadUpdateState(file = updateFile()): { state: UpdateState; broken: boolean } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { state: {}, broken: (e as NodeJS.ErrnoException).code !== "ENOENT" };
  }
  try {
    const res = StateSchema.safeParse(JSON.parse(text));
    return res.success ? { state: res.data, broken: false } : { state: {}, broken: true };
  } catch {
    return { state: {}, broken: true };
  }
}

export function saveUpdateState(state: UpdateState, file = updateFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Changes the record. False (and nothing written) when the record is broken. */
export function updateState(change: (s: UpdateState) => void, file = updateFile()): boolean {
  const { state, broken } = loadUpdateState(file);
  if (broken) return false;
  change(state);
  const clean = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined));
  saveUpdateState(clean, file);
  return true;
}

export const short = (sha: string): string => sha.slice(0, 7);

// ---- git ----

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** Runs git in `dir`. Never throws; `out` is stdout (or the error text when it failed). */
export function git(dir: string, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd: dir, env: GIT_ENV, timeout: timeoutMs, maxBuffer: 8_000_000 }, (err, stdout, stderr) =>
      done(err ? { ok: false, out: `${stderr || err.message}`.trim() } : { ok: true, out: stdout.trim() }));
  });
}

export const headOf = async (dir: string): Promise<string | undefined> => {
  const r = await git(dir, ["rev-parse", "HEAD"]);
  return r.ok && /^[0-9a-f]{40}$/.test(r.out) ? r.out : undefined;
};
export const branchOf = async (dir: string): Promise<string | undefined> => {
  const r = await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.ok ? r.out : undefined;
};
/** No changed and no untracked file (ignored files do not count). */
export const isClean = async (dir: string): Promise<boolean> => {
  const r = await git(dir, ["--no-optional-locks", "status", "--porcelain"]);
  return r.ok && r.out === "";
};

/** The commit and date of the checkout the Foundry runs from; undefined when `dir` is not the top of a git checkout. */
export function readVersion(dir: string): { commit: string; date: string } | undefined {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
    if (realpathSync(run(["rev-parse", "--show-toplevel"])) !== realpathSync(dir)) return undefined;
    const commit = run(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(commit)) return undefined;
    return { commit, date: run(["log", "-1", "--format=%cI", "HEAD"]) };
  } catch {
    return undefined;
  }
}

// ---- steps ----

export interface UpdateStep {
  name: "install" | "build" | "test";
  cmd: string;
  args: string[];
  timeoutMs?: number;
}
const MIN = 60_000;
export const DEFAULT_STEPS: UpdateStep[] = [
  { name: "install", cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], timeoutMs: 10 * MIN },
  { name: "build", cmd: "npm", args: ["run", "build"], timeoutMs: 10 * MIN },
  { name: "test", cmd: "npm", args: ["test"], timeoutMs: 15 * MIN },
];

const running = new Set<ChildProcess>();
let killed = 0;

/** The environment of a step: the Foundry's own settings and tokens stay out, tests run with CI=1. */
function stepEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(FACTORY_|SCF_|GH_TOKEN$|GITHUB_TOKEN$)/.test(k)) env[k] = v;
  return { ...env, CI: "1" };
}

/** Runs a step in its own process group. Never throws. `output` is the tail of stdout and stderr. */
export function runStep(step: UpdateStep, cwd: string): Promise<{ ok: boolean; output: string; killed?: boolean }> {
  return new Promise((done) => {
    const mark = killed;
    let output = "";
    let child: ChildProcess;
    try {
      child = spawn(step.cmd, step.args, { cwd, env: stepEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done({ ok: false, output: String((e as Error).message) });
    }
    running.add(child);
    const take = (b: Buffer) => { output = (output + b.toString()).slice(-20_000); };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => killGroup(child), step.timeoutMs ?? 10 * MIN);
    const end = (ok: boolean, extra = "") => {
      clearTimeout(timer);
      running.delete(child);
      done({ ok, output: output + extra, ...(killed !== mark ? { killed: true } : {}) });
    };
    child.on("error", (e) => end(false, `\n${e.message}`));
    child.on("close", (code) => end(code === 0));
  });
}

function killGroup(c: ChildProcess) {
  try {
    if (c.pid) process.kill(-c.pid, "SIGKILL");
  } catch {
    try {
      c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Kills every running step and its children, now. */
export function killSteps(): void {
  killed++;
  for (const c of running) killGroup(c);
  running.clear();
}

// ---- going back, confirming ----

export interface RollBackOptions {
  why: "exit" | "timeout" | "interrupted" | "apply";
  pending?: PendingUpdate;
  log: (m: string) => void;
  /** Output lines of the step that failed (already redacted). */
  lines?: string[];
  dir?: string;
  file?: string;
  steps?: UpdateStep[];
}

const CAUSE: Record<RollBackOptions["why"], string> = {
  exit: "the server stopped before it was healthy",
  timeout: "the server did not answer in time",
  interrupted: "the install was cut off",
  apply: "the install did not finish",
};
const CHANGED = "the checkout changed, so it was left as it is";

const stepOf = (steps: UpdateStep[], name: UpdateStep["name"]) => steps.find((s) => s.name === name);

/**
 * Puts the previous version back after an install that failed, was cut off or did not start healthy. Never throws.
 * False: it did not go back (or there was nothing to go back from). Logs and stores only fixed words and short SHAs.
 */
export async function rollBack(o: RollBackOptions): Promise<boolean> {
  const dir = o.dir ?? foundryDir();
  const file = o.file ?? updateFile();
  const steps = o.steps ?? DEFAULT_STEPS;
  let p: PendingUpdate | undefined;
  try {
    const loaded = loadUpdateState(file);
    if (loaded.broken) return false;
    p = o.pending ?? loaded.state.pending;
    if (!p) return false;
    const { from, to } = p;
    // a cut-off go-back is finished at the next start
    updateState((s) => { s.pending = { ...(s.pending ?? p!), from, to, phase: "apply" }; }, file);
    o.log(`${CAUSE[o.why]}; going back to ${short(from)}`);

    let refused: string | undefined;
    if ((await headOf(dir)) === to) {
      if ((await branchOf(dir)) === "main" && (await isClean(dir))) {
        if (!(await git(dir, ["reset", "--hard", "--quiet", from])).ok) refused = "git could not reset the checkout";
      } else refused = CHANGED;
    }
    if (!refused && ((await headOf(dir)) !== from || !(await isClean(dir)))) refused = CHANGED;
    if (!refused) {
      const differs = !(await git(dir, ["diff", "--quiet", from, to, "--", "package.json", "package-lock.json"])).ok;
      const install = stepOf(steps, "install");
      const build = stepOf(steps, "build");
      if (differs && install && !(await runStep(install, dir)).ok) refused = "the previous version could not be installed";
      else if (!build || !(await runStep(build, dir)).ok) refused = "the previous version could not be built";
    }
    if (refused) o.log(refused);
    else o.log(`went back to ${short(from)}`);
    const backOk = !refused;
    try {
      updateState((s) => {
        s.pending = undefined;
        s.tested = undefined;
        if (s.updated?.to === to) s.updated = undefined;
        s.failed = {
          commit: to,
          stage: o.why === "apply" || o.why === "interrupted" ? "apply" : "start",
          back: from,
          backOk,
          ...(o.lines?.length ? { lines: o.lines.slice(0, 5) } : {}),
          at: new Date().toISOString(),
        };
      }, file);
    } catch {
      o.log("the self-update record could not be written");
    }
    return backOk;
  } catch {
    try {
      o.log("going back failed");
    } catch {
      // nothing left to do
    }
    return false;
  }
}

export interface ConfirmOptions {
  /** The build stamp of the dist folder this server loaded. */
  stamp: number;
  log: (m: string) => void;
  dir?: string;
  file?: string;
  /** For tests: true when the server answers. */
  fetch?: (url: string) => Promise<boolean>;
}

/**
 * Called by the server once it listens: when it is the build of an install that is waiting for confirmation, clears the
 * record's `pending` and writes `updated`. Every other case logs one fixed line and leaves the record alone.
 */
export async function confirmStart(url: string, o: ConfirmOptions): Promise<boolean> {
  try {
    const file = o.file ?? updateFile();
    const { state, broken } = loadUpdateState(file);
    if (broken) return o.log("self-update: the record could not be read; the start is not confirmed"), false;
    const p = state.pending;
    if (!p) return false;
    if (p.phase !== "installed") return o.log("self-update: the install is not finished; the start is not confirmed"), false;
    if ((await headOf(o.dir ?? foundryDir())) !== p.to) return o.log("self-update: the checkout is not at the installed commit; the start is not confirmed"), false;
    if (p.stamp !== o.stamp) return o.log("self-update: this is not the build that was installed; the start is not confirmed"), false;
    const answer = o.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok));
    if (!(await answer(`${url.replace(/\/$/, "")}/api/ready`).catch(() => false))) return o.log("self-update: the server did not answer; the start is not confirmed"), false;
    updateState((s) => {
      s.pending = undefined;
      s.failed = undefined;
      s.tested = undefined;
      s.updated = { from: p.from, to: p.to, at: new Date().toISOString() };
    }, file);
    o.log(`self-update: now running ${short(p.to)}`);
    return true;
  } catch {
    return false;
  }
}

/** What the supervisor uses to guard the start of a new version. */
export function startGuard(log: (m: string) => void, o: { dir?: string; file?: string; steps?: UpdateStep[]; healthMs?: number; pollMs?: number } = {}): StartGuard {
  let warned = false;
  return {
    pending: () => {
      const { state, broken } = loadUpdateState(o.file);
      if (broken) {
        if (!warned) log("self-update: self-update.json could not be read; self-update is stopped until a person checks the checkout");
        warned = true;
        return undefined;
      }
      return state.pending;
    },
    rollBack: (why, p) => rollBack({ why, pending: p, log, dir: o.dir, file: o.file, steps: o.steps }),
    ...(o.healthMs !== undefined ? { healthMs: o.healthMs } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
  };
}
