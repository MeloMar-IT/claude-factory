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

/**
 * Runs the server as a child process and starts it again when it exits with RESTART_CODE, so a
 * `factory ui` in a terminal (or under launchd) picks up new builds by itself. Ctrl+C reaches the
 * child directly (same process group); the supervisor then exits with the child's code.
 */
export function supervise(cliPath: string, args: string[], log: (m: string) => void): Promise<number> {
  let stopping = false;
  let child: ReturnType<typeof spawn> | undefined;
  process.on("SIGINT", () => (stopping = true)); // the child gets Ctrl+C itself
  process.on("SIGTERM", () => {
    stopping = true;
    child?.kill("SIGTERM");
  });
  return new Promise((resolve) => {
    const start = (restarted: boolean) => {
      child = spawn(process.execPath, [cliPath, ...args], {
        stdio: "inherit",
        env: { ...process.env, FACTORY_SUPERVISED: "1", ...(restarted ? { FACTORY_NO_OPEN: "1" } : {}) },
      });
      child.on("exit", (code, signal) => {
        if (code === RESTART_CODE && !stopping) {
          log("restarting with the new version…");
          start(true);
        } else resolve(code ?? (signal ? 130 : 0));
      });
    };
    start(false);
  });
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
