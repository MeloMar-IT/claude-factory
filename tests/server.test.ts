import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let close: () => void;
let ctx: import("../src/server/server.js").ApiContext;
let session: TestSession;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "factory-srv-"));
  process.env.FACTORY_HOME = join(tmp, "home"); // read at import time, so import afterwards
  const { startServer } = await import("../src/server/server.js");
  ({ close, ctx } = await startServer({
    repo: join(tmp),
    runsDir: join(tmp, "runs"),
    port,
    claudeBin: resolve("tests/fixtures/fake-claude.mjs"),
  }));
  session = await signInAs(base);
});
afterAll(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...session.headers(method) },
    body: body ? JSON.stringify(body) : undefined,
  });

const FLOW = `name: mine
workspace: inplace
steps:
  - {id: hello, type: shell, run: "echo hi from $FACTORY_TASK"}
`;

describe("readiness probe", () => {
  it("answers this machine without a session, and nothing else without one", async () => {
    const ready = await fetch(`${base}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ok: true });
    expect((await fetch(`${base}/api/ready`, { headers: { "x-forwarded-for": "203.0.113.5" } })).status).not.toBe(200);
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
  });
});

describe("ui server", () => {
  it("won't delete a flow a watcher uses (also a disabled one) or another flow runs; does once nothing uses it", async () => {
    const used = FLOW.replace("name: mine", "name: used-by-watcher");
    const parent = `name: parent\nworkspace: inplace\nsteps:\n  - {id: sub, type: flow, flow: used-by-step}\n`;
    for (const [n, y] of [["used-by-watcher", used], ["used-by-step", FLOW.replace("name: mine", "name: used-by-step")], ["parent", parent]] as const) {
      expect((await json("PUT", `/api/flows/${n}`, { yaml: y, scope: "repo" })).status).toBe(200);
    }
    const cfg = (await (await json("GET", "/api/config")).json()) as { watchers: unknown[] };
    const watcher = { id: "off", enabled: false, github_repo: "acme/app", label: "x", flow: "used-by-watcher" };
    expect((await json("PUT", "/api/config", { ...cfg, watchers: [watcher] })).status).toBe(200);

    const refused = await json("DELETE", "/api/flows/used-by-watcher");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain('flow "used-by-watcher" is in use by watcher off (disabled)');
    const step = await json("DELETE", "/api/flows/used-by-step");
    expect(step.status).toBe(409);
    expect(((await step.json()) as { error: string }).error).toContain("flow parent (runs it as a step)");

    expect((await json("PUT", "/api/config", { ...cfg, watchers: [] })).status).toBe(200);
    expect((await json("DELETE", "/api/flows/used-by-watcher")).status).toBe(200);
    expect((await json("DELETE", "/api/flows/parent")).status).toBe(200);
    expect((await json("DELETE", "/api/flows/used-by-step")).status).toBe(200);
  });

  it("won't delete refine-brief: refinement uses it", async () => {
    expect((await json("DELETE", "/api/flows/refine-brief")).status).toBe(403);
    for (const scope of ["repo", "global"]) {
      const put = await json("PUT", "/api/flows/refine-brief", { yaml: readFileSync("flows/refine-brief.yaml", "utf8"), scope });
      expect(put.status).toBe(200);
      const { path } = (await put.json()) as { path: string };
      const del = await json("DELETE", "/api/flows/refine-brief");
      expect(del.status).toBe(409);
      expect(((await del.json()) as { error: string }).error).toContain('flow "refine-brief" is in use by refinement (the architect)');
      expect(existsSync(path)).toBe(true);
      rmSync(path); // so other tests see the built-in flow again
    }
  });

  it("runs a monitor watcher: listed as active, Check now writes the findings file, a second monitor is refused", async () => {
    const cfg = (await (await json("GET", "/api/config")).json()) as { watchers: unknown[] };
    const mon = { id: "mon", source: "monitor", every: "1h" };
    expect((await json("PUT", "/api/config", { ...cfg, watchers: [mon] })).status).toBe(200);
    const list = (await (await json("GET", "/api/watchers")).json()) as { id: string; state: { name: string }; status?: { id: string } }[];
    expect(list.find((w) => w.id === "mon")).toMatchObject({ state: { name: "active" }, status: { id: "mon" } });
    expect((await json("POST", "/api/watchers/mon/tick", {})).status).toBe(200);
    expect(existsSync(join(tmp, "home", "monitor-findings.json"))).toBe(true);
    expect((await json("PUT", "/api/config", { ...cfg, watchers: [mon, { ...mon, id: "mon2" }] })).status).toBe(400);
    expect((await json("PUT", "/api/config", { ...cfg, watchers: [] })).status).toBe(200);
  });

  describe("the monitor's off switch", () => {
    const home = () => join(tmp, "home");
    const logLines = () => (existsSync(join(home(), "monitor-log.jsonl")) ? readFileSync(join(home(), "monitor-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; by?: string }) : []);
    const get = async () => (await json("GET", "/api/monitor")).json() as Promise<Record<string, unknown>>;
    const activity = async () => {
      const list = (await (await json("GET", "/api/watchers")).json()) as { id: string; status?: { lastActions: string[] } }[];
      return list.find((w) => w.id === "mon")?.status?.lastActions ?? [];
    };
    beforeAll(() => {
      rmSync(join(home(), "monitor-guard.json"), { force: true });
      rmSync(join(home(), "monitor-log.jsonl"), { force: true });
    });

    it("GET says quiet with `until` just after the start", async () => {
      expect(await get()).toMatchObject({ state: "quiet", reportTo: false });
      expect(typeof (await get()).until).toBe("string");
    });

    it("off and on set the state with the account id, log once, show in the activity, and a second one changes nothing", async () => {
      const cfg = (await (await json("GET", "/api/config")).json()) as { watchers: unknown[] };
      expect((await json("PUT", "/api/config", { ...cfg, watchers: [{ id: "mon", source: "monitor", every: "1h" }] })).status).toBe(200);
      const off = await json("POST", "/api/monitor/off", {});
      expect(off.status).toBe(200);
      expect(await off.json()).toMatchObject({ state: "off", by: session.user.id, changed: true });
      expect(JSON.parse(readFileSync(join(home(), "monitor-guard.json"), "utf8")).off.by).toBe(session.user.id);
      expect(logLines()).toMatchObject([{ event: "off", by: session.user.id }]);
      expect((await activity())[0]).toContain("bug stories switched off");
      expect(await (await json("POST", "/api/monitor/off", {})).json()).toMatchObject({ state: "off", changed: false });
      expect(logLines()).toHaveLength(1);
      expect(await activity()).toHaveLength(1);
      expect(await (await json("POST", "/api/monitor/on", {})).json()).toMatchObject({ state: "quiet", changed: true });
      expect(logLines().map((l) => l.event)).toEqual(["off", "on"]);
      expect((await activity())[0]).toContain("bug stories switched on");
      expect((await json("PUT", "/api/config", { ...cfg, watchers: [] })).status).toBe(200);
    });

    it("a broken file reads as unreadable; on resets it and keeps .broken", async () => {
      writeFileSync(join(home(), "monitor-guard.json"), "{nope");
      expect(await get()).toMatchObject({ state: "unreadable" });
      const on = (await (await json("POST", "/api/monitor/on", {})).json()) as { reset?: string };
      expect(typeof on.reset).toBe("string");
      expect(existsSync(join(home(), "monitor-guard.json.broken"))).toBe(true);
    });

    it("a POST without the CSRF token is refused", async () => {
      const r = await fetch(base + "/api/monitor/off", { method: "POST", headers: { cookie: session.cookie, "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(403);
    });
  });

  it("serves the UI and the yaml browser build", async () => {
    expect((await fetch(base + "/")).headers.get("content-type")).toContain("text/html");
    expect((await fetch(base + "/vendor/yaml/index.js")).status).toBe(200);
    expect((await fetch(base + "/../package.json")).status).toBe(404);
  });

  it("shows the product name", async () => {
    const text = (p: string) => fetch(base + p).then((r) => r.text());
    const html = await text("/");
    expect(html).toContain("<title>Spaghetti Code Foundry</title>");
    expect(html).toContain('<span class="brand-full">Spaghetti Code Foundry</span><span class="brand-short">Foundry</span>');
    expect(html).not.toContain("claude-factory");
    const css = await text("/style.css");
    expect(css).toContain(".brand-short { display: none; }");
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.brand-full \{ display: none; \}[^@]*\.brand-short \{ display: inline; \}/);
    const app = await text("/app.js");
    expect(app).toContain("Welcome to Spaghetti Code Foundry");
    expect(app).toContain("Build your own coding flows: pick a flow on the left,");
    const admin = await text("/admin.js");
    expect(admin).toContain("Review comments on Foundry PRs");
    expect(admin).toContain('label: "claude-factory"');
    expect(admin).toContain('placeholder: "claude-factory[bot]"');
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
    const r = await fetch(base + "/api/validate", { method: "POST", headers: session.headers("POST"), body: "yaml=x" });
    expect(r.status).toBe(415);
  });

  it("validates, saves, lists and deletes flows", async () => {
    expect(await (await json("POST", "/api/validate", { yaml: "name: x\nsteps: []" })).json()).toMatchObject({ ok: false });
    expect((await json("PUT", "/api/flows/other", { yaml: FLOW, scope: "repo" })).status).toBe(400); // name mismatch
    expect((await json("PUT", "/api/flows/mine", { yaml: FLOW, scope: "repo" })).status).toBe(200);
    const flows = (await (await json("GET", "/api/flows")).json()) as Array<{ name: string; scope: string }>;
    expect(flows.find((f) => f.name === "mine")?.scope).toBe("repo");
    expect(flows.find((f) => f.name === "issue-gitflow")?.scope).toBe("builtin");
    expect((await json("DELETE", "/api/flows/issue-gitflow")).status).toBe(403);
    expect((await json("DELETE", "/api/flows/mine")).status).toBe(200);
  });

  it("starts a run and streams its log over SSE", async () => {
    const r = await json("POST", "/api/runs", { yaml: FLOW, task: "tests" });
    expect(r.status).toBe(201);
    const { runId } = (await r.json()) as { runId: string };

    const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: session.headers() });
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

  it("a failed run keeps the raw reason and carries the plain record", async () => {
    const flow = "name: boom\nworkspace: inplace\nsteps:\n  - {id: boom, type: shell, run: exit 3}\n";
    const { runId } = (await (await json("POST", "/api/runs", { yaml: flow, task: "t" })).json()) as { runId: string };
    await waitFor(runId, "failed");
    const r = (await (await json("GET", `/api/runs/${runId}`)).json()) as { reason: string; next: { why: string } };
    expect(r.reason).toBe('step "boom" failed: exit code 3');
    expect(r.next.why).toBe("The step boom failed: its command ended with an error");
  });

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

  it("gives every run its next step, the same on the list and the run endpoint", async () => {
    const flow = `name: gated2
workspace: inplace
steps:
  - {id: gate, type: approval, message: "ok?"}
`;
    const { runId } = (await (await json("POST", "/api/runs", { yaml: flow, task: "t" })).json()) as { runId: string };
    await waitFor(runId, "waiting");
    type Next = { kind: string; who: string; text: string; where: { url: string } };
    const one = (await (await json("GET", `/api/runs/${runId}`)).json()) as { next: Next };
    const list = (await (await json("GET", "/api/runs")).json()) as { runId: string; next: Next }[];
    const item = list.find((r) => r.runId === runId)!;
    expect(one.next).toMatchObject({ kind: "approval", who: "You", where: { url: `#/runs/${runId}` } });
    expect(item.next.text).toBe(one.next.text);
    const all = (await (await json("GET", "/api/next")).json()) as { runs: (Next & { runId: string })[]; server: unknown[] };
    expect(all.runs.find((r) => r.runId === runId)!.text).toBe(one.next.text);
    expect(one.next).toMatchObject({ status: "waiting for you — approval", help: expect.any(String) });
    expect(item.next).toMatchObject({ status: "waiting for you — approval", help: expect.any(String) });
    expect(all.runs.find((r) => r.runId === runId)).toMatchObject({ status: "waiting for you — approval" });
    expect(all.server).toEqual([]);
    expect(list.every((r) => r.next)).toBe(true);
  });

  it("lists a run that waits for approval on Your turn, and Dismiss and Show again work", async () => {
    const flow = `name: gated3
workspace: inplace
steps:
  - {id: gate, type: approval, message: "ok?"}
  - {id: after, type: shell, run: echo after}
`;
    type Item = { key: string; next: { kind: string; where: { url: string } }; since: string; dismissable: boolean };
    type Turn = { count: number; dismissed: number; groups: { items: Item[] }[]; empty?: string };
    const turn = async () => (await (await json("GET", "/api/your-turn")).json()) as Turn;
    const { runId } = (await (await json("POST", "/api/runs", { yaml: flow, task: "t" })).json()) as { runId: string };
    expect(((await (await json("GET", `/api/runs/${runId}`)).json()) as { source?: string }).source).toBe("ui");
    await waitFor(runId, "waiting");
    const mine = (t: Turn) => t.groups.flatMap((g) => g.items).find((i) => i.key.endsWith(`|approval|${runId}`));
    const item = mine(await turn())!;
    expect(item.next).toMatchObject({ kind: "approval", where: { url: `#/runs/${runId}` } });
    expect(Number.isNaN(Date.parse(item.since))).toBe(false);

    const dismiss = (key?: string) => json("POST", "/api/your-turn/dismiss", key === undefined ? {} : { key });
    expect((await dismiss()).status).toBe(400);
    expect((await dismiss("no such key")).status).toBe(404);
    expect((await fetch(base + "/api/your-turn/dismiss", { method: "POST", headers: session.headers("POST", { "content-type": "text/plain" }), body: "x" })).status).toBe(415);
    const res = await dismiss(item.key);
    expect(res.status).toBe(200);
    const after = (await res.json()) as Turn;
    expect(mine(after)).toBeUndefined();
    expect(after.dismissed).toBeGreaterThanOrEqual(1);
    expect(mine(await turn())).toBeUndefined();
    const home = join(tmp, "home");
    expect(existsSync(join(home, "your-turn.json"))).toBe(true);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    expect((await json("POST", "/api/your-turn/restore", {})).status).toBe(200);
    expect(mine(await turn())).toBeDefined();
    await json("POST", `/api/runs/${runId}/approve`, {});
    await waitFor(runId, "succeeded");
    expect(mine(await turn())).toBeUndefined();
  });

  it("serves the Your turn page", async () => {
    const text = (p: string) => fetch(base + p).then((r) => r.text());
    const html = await text("/");
    expect(html).toContain('data-nav="your-turn"');
    expect(html).toContain('id="turn-badge"');
    expect(html).toContain("<title>Spaghetti Code Foundry</title>");
    expect((await fetch(base + "/turn.js")).status).toBe(200);
    expect((await fetch(base + "/turn-act.js")).status).toBe(200);
    expect((await json("GET", "/api/your-turn/detail?key=nope")).status).toBe(404);
    expect((await json("GET", "/api/your-turn/detail")).status).toBe(400);
    expect((await json("POST", "/api/your-turn/act", { key: "nope", action: "retry" })).status).toBe(404);
    expect((await json("POST", "/api/your-turn/act", { key: "nope", action: "explode" })).status).toBe(400);
    const app = await text("/app.js");
    for (const s of ["renderYourTurn", "startHash(", 'section === "your-turn"']) expect(app).toContain(s);
    expect(await text("/api.js")).toContain("/api/your-turn");
  });

  it("answers GET /api/since: a failed run shows once, a done story shows, a bad time is refused", async () => {
    const { fakeGithub } = await import("./helpers/fake-github.js");
    const gh = fakeGithub(); // the repositories of runs are asked for release pull requests
    try {
      const hour = () => encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
      type Since = { total: number; complete: boolean; notes: string[]; groups: { id: string; items: { where: { url: string }; issue?: number }[] }[] };
      const since = async (q = hour()) => (await (await json("GET", `/api/since?since=${q}`)).json()) as Since;
      expect((await json("GET", "/api/since")).status).toBe(400);
      expect((await json("GET", "/api/since?since=x")).status).toBe(400);

      const bad = `name: boom
workspace: inplace
steps:
  - {id: boom, type: shell, run: "exit 1"}
`;
      const { runId } = (await (await json("POST", "/api/runs", { yaml: bad, task: "t" })).json()) as { runId: string };
      await waitFor(runId, "failed");
      const s = await since();
      expect(s.groups.find((g) => g.id === "failed")!.items.map((i) => i.where.url)).toContain(`#/runs/${runId}`);
      expect(s.groups.find((g) => g.id === "waiting")?.items.map((i) => i.where.url) ?? []).not.toContain(`#/runs/${runId}`);
      expect(s).toMatchObject({ complete: true, notes: [] });

      const ok = `name: shipped
workspace: inplace
steps:
  - {id: commit, type: shell, run: "echo done"}
`;
      const vars = { github_repo: "acme/since-test", issue: "42" };
      const done = (await (await json("POST", "/api/runs", { yaml: ok, task: "s", vars })).json()) as { runId: string };
      await waitFor(done.runId, "succeeded");
      expect((await since()).groups.find((g) => g.id === "done")!.items.map((i) => i.issue)).toEqual([42]);

      expect((await since(encodeURIComponent(new Date(Date.now() + 60_000).toISOString()))).total).toBe(0);
    } finally {
      gh.restore();
    }
  });

  it("serves the Since you last looked strip", async () => {
    const text = (p: string) => fetch(base + p).then((r) => r.text());
    expect((await fetch(base + "/since.js")).status).toBe(200);
    expect(await text("/")).toContain('id="since"');
    expect(await text("/app.js")).toContain("startSince(");
    expect(await text("/api.js")).toContain("/api/since");
  });

  it("serves the board of stories, GET only", async () => {
    type Board = { repos: { repo: string; columns: { id: string; cards: { issue: number; runId?: string }[] }[] }[] };
    const { runId } = (await (await json("POST", "/api/runs", { yaml: FLOW, task: "t", vars: { github_repo: "acme/app", issue: "77" } })).json()) as { runId: string };
    await waitFor(runId, "succeeded");
    const res = await json("GET", "/api/board");
    expect(res.status).toBe(200);
    const board = (await res.json()) as Board;
    const cards = board.repos.find((r) => r.repo === "acme/app")!.columns.flatMap((c) => c.cards);
    expect(cards.find((c) => c.issue === 77)).toMatchObject({ issue: 77, runId });
    expect((await json("POST", "/api/board", {})).status).toBe(404);
  });

  it("serves the Board page", async () => {
    const text = (p: string) => fetch(base + p).then((r) => r.text());
    expect(await text("/")).toContain('data-nav="board"');
    expect((await fetch(base + "/board.js")).status).toBe(200);
    expect(await text("/app.js")).toContain('section === "board"');
    expect(await text("/api.js")).toContain("/api/board");
  });

  it("follows a queued run on the event stream and lists it before it has a run file", async () => {
    const slow = `name: slow
workspace: inplace
steps:
  - {id: wait, type: shell, run: "sleep 1"}
`;
    const vars = { github_repo: "acme/app", issue: "42" };
    const a = (await (await json("POST", "/api/runs", { yaml: slow, task: "a", vars })).json()) as { runId: string };
    const b = (await (await json("POST", "/api/runs", { yaml: slow, task: "b", vars })).json()) as { runId: string };
    const all = (await (await json("GET", "/api/next")).json()) as { runs: { runId: string; kind: string; where: { url: string } }[] };
    expect(all.runs.find((r) => r.runId === b.runId)).toMatchObject({ kind: "one_at_a_time", where: { url: `#/runs/${a.runId}` } });
    const queue = (await (await json("GET", "/api/queue")).json()) as { pending: { runId: string; next: unknown }[] };
    expect(queue.pending.find((p) => p.runId === b.runId)!.next).toMatchObject({ kind: "one_at_a_time", status: "waiting for another run", where: { url: `#/runs/${a.runId}` } });

    const res = await fetch(`${base}/api/runs/${b.runId}/events`, { headers: session.headers() });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"status":"succeeded"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    const kinds = [...text.matchAll(/"next":\{"kind":"(\w+)"/g)].map((m) => m[1]);
    expect(kinds).toContain("running");
    expect(kinds.at(-1)).toBe("done");
  });

  it("sends a new record on the event stream when a run starts waiting for a code area", async () => {
    const flow = `name: areas
workspace: inplace
steps:
  - {id: first, type: shell, run: "true"}
  - {id: claim_areas, type: shell, run: "echo 'waiting for run r9 (src)'; sleep 5"}
`;
    const { runId } = (await (await json("POST", "/api/runs", { yaml: flow, task: "t" })).json()) as { runId: string };
    const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: session.headers() });
    const reader = res.body!.getReader();
    let text = "";
    const stop = Date.now() + 15_000;
    while (!text.includes('"kind":"area_lock"') && Date.now() < stop) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    await json("POST", `/api/runs/${runId}/cancel`);
    expect(text).toContain('"kind":"area_lock"');
  });

  it("reports a server that waits to restart", async () => {
    ctx.restart = { why: "new_version", since: new Date().toISOString() };
    try {
      const all = (await (await json("GET", "/api/next")).json()) as { server: { kind: string; who: string }[] };
      expect(all.server).toMatchObject([{ kind: "restart", who: "Foundry" }]);
    } finally {
      ctx.restart = undefined;
    }
  });

  it("GET /api/health lists the problems of the server and the last check per repository", async () => {
    type H = { ok: boolean; summary: string; problems: { kind: string; why: string }[]; repos: { repo: string; lastOk?: string }[] };
    const lastOk = "2026-10-01T08:00:00.000Z";
    const cfg = { id: "a", github_repo: "acme/app", source: "issues", flow: "f", label: "l", every: "5m", max_per_tick: 1, enabled: true, vars: {} };
    const status = { id: "a", lastActions: [], lastError: "cannot access acme/app with gh: boom", lastOk };
    const original = { statuses: ctx.watchers.statuses, tracked: ctx.watchers.tracked };
    ctx.restart = { why: "new_version", since: new Date().toISOString() };
    ctx.watchers.statuses = (() => [{ ...cfg, status }]) as never;
    ctx.watchers.tracked = (() => [{ watcher: cfg, status, issues: [] }]) as never;
    try {
      const res = await json("GET", "/api/health");
      expect(res.status).toBe(200);
      const h = (await res.json()) as H;
      expect(h.ok).toBe(false);
      expect(h.summary).toMatch(/^\d+ problems?$/);
      expect(h.problems.find((p) => p.kind === "restart")?.why).toBe("A new version is waiting");
      expect(h.problems.find((p) => p.kind === "watcher_error")?.why).toContain("The watcher for acme/app can't reach GitHub");
      expect(h.repos).toEqual([{ repo: "acme/app", lastOk }]);
    } finally {
      ctx.restart = undefined;
      ctx.watchers.statuses = original.statuses;
      ctx.watchers.tracked = original.tracked;
    }
    const after = (await (await json("GET", "/api/health")).json()) as H;
    expect(after.problems.some((p) => p.kind === "restart" || p.kind === "watcher_error")).toBe(false);
    expect((await json("POST", "/api/health", {})).status).toBe(404);
    expect(((await (await json("GET", "/api/next")).json()) as { server: unknown[] }).server).toBeDefined();
  });

  it("watchers carry their records", async () => {
    const { nextStep } = await import("../src/next-step.js");
    const { toHold } = await import("../src/queue/watcher.js");
    const withError = { id: "a", lastActions: [], lastError: "cannot access acme/app with gh: boom", holds: [toHold(nextStep("questions", { repo: "acme/app", issue: 3, title: "three" }, { watched: true, questions: 2 }))] };
    const clean = { id: "b", lastActions: [] };
    const cfg = { source: "issues", flow: "f", label: "l", every: "5m", max_per_tick: 1, enabled: true, vars: {} };
    const original = ctx.watchers.statuses;
    ctx.watchers.statuses = (() => [{ ...cfg, id: "a", github_repo: "acme/app", status: withError }, { ...cfg, id: "b", github_repo: "acme/app", status: clean }, { ...cfg, id: "c", github_repo: "acme/app", enabled: false }]) as never;
    try {
      const list = (await (await json("GET", "/api/watchers")).json()) as { status: { next?: { kind: string; who: string; where: { url: string } }; holds?: { next: { kind: string } }[] } }[];
      expect(list[0]!.status.next).toMatchObject({ kind: "watcher_error", who: "Something is wrong", where: { url: "#/watchers" } });
      expect(list[0]!.status.next).toMatchObject({ why: expect.stringContaining("The watcher for acme/app can't reach GitHub") });
      expect((list[0]!.status as { lastError?: string }).lastError).toBe("cannot access acme/app with gh: boom");
      expect(list[0]!.status.holds![0]!.next.kind).toBe("questions");
      expect(list[0]!.status.next).toMatchObject({ status: "watcher error" });
      expect(list[0]!.status.holds![0]!.next).toMatchObject({ status: "waiting for you — questions" });
      expect(list[1]!.status.next).toBeUndefined();
      expect("next" in withError).toBe(false);
      const states = (list as unknown as { state: { name: string; status: string; help: string } }[]).map((w) => w.state);
      expect(states).toMatchObject([{ name: "error", status: "watcher error" }, { name: "active", status: "active" }, { name: "disabled", status: "disabled" }]);
      for (const st of states) expect(st.help).toMatch(/^[^.!?]+[.!?] [^.!?]+[.!?]$/);
      expect((list[2] as { status?: unknown }).status).toBeUndefined();
    } finally {
      ctx.watchers.statuses = original;
    }
  });

  it("a silent watcher shows a stale record, and only the error when it has one", async () => {
    const { watcherProblem } = await import("../src/server/next.js");
    const w = { source: "issues", flow: "f", label: "l", every: "5m", max_per_tick: 1, enabled: true, vars: {}, id: "a", github_repo: "acme/app" } as never;
    const now = Date.parse("2026-10-01T12:00:00Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    const every = 5 * 60_000;
    expect(watcherProblem(w, { id: "a", lastActions: [], lastTick: at(3 * every) }, now)).toBeUndefined();
    expect(watcherProblem(w, { id: "a", lastActions: [], lastTick: at(3 * every + 1) }, now)).toMatchObject({ kind: "watcher_stale", where: { url: "#/watchers" } });
    expect(watcherProblem(w, { id: "a", lastActions: [], startedAt: at(4 * every) }, now)?.kind).toBe("watcher_stale");
    expect(watcherProblem(w, { id: "a", lastActions: [], lastTick: at(9 * every), lastError: "x" }, now)?.kind).toBe("watcher_error");
    expect(watcherProblem({ ...(w as object), enabled: false } as never, { id: "a", lastActions: [], lastTick: at(9 * every) }, now)).toBeUndefined();
    expect(watcherProblem({ ...(w as object), every: "soon" } as never, { id: "a", lastActions: [] }, now)?.why).toMatch(/not a valid time/);
  });

  it("the UI shows the record and has no reason wording of its own", async () => {
    const text = async (p: string) => {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      return r.text();
    };
    const [next, dashboard, admin, runs, api, css, health, index, app] = await Promise.all(["/next.js", "/dashboard.js", "/admin.js", "/runs.js", "/api.js", "/style.css", "/health.js", "/", "/app.js"].map(text));
    expect(next).toContain("What happens next");
    for (const js of [dashboard, admin, runs, health]) expect(js).toContain("./next.js");
    expect(api).toContain("/api/next");
    expect(api).toContain("/api/health");
    expect(index).toContain('id="health"');
    expect(app).toContain("startHealth(");
    // "+ Blank flow" uses pushState, which fires no hashchange: it reloads the line itself.
    expect(app).toMatch(/pushState\(null, "", "#\/new"\);[\s\S]{0,80}loadHealth\(/);
    expect(dashboard).not.toContain("api.next(");
    expect(dashboard).not.toContain('"Server"');
    for (const w of ["Waiting for approval", "waiting for a free slot", "the run on the same ticket", "the coding run on", "Task / reason"]) expect(runs).not.toContain(w);
    expect(runs).not.toMatch(/status bad[^\n]*s\.reason|s\.reason[^\n]*status bad/);
    expect(runs).toContain("Details");
    expect(runs).toContain("detailsRow(");
    expect(runs).not.toContain("s.error.slice");
    expect(runs).toContain("s.reason");
    expect(runs).toContain("nextBlock(");
    for (const w of ["waiting for approval", "why issues aren't", "x.reason", "holdList"]) expect(dashboard).not.toContain(w);
    for (const w of ["holdList", "Waiting:"]) expect(admin).not.toContain(w);
    expect(admin).not.toMatch(/errors[^\n]*lastError/);
    expect(admin).toContain("Error details");
    // The notification hint in Settings says "something waits for you"; that is not a reason text.
    for (const js of [dashboard, (admin ?? "").replace("when something waits for you.", ""), runs, api, health]) expect(js).not.toMatch(/nothing to do|waits for|a free slot|same ticket/i);
    expect(css).not.toContain(".card.waiting");
    expect(runs).not.toContain("STATUS_LABEL");
    expect(runs).not.toContain('"Next step"');
    expect(runs).not.toMatch(/waiting for approval/);
    expect(runs).toContain("nextStatus(");
    expect(runs).toContain("STEP_TYPES");
    expect(admin).not.toMatch(/"(disabled|active)"/);
    expect(admin).toContain("watcherStateMark(");
    expect(next).toContain("helpMark");
    expect(next).not.toMatch(/mouseover|mouseenter|onMouse/);
    expect(css).toContain(".help-text[hidden]");
    expect(css).not.toMatch(/:hover[^{]*\.help-text/);
  });

  it("builds records from the watchers", async () => {
    const { allNext, areaWait } = await import("../src/server/next.js");
    const { ConfigSchema } = await import("../src/config.js");
    const { nextStep } = await import("../src/next-step.js");
    const cfg = ConfigSchema.parse({ watchers: [{ id: "a", github_repo: "acme/app" }, { id: "b", github_repo: "acme/app", label: "other" }] });
    const hold = { reason: "x", next: nextStep("questions", { repo: "acme/app", issue: 3, title: "three" }, { watched: true, questions: 2 }), issue: 3 };
    const prHold = { reason: "y", next: nextStep("release", { repo: "acme/app" }, { pr: { number: 9, url: "u" } }) };
    const tracked = [
      { watcher: cfg.watchers[0]!, status: { id: "a", lastActions: [], lastError: "gh down", holds: [hold, prHold] }, issues: [{ issue: 3, title: "three" }, { issue: 4, title: "four", done: true }] },
      { watcher: cfg.watchers[1]!, status: { id: "b", lastActions: [] }, issues: [{ issue: 4, title: "four" }] },
    ];
    const stub = {
      config: () => cfg,
      scheduler: { list: () => [], queue: () => ({ pending: [], active: [] }) },
      watchers: { tracked: () => tracked },
    } as unknown as import("../src/server/server.js").ApiContext;
    const out = allNext(stub);
    expect(out.watchers.map((n) => n.kind).sort()).toEqual(["release", "watcher_error"]);
    expect(out.watchers.find((n) => n.kind === "watcher_error")!.where.url).toBe("#/watchers");
    expect(out.issues).toHaveLength(2); // #4 is tracked by two watchers: one record, the one that is not done
    expect(out.issues.find((n) => n.issue === 3)!.text).toBe(hold.next.text);
    expect(out.issues.find((n) => n.issue === 4)!.kind).toBe("starting");

    stub.restart = { why: "data_folder", since: "x" };
    expect(allNext(stub).issues.find((n) => n.issue === 4)!.kind).toBe("restart");

    const dir = join(tmp, "arearun");
    mkdirSync(join(dir, "logs"), { recursive: true });
    const run = { status: "running", state: { next: "claim_areas" }, history: [], runDir: dir } as never;
    const log = join(dir, "logs", "001-claim_areas.log");
    writeFileSync(log, "waiting for run r1 (src)\n");
    expect(areaWait(run)).toEqual({ runId: "r1", areas: "src" });
    writeFileSync(log, "waiting for run r1 (src)\nLOCKED: src\n");
    expect(areaWait(run)).toBeUndefined();
    rmSync(log);
    expect(areaWait(run)).toBeUndefined();
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

  it("saves the notification settings and checks the times", async () => {
    const cfg = (await (await json("GET", "/api/config")).json()) as Record<string, unknown>;
    const notify = { macos: false, successes: true, throttle_minutes: 1, quiet_hours: { from: "22:00", to: "07:00" }, daily_summary_at: "09:00" };
    const saved = (await (await json("PUT", "/api/config", { ...cfg, notify })).json()) as { notify: typeof notify };
    expect(saved.notify).toMatchObject(notify);
    expect((await json("PUT", "/api/config", { ...cfg, notify: { daily_summary_at: "25:00" } })).status).toBe(400);
    expect((await json("PUT", "/api/config", { ...cfg, notify: { throttle_minutes: 0 } })).status).toBe(400);
    await json("PUT", "/api/config", { ...cfg, notify: { macos: false } });
  });

  it("tells whether a click can open the item (macOS only)", async () => {
    const info = (await (await json("GET", "/api/info")).json()) as Record<string, unknown>;
    if (process.platform === "darwin") expect(typeof info.clickThrough).toBe("boolean");
    else expect("clickThrough" in info).toBe(false);
  });

  it("drafts a flow via claude", async () => {
    // The fake claude echoes the prompt; not valid YAML, so we expect a validation error, not a crash.
    const r = (await (await json("POST", "/api/generate", { request: "tests then fix" })).json()) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});

describe("turn notifier wiring", () => {
  const start = async (home: string, runsDir: string, p: number) => {
    const { startServer } = await import("../src/server/server.js");
    return startServer({ repo: home, runsDir, port: p, watchers: false });
  };

  it("starts with the server, posts once to the webhook and stops on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-wire-"));
    const savedHome = process.env.FACTORY_HOME;
    const savedNo = process.env.FACTORY_NO_NOTIFY;
    const posts: string[] = [];
    const hook = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => (posts.push(b), res.end("ok")));
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    try {
      const home = join(dir, "home");
      process.env.FACTORY_HOME = home;
      delete process.env.FACTORY_NO_NOTIFY;
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "config.yaml"), `notify:\n  macos: false\n  slack_webhook: http://127.0.0.1:${(hook.address() as { port: number }).port}/hook\n`);
      const runDir = join(dir, "runs", "r9");
      mkdirSync(runDir, { recursive: true });
      const now = new Date().toISOString();
      writeFileSync(join(runDir, "run.json"), JSON.stringify({
        runId: "r9", flow: "t", flowDef: { steps: [] }, task: "t", vars: {}, repo: dir, status: "failed", reason: "boom", runDir, startedAt: now, finishedAt: now,
        source: "cli", history: [], state: { next: null, steps: {}, visits: {} }, totalCostUsd: 0,
      }));
      const server = await start(dir, join(dir, "runs"), 20000 + Math.floor(Math.random() * 20000));
      try {
        expect(server.notifier?.running).toBe(true);
        await server.notifier!.check();
        expect(posts).toHaveLength(1);
        expect(JSON.parse(posts[0]!).text).toContain("/#/runs/r9");
      } finally {
        server.close();
      }
      expect(server.notifier!.running).toBe(false);
    } finally {
      process.env.FACTORY_HOME = savedHome;
      if (savedNo !== undefined) process.env.FACTORY_NO_NOTIFY = savedNo;
      hook.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not started with FACTORY_NO_NOTIFY=1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-wire-"));
    const savedHome = process.env.FACTORY_HOME;
    const savedNo = process.env.FACTORY_NO_NOTIFY;
    try {
      process.env.FACTORY_HOME = join(dir, "home");
      process.env.FACTORY_NO_NOTIFY = "1";
      const server = await start(dir, join(dir, "runs"), 20000 + Math.floor(Math.random() * 20000));
      server.close();
      expect(server.notifier).toBeUndefined();
    } finally {
      process.env.FACTORY_HOME = savedHome;
      process.env.FACTORY_NO_NOTIFY = savedNo;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("expected times", () => {
  type Timing = { progress: string; stepId: string; estimate?: string; slow?: boolean; leftMs?: number };
  type Rec = { runId: string; status: string; next: { timing?: Timing; until?: string; afterRun?: string } };
  const start = async (yaml: string, body: Record<string, unknown> = {}) =>
    ((await (await json("POST", "/api/runs", { yaml, task: "t", ...body })).json()) as { runId: string }).runId;
  const get = async (id: string) => (await (await json("GET", `/api/runs/${id}`)).json()) as Rec;
  const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean) => {
    for (let i = 0; i < 150; i++) {
      const v = await read();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out");
  };
  const finished = (id: string) => until(() => get(id), (r) => r.status === "succeeded");
  const nap = "sleep \"${FACTORY_VAR_NAP:-0.2}\"";
  const timed = (extra = "", last = nap) => `name: timed
workspace: inplace
steps:
  - {id: a, type: shell, run: "sleep 0.2"}
  - {id: b, type: shell, run: '${last}'}
${extra}`;

  it("shows progress without history", async () => {
    const id = await start(`name: fresh_flow
workspace: inplace
steps:
  - {id: a, type: shell, run: "true"}
  - {id: b, type: shell, run: "sleep 5"}
`);
    const r = await until(() => get(id), (x) => x.next.timing?.stepId === "b");
    expect(r.next.timing!.progress).toBe("Step 2 of 2");
    expect(r.next.timing!.estimate).toBeUndefined();
    await json("POST", `/api/runs/${id}/cancel`);
  });

  it("estimates from history, on every endpoint", async () => {
    const { forgetHistory } = await import("../src/server/next.js");
    for (let i = 0; i < 3; i++) await finished(await start(timed()));
    forgetHistory(ctx);
    const id = await start(timed(), { vars: { nap: "5" } });
    const r = await until(() => get(id), (x) => x.next.timing?.stepId === "b");
    expect(r.next.timing!.estimate).toMatch(/^Estimate: about 1 min left \(usually about 1 min in total\)$/);
    expect(r.next.timing!.slow).toBeUndefined();

    const listed = async () => ((await (await json("GET", "/api/runs")).json()) as Rec[]).find((x) => x.runId === id)!;
    const viaNext = async () => ((await (await json("GET", "/api/next")).json()) as { runs: { runId: string; timing?: Timing }[] }).runs.find((x) => x.runId === id)!;
    for (const t of [(await listed()).next.timing, (await viaNext()).timing]) {
      expect(t!.progress).toBe(r.next.timing!.progress);
      expect(t!.estimate).toBe(r.next.timing!.estimate);
    }
    // The request order does not matter.
    forgetHistory(ctx);
    const first = (await listed()).next.timing!.estimate;
    forgetHistory(ctx);
    expect((await get(id)).next.timing!.estimate).toBe(first);
    forgetHistory(ctx);
    expect((await get(id)).next.timing!.estimate).toBe(first);
    expect((await listed()).next.timing!.estimate).toBe(first);

    const res = await fetch(`${base}/api/runs/${id}/events`, { headers: session.headers() });
    const reader = res.body!.getReader();
    let text = "";
    const stop = Date.now() + 10_000;
    while (!text.includes('"estimate":"Estimate:') && Date.now() < stop) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain('"estimate":"Estimate:');
    await json("POST", `/api/runs/${id}/cancel`);

    // Another step list is another history.
    const other = await start(timed(`  - {id: c, type: shell, run: "sleep 5"}`, "true"));
    const o = await until(() => get(other), (x) => x.next.timing?.stepId === "c");
    expect(o.next.timing!.progress).toBe("Step 3 of 3");
    expect(o.next.timing!.estimate).toBeUndefined();
    await json("POST", `/api/runs/${other}/cancel`);
  });

  it("sees a new sample as soon as a run succeeds, without forgetting by hand", async () => {
    const flow = (nap: string) => `name: crossing
workspace: inplace
steps:
  - {id: a, type: shell, run: "sleep 0.2"}
  - {id: b, type: shell, run: "sleep ${nap}"}
`;
    for (let i = 0; i < 2; i++) await finished(await start(flow("0.2")));
    const third = await start(flow("1"));
    const mid = await until(() => get(third), (x) => x.next.timing?.stepId === "b");
    expect(mid.next.timing!.estimate).toBeUndefined(); // two samples, now cached
    await finished(third);
    const fourth = await start(flow("5"));
    const r = await until(() => get(fourth), (x) => x.next.timing?.stepId === "b");
    expect(r.next.timing!.estimate).toMatch(/^Estimate:/);
    await json("POST", `/api/runs/${fourth}/cancel`);
  });

  it("tells a queued run how long the run in front still needs", async () => {
    const { forgetHistory } = await import("../src/server/next.js");
    const vars = { github_repo: "acme/app", issue: "77" };
    for (let i = 0; i < 3; i++) await finished(await start(timed(), { vars }));
    forgetHistory(ctx);
    const a = await start(timed(), { vars: { ...vars, nap: "5" } });
    const b = await start(timed(), { vars: { ...vars, nap: "5" } });
    await until(() => get(a), (x) => x.next.timing?.leftMs !== undefined);
    const queue = (await (await json("GET", "/api/queue")).json()) as { pending: { runId: string; next: Rec["next"] }[] };
    const next = queue.pending.find((p) => p.runId === b)!.next;
    expect(next.afterRun).toBe(a);
    expect(next.until).toBe("after that run (about 1 min left)");
    // A third run waits for the second one too: no time for it.
    const c = await start(timed(), { vars: { ...vars, nap: "5" } });
    const again = (await (await json("GET", "/api/queue")).json()) as { pending: { runId: string; next: Rec["next"] }[] };
    expect(again.pending.find((p) => p.runId === b)!.next.until).toBe("after that run (about 1 min left)");
    expect(again.pending.find((p) => p.runId === c)!.next.until).toBeUndefined();
    await json("POST", `/api/runs/${c}/cancel`);
    await json("POST", `/api/runs/${b}/cancel`);
    await json("POST", `/api/runs/${a}/cancel`);
  });

  describe("with a stub context", () => {
    const MIN = 60_000;
    const iso = (minAgo: number) => new Date(Date.now() - minAgo * MIN).toISOString();
    const rec = (id: string, min: number) => ({ id, type: "shell", ok: true, visit: 1, output: "", startedAt: iso(0), durationMs: min * MIN, logFile: "" });
    const flowDef = { name: "f", steps: ["a", "b", "c", "claim_areas"].map((id) => ({ id, type: "shell", run: "true" })) };
    const mk = (over: Record<string, unknown>) => ({ flow: "f", flowDef, vars: { github_repo: "acme/app" }, repo: "/x", runDir: "/tmp/none", totalCostUsd: 0, startedAt: iso(60), ...over });
    const past = [10, 10, 15, 25, 25].map((b, i) => mk({ runId: `h${i}`, status: "succeeded", history: [rec("a", 5), rec("b", b), rec("c", 10)], state: { next: null, steps: {}, visits: {} } }));
    const live = (runId: string, ago: number, over: Record<string, unknown> = {}) =>
      mk({ runId, status: "running", history: [rec("a", 5)], state: { next: "b", steps: {}, visits: {} }, stepStartedAt: iso(ago), ...over });
    type Ctx = import("../src/server/server.js").ApiContext;
    const setup = async (runs: Record<string, unknown>[], active: () => boolean = () => true) => {
      const { ConfigSchema } = await import("../src/config.js");
      const byId = new Map(runs.map((r) => [r.runId as string, r]));
      return {
        config: () => ConfigSchema.parse({}),
        scheduler: { list: () => [...past, ...runs], queue: () => ({ pending: [], active: [] }), isActive: (id: string) => active() && byId.has(id), get: (id: string) => byId.get(id) },
        watchers: { tracked: () => [], statuses: () => [] },
      } as unknown as Ctx;
    };
    const dep = async (blockers: { issue: number; runId?: string; kind?: "running" | "queued" }[]) => {
      const { nextStep } = await import("../src/next-step.js");
      return nextStep("dependency", { repo: "acme/app", issue: 89 }, {
        blockers: blockers.map((b) => ({ issue: b.issue, next: nextStep(b.kind ?? "running", { runId: b.runId }) })),
      });
    };
    const via = async (stub: Ctx, hold: unknown) => {
      const { watchersWithNext } = await import("../src/server/next.js");
      (stub.watchers as unknown as { statuses: () => unknown }).statuses = () => [{ id: "w", github_repo: "acme/app", status: { id: "w", lastActions: [], holds: [hold] } }];
      return watchersWithNext(stub)[0]!.status!.holds![0]!;
    };

    it("adds the time left to a dependency, using the longest blocker", async () => {
      const stub = await setup([live("r88", 5), live("r90", 15)]);
      const hold = { reason: "x", issue: 89, next: await dep([{ issue: 88, runId: "r88" }]) };
      expect((await via(stub, hold)).next.until).toBe("after #88 (about 20 min left)");
      expect(hold.next.until).toBe("after #88");
      const two = { reason: "x", issue: 89, next: await dep([{ issue: 88, runId: "r88" }, { issue: 90, runId: "r90" }]) };
      expect((await via(stub, two)).next.until).toBe("after #88, #90 (about 20 min left)");
    });

    it("leaves it alone without a full picture", async () => {
      const stub = await setup([live("r88", 5), live("r90", 15)]);
      const queued = { reason: "x", issue: 89, next: await dep([{ issue: 88, runId: "r88" }, { issue: 90, kind: "queued" }]) };
      expect((await via(stub, queued)).next.until).toBe("after #88, #90");
      const other = await setup([live("r88", 5), live("r90", 15, { flow: "g" })]);
      const two = { reason: "x", issue: 89, next: await dep([{ issue: 88, runId: "r88" }, { issue: 90, runId: "r90" }]) };
      expect((await via(other, two)).next.until).toBe("after #88, #90");
      const idle = await setup([live("r88", 5)], () => false);
      const one = { reason: "x", issue: 89, next: await dep([{ issue: 88, runId: "r88" }]) };
      expect((await via(idle, one)).next.until).toBe("after #88");
    });

    it("tells a run that waits for a code area how long the other run needs", async () => {
      const { nextFor } = await import("../src/server/next.js");
      const dir = join(tmp, "areatiming");
      mkdirSync(join(dir, "logs"), { recursive: true });
      writeFileSync(join(dir, "logs", "001-claim_areas.log"), "waiting for run r88 (src)\n");
      const waiting = live("r91", 1, { state: { next: "claim_areas", steps: {}, visits: {} }, history: [], runDir: dir });
      const stub = await setup([live("r88", 5), waiting]);
      const n = nextFor(stub)(waiting as never);
      expect(n).toMatchObject({ kind: "area_lock", afterRun: "r88", until: "after that run (about 20 min left)" });
      expect(n.timing!.progress).toBe("Step 4 of 4");
      expect(n.timing!.estimate).toBeUndefined();
      expect(n.timing!.slow).toBeUndefined();

      // The other run waits for a code area too: no estimate.
      const dir2 = join(tmp, "areatiming2");
      mkdirSync(join(dir2, "logs"), { recursive: true });
      writeFileSync(join(dir2, "logs", "001-claim_areas.log"), "waiting for run r1 (src)\n");
      const blocked = live("r88", 5, { state: { next: "claim_areas", steps: {}, visits: {} }, history: [], runDir: dir2 });
      const stub2 = await setup([blocked, waiting]);
      expect(nextFor(stub2)(waiting as never).until).toBeUndefined();
    });
  });

  it("shows when and how long in the UI code, without wording of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const ui = (f: string) => readFileSync(resolve("ui", f), "utf8");
    expect(ui("runs.js")).toContain("whenParts(");
    for (const f of ["runs.js", "dashboard.js", "admin.js"]) expect(ui(f)).not.toMatch(/usually|longer than usual|Estimate:|Continues/);
  });
});
