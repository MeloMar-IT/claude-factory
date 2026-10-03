import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Exit code a server uses to ask its supervisor for a restart (a new build is installed). */
export const RESTART_CODE = 75;

/** Newest modification time of the built JavaScript (changes whenever `npm run build` runs). */
export function buildStamp(distDir: string): number {
  let newest = 0;
  for (const f of readdirSync(distDir, { recursive: true }) as string[]) {
    if (!f.endsWith(".js")) continue;
    try {
      newest = Math.max(newest, statSync(join(distDir, f)).mtimeMs);
    } catch {
      // removed while building
    }
  }
  return newest;
}

/** An install of a new version that the server has not confirmed yet (kept in `self-update.json`). */
export interface PendingUpdate { from: string; to: string; phase: "apply" | "installed" }

export interface StartGuard {
  /** An install that is not confirmed yet. */
  pending: () => PendingUpdate | undefined;
  /** Puts the previous version back. Never throws. False: it could not. */
  rollBack: (why: "exit" | "timeout" | "interrupted", p: PendingUpdate) => Promise<boolean>;
  /** How long a new version has to confirm it is healthy (default 180 000). */
  healthMs?: number;
  /** How often the record is read (default 1 000). */
  pollMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the server as a child process and starts it again when it exits with RESTART_CODE, so a
 * `factory ui` in a terminal (or under launchd) picks up new builds by itself. Ctrl+C reaches the
 * child directly (same process group); the supervisor then exits with the child's code.
 */
export async function supervise(cliPath: string, args: string[], log: (m: string) => void, guard?: StartGuard): Promise<number> {
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  process.on("SIGINT", () => (stopping = true)); // the child gets Ctrl+C itself
  process.on("SIGTERM", () => {
    stopping = true;
    child?.kill("SIGTERM");
  });
  const tried = new Set<string>(); // commits that were put back: not guarded again
  const readPending = () => {
    try {
      return guard?.pending();
    } catch {
      return undefined;
    }
  };
  const goBack = async (why: "exit" | "timeout" | "interrupted", p: PendingUpdate): Promise<boolean> => {
    tried.add(p.to);
    try {
      return await guard!.rollBack(why, p);
    } catch {
      return false; // rollBack never throws; the record tells what happened
    }
  };

  let restarted = false;
  for (;;) {
    let watch: PendingUpdate | undefined;
    if (guard) {
      const p = readPending();
      if (p && !tried.has(p.to)) {
        if (p.phase === "apply") {
          // an install that was cut off: finish going back first
          if (!(await goBack("interrupted", p))) log("could not go back to the previous version; starting the server as it is (see the Health view)");
        }
        else watch = p;
      }
      if (stopping) return 130;
    }
    const c = spawn(process.execPath, [cliPath, ...args], {
      stdio: "inherit",
      env: { ...process.env, FACTORY_SUPERVISED: "1", ...(guard ? { FACTORY_START_GUARD: "1" } : {}), ...(restarted ? { FACTORY_NO_OPEN: "1" } : {}) },
    });
    child = c;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => c.once("exit", (code, signal) => r({ code, signal })));
    let verdict: "exit" | "timeout" | "healthy" = "healthy";
    if (watch) {
      // decided in memory, with the values read before the start: a record that is cleared right after cannot change it
      const deadline = Date.now() + (guard!.healthMs ?? 180_000);
      let over = false;
      const poll = async (): Promise<"timeout" | "healthy" | "exit"> => {
        for (;;) {
          await sleep(guard!.pollMs ?? 1_000);
          if (over) return "exit";
          if (!readPending()) return "healthy";
          if (Date.now() >= deadline) return "timeout";
        }
      };
      verdict = await Promise.race([exit.then(() => "exit" as const), poll()]);
      over = true;
    }
    if (verdict === "timeout" && !stopping) {
      c.kill("SIGTERM");
      const hard = setTimeout(() => c.kill("SIGKILL"), 5_000);
      await exit;
      clearTimeout(hard);
    }
    const { code, signal } = await exit;
    if (stopping) return code ?? (signal ? 130 : 0);
    if (watch && verdict !== "healthy") {
      log((await goBack(verdict, watch)) ? "restarting with the previous version…" : "could not go back to the previous version; starting the server as it is (see the Health view)");
      restarted = true;
      continue;
    }
    if (code === RESTART_CODE) {
      log("restarting with the new version…");
      restarted = true;
      continue;
    }
    return code ?? (signal ? 130 : 0);
  }
}

/**
 * Inside a supervised server: every `everyMs`, if the build changed (and has been stable since the
 * previous check, so a build in progress is not picked up half-way) and nothing is running, exit
 * with RESTART_CODE.
 */
export function restartOnNewBuild(o: {
  distDir: string;
  idle: () => boolean;
  /** Called once when a new version is waiting but runs are active: stop starting new work. */
  drain?: () => void;
  beforeExit: () => void;
  log: (m: string) => void;
  everyMs?: number;
}) {
  const started = buildStamp(o.distDir);
  let last = started;
  let told = false;
  const timer = setInterval(() => {
    const now = buildStamp(o.distDir);
    const stable = now === last;
    last = now;
    if (now === started || !stable) return;
    if (!o.idle()) {
      if (!told) {
        o.log("a new version is installed — no new runs start; restarting when the active ones are done");
        o.drain?.();
      }
      told = true;
      return;
    }
    clearInterval(timer);
    o.log("a new version is installed — restarting");
    o.beforeExit();
    process.exit(RESTART_CODE);
  }, o.everyMs ?? 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
