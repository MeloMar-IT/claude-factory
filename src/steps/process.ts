import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  logFile: string;
  /** Called with each complete stdout line. */
  onLine?: (line: string) => void;
}

/** process.env + overrides; an override of `undefined` removes the variable. */
function mergeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

/** Spawn a process, tee stdout/stderr into a log file, and collect output. */
export function runProcess(cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(opts.logFile, { flags: "a" });
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: mergeEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;

    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;

    child.stdout.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stdout += s;
      log.write(s);
      if (opts.onLine) {
        pending += s;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) opts.onLine(l);
      }
    });
    child.stderr.on("data", (buf: Buffer) => {
      const s = buf.toString();
      stderr += s;
      log.write(s);
    });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      log.end();
      reject(new Error(`failed to start "${cmd}": ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      log.end(() => resolve({ exitCode: code, stdout, stderr, timedOut, aborted }));
    });

    child.stdin.on("error", () => {}); // process may exit before reading stdin
    child.stdin.end(opts.stdin ?? "");
  });
}
