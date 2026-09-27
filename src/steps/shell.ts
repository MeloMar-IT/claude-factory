import { runProcess } from "./process.js";

const MAX_OUTPUT = 20_000;

export interface ShellRunResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  error?: string;
}

export async function runShell(o: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  timeoutMs?: number;
}): Promise<ShellRunResult> {
  const res = await runProcess("/bin/sh", ["-c", o.command], {
    cwd: o.cwd,
    env: o.env,
    timeoutMs: o.timeoutMs,
    logFile: o.logFile,
  });
  // Keep the tail: that's where test failures and stack traces usually are.
  const output = (res.stdout + res.stderr).slice(-MAX_OUTPUT);
  if (res.timedOut) return { ok: false, output, exitCode: res.exitCode, error: "timed out" };
  return {
    ok: res.exitCode === 0,
    output,
    exitCode: res.exitCode,
    error: res.exitCode === 0 ? undefined : `exit code ${res.exitCode}`,
  };
}
