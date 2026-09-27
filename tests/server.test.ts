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

  it("drafts a flow via claude", async () => {
    // The fake claude echoes the prompt; not valid YAML, so we expect a validation error, not a crash.
    const r = (await (await json("POST", "/api/generate", { request: "tests then fix" })).json()) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});
