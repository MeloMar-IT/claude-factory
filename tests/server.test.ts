import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let close: () => void;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "factory-srv-"));
  process.env.FACTORY_HOME = join(tmp, "home"); // read at import time, so import afterwards
  const { startServer } = await import("../src/server/server.js");
  ({ close } = await startServer({
    repo: join(tmp),
    runsDir: join(tmp, "runs"),
    port,
    claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
  }));
});
afterAll(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

const FLOW = `name: mine
workspace: inplace
steps:
  - {id: hello, type: shell, run: "echo hi from $FACTORY_TASK"}
`;

describe("ui server", () => {
  it("serves the UI and the yaml browser build", async () => {
    expect((await fetch(base + "/")).headers.get("content-type")).toContain("text/html");
    expect((await fetch(base + "/vendor/yaml/index.js")).status).toBe(200);
    expect((await fetch(base + "/../package.json")).status).toBe(404);
  });

  it("rejects foreign origins", async () => {
    const r = await fetch(base + "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(r.status).toBe(403);
  });

  it("requires JSON bodies", async () => {
    const r = await fetch(base + "/api/validate", { method: "POST", body: "yaml=x" });
    expect(r.status).toBe(415);
  });

  it("validates, saves, lists and deletes flows", async () => {
    expect(await (await json("POST", "/api/validate", { yaml: "name: x\nsteps: []" })).json()).toMatchObject({ ok: false });
    expect((await json("PUT", "/api/flows/other", { yaml: FLOW, scope: "repo" })).status).toBe(400); // name mismatch
    expect((await json("PUT", "/api/flows/mine", { yaml: FLOW, scope: "repo" })).status).toBe(200);
    const flows = (await (await json("GET", "/api/flows")).json()) as Array<{ name: string; scope: string }>;
    expect(flows.find((f) => f.name === "mine")?.scope).toBe("repo");
    expect(flows.find((f) => f.name === "feature")?.scope).toBe("builtin");
    expect((await json("DELETE", "/api/flows/feature")).status).toBe(403);
    expect((await json("DELETE", "/api/flows/mine")).status).toBe(200);
  });

  it("starts a run and streams its log over SSE", async () => {
    const r = await json("POST", "/api/runs", { yaml: FLOW, task: "tests" });
    expect(r.status).toBe(201);
    const { runId } = (await r.json()) as { runId: string };

    const res = await fetch(`${base}/api/runs/${runId}/events`);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"status":"succeeded"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain("event: log");
    expect(text).toContain('"status":"succeeded"');

    const summary = (await (await json("GET", `/api/runs/${runId}`)).json()) as { history: Array<{ output: string }> };
    expect(summary.history[0]!.output).toContain("hi from tests");
    const list = (await (await json("GET", "/api/runs")).json()) as Array<{ runId: string }>;
    expect(list[0]!.runId).toBe(runId);
  });

  const waitFor = async (runId: string, status: string) => {
    for (let i = 0; i < 100; i++) {
      const r = (await (await json("GET", `/api/runs/${runId}`)).json()) as { status: string };
      if (r.status === status) return r;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    throw new Error(`run ${runId} never reached ${status}`);
  };

  it("approves a waiting run, and serves transcripts, diffs and stats", async () => {
    const flow = `name: gated
workspace: inplace
steps:
  - {id: talk, type: claude, prompt: "WRITE note.txt hi"}
  - {id: gate, type: approval, message: "ok?"}
  - {id: after, type: shell, run: echo after}
`;
    const { runId } = (await (await json("POST", "/api/runs", { yaml: flow, task: "t" })).json()) as { runId: string };
    await waitFor(runId, "waiting");
    expect((await json("POST", `/api/runs/${runId}/resume`, {})).status).toBe(202); // queued; the run refuses without a decision
    await waitFor(runId, "waiting");
    expect((await json("POST", `/api/runs/${runId}/approve`, { note: "go" })).status).toBe(202);
    const done = (await waitFor(runId, "succeeded")) as unknown as { history: { id: string; output: string }[] };
    expect(done.history.map((h) => h.id)).toEqual(["talk", "gate", "after"]);
    expect(done.history[1]!.output).toBe("approved by ui: go");

    const t = (await (await json("GET", `/api/runs/${runId}/transcript/0`)).json()) as { events: { kind: string; name?: string }[] };
    expect(t.events.some((e) => e.kind === "tool" && e.name === "Write")).toBe(true);
    expect(t.events.at(-1)!.kind).toBe("result");

    const diff = (await (await json("GET", `/api/runs/${runId}/diff`)).json()) as { patch: string };
    expect(diff.patch).toBe(""); // not a git repo

    const stats = (await (await json("GET", "/api/stats")).json()) as { totals: { runs: number }; byFlow: { flow: string }[] };
    expect(stats.totals.runs).toBeGreaterThanOrEqual(2);
    expect(stats.byFlow.map((f) => f.flow)).toContain("gated");
  });

  it("reads and validates config", async () => {
    const cfg = (await (await json("GET", "/api/config")).json()) as { concurrency: number };
    expect(cfg.concurrency).toBe(2);
    expect((await json("PUT", "/api/config", { concurrency: 0 })).status).toBe(400);
    const saved = (await (await json("PUT", "/api/config", { ...cfg, daily_budget_usd: 5, notify: { macos: false } })).json()) as { daily_budget_usd: number };
    expect(saved.daily_budget_usd).toBe(5);
    const info = (await (await json("GET", "/api/info")).json()) as { dailyBudget: number };
    expect(info.dailyBudget).toBe(5);
  });

  it("drafts a flow via claude", async () => {
    // The fake claude echoes the prompt; not valid YAML, so we expect a validation error, not a crash.
    const r = (await (await json("POST", "/api/generate", { request: "tests then fix" })).json()) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});
