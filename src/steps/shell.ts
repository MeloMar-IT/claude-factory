import { runProcess } from "./process.js";

const MAX_OUTPUT = 20_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Colour codes break output matching and are noise in Claude prompts. */
const NO_COLOR_ENV = { NO_COLOR: "1", FORCE_COLOR: undefined, CLICOLOR_FORCE: undefined };

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
  signal?: AbortSignal;
}): Promise<ShellRunResult> {
  const res = await runProcess("/bin/sh", ["-c", o.command], {
    cwd: o.cwd,
    env: { ...NO_COLOR_ENV, ...o.env },
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    logFile: o.logFile,
  });
  // Keep the tail: that's where test failures and stack traces usually are.
  const output = (res.stdout + res.stderr).replace(ANSI, "").slice(-MAX_OUTPUT);
  if (res.aborted) return { ok: false, output, exitCode: res.exitCode, error: "cancelled" };
  if (res.timedOut) return { ok: false, output, exitCode: res.exitCode, error: "timed out" };
  return {
    ok: res.exitCode === 0,
    output,
    exitCode: res.exitCode,
    error: res.exitCode === 0 ? undefined : `exit code ${res.exitCode}`,
  };
}
