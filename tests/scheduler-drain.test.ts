import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type Job } from "../src/queue/scheduler.js";

const SLOW = `name: slow\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "sleep 0.6"}\n`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("Scheduler.drain", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("lets the active run finish, starts nothing queued or newly submitted, and keeps the queue for the next server", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drain-"));
    dirs.push(tmp);
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const queueFile = join(tmp, "queue.json");
    const config = () => ({ ...ConfigSchema.parse({}), concurrency: 1 });
    const job = (): Job => ({ kind: "run", flow: parseFlow(SLOW), task: "t", repo, vars: {} });
    const s = new Scheduler({ runsDir: join(tmp, "runs"), queueFile, config });
    s.submit(job(), { source: "ui" });
    const queued = s.submit(job(), { source: "ui" });
    expect(s.queue().active).toHaveLength(1);
    expect(s.queue().pending.map((p) => p.runId)).toEqual([queued]);

    s.drain();
    expect(s.draining).toBe(true);
    const late = s.submit(job(), { source: "ui" }); // an API submission during the drain
    for (let i = 0; i < 200 && s.queue().active.length; i++) await sleep(50);
    await sleep(300);
    expect(s.queue().active).toHaveLength(0);
    expect(s.queue().pending.map((p) => p.runId)).toEqual([queued, late]);
    expect(JSON.parse(readFileSync(queueFile, "utf8")).map((q: { runId: string }) => q.runId)).toEqual([queued, late]);

    const next = new Scheduler({ runsDir: join(tmp, "runs"), queueFile, config });
    await sleep(100);
    expect(next.queue().active.map((a) => a.runId)).toEqual([queued]);
    expect(next.queue().pending.map((p) => p.runId)).toEqual([late]);
  });
});
