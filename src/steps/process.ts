import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  logFile: string;
  /** Called with each complete stdout line. */
  onLine?: (line: string) => void;
}

/** Spawn a process, tee stdout/stderr into a log file, and collect output. */
export function runProcess(cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(opts.logFile, { flags: "a" });
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
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

    child.on("error", (err) => {
      clearTimeout(timer);
      log.end();
      reject(new Error(`failed to start "${cmd}": ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      log.end(() => resolve({ exitCode: code, stdout, stderr, timedOut }));
    });

    child.stdin.on("error", () => {}); // process may exit before reading stdin
    child.stdin.end(opts.stdin ?? "");
  });
}
