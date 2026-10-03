import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyRedactor } from "../src/credentials/redact.js";
import { runProcess } from "../src/steps/process.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "process-log-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = (script: string, logFile: string) => runProcess(process.execPath, ["-e", script], { cwd: tmp, logFile, redactor: emptyRedactor });

describe("the log file of a process", () => {
  it("holds the output of a process that ran", async () => {
    const log = join(tmp, "l.log");
    const r = await run('console.log("hello")', log);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("hello\n");
  });

  it("fails the step, and stops the process, when the log cannot be written", async () => {
    const started = Date.now();
    await expect(run("setTimeout(() => {}, 30000)", join(tmp, "missing-folder", "l.log"))).rejects.toThrow(/could not write the log file/);
    expect(Date.now() - started).toBeLessThan(10000);
  });
});
