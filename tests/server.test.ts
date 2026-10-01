import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let close: () => void;
let ctx: import("../src/server/server.js").ApiContext;

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
    expect((await fetch(base + "/api/your-turn/dismiss", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
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

    const res = await fetch(`${base}/api/runs/${b.runId}/events`);
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
    const res = await fetch(`${base}/api/runs/${runId}/events`);
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

  it("watchers carry their records", async () => {
    const { nextStep } = await import("../src/next-step.js");
    const { toHold } = await import("../src/queue/watcher.js");
    const withError = { id: "a", lastActions: [], lastError: "gh down", holds: [toHold(nextStep("questions", { repo: "acme/app", issue: 3, title: "three" }, { watched: true, questions: 2 }))] };
    const clean = { id: "b", lastActions: [] };
    const cfg = { source: "issues", flow: "f", label: "l", every: "5m", max_per_tick: 1, enabled: true, vars: {} };
    const original = ctx.watchers.statuses;
    ctx.watchers.statuses = (() => [{ ...cfg, id: "a", github_repo: "acme/app", status: withError }, { ...cfg, id: "b", github_repo: "acme/app", status: clean }, { ...cfg, id: "c", github_repo: "acme/app", enabled: false }]) as never;
    try {
      const list = (await (await json("GET", "/api/watchers")).json()) as { status: { next?: { kind: string; who: string; where: { url: string } }; holds?: { next: { kind: string } }[] } }[];
      expect(list[0]!.status.next).toMatchObject({ kind: "watcher_error", who: "Something is wrong", where: { url: "#/watchers" } });
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
    expect(watcherProblem({ ...(w as object), every: "soon" } as never, { id: "a", lastActions: [] }, now)?.why).toMatch(/invalid interval/);
  });

  it("the UI shows the record and has no reason wording of its own", async () => {
    const text = async (p: string) => {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      return r.text();
    };
    const [next, dashboard, admin, runs, api, css] = await Promise.all(["/next.js", "/dashboard.js", "/admin.js", "/runs.js", "/api.js", "/style.css"].map(text));
    expect(next).toContain("What happens next");
    for (const js of [dashboard, admin, runs]) expect(js).toContain("./next.js");
    expect(api).toContain("/api/next");
    for (const w of ["Waiting for approval", "waiting for a free slot", "the run on the same ticket", "the coding run on", "Task / reason"]) expect(runs).not.toContain(w);
    expect(runs).not.toMatch(/status bad[^\n]*s\.reason|s\.reason[^\n]*status bad/);
    expect(runs).toContain("Reason");
    expect(runs).toContain("s.reason");
    expect(runs).toContain("nextBlock(");
    for (const w of ["waiting for approval", "why issues aren't", "x.reason", "holdList"]) expect(dashboard).not.toContain(w);
    for (const w of ["holdList", "Waiting:"]) expect(admin).not.toContain(w);
    expect(admin).not.toMatch(/errors[^\n]*lastError/);
    expect(admin).toContain("Error details");
    for (const js of [dashboard, admin, runs, api]) expect(js).not.toMatch(/nothing to do|waits for|a free slot|same ticket/i);
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

  it("drafts a flow via claude", async () => {
    // The fake claude echoes the prompt; not valid YAML, so we expect a validation error, not a crash.
    const r = (await (await json("POST", "/api/generate", { request: "tests then fix" })).json()) as { error?: string };
    expect(r.error).toBeTruthy();
  });
});
