import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { nextStep } from "../src/next-step.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { USER_ERROR, hidePaths, movedText, userError, userLogLine, userRecord, userRun } from "../src/server/user-view.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const keys = (o: object) => Object.keys(o).sort();

describe("userRun", () => {
  const full = {
    runId: "r1", flow: "leaky", task: "do it in /work/dir", status: "waiting", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z",
    reason: "SECRET reason", repo: "/srv/repo", runDir: "/runs/r1", workdir: "/work/dir", baseSha: "abc", branch: "factory/r1", totalCostUsd: 1.23,
    pid: 5, source: "ui", owner: "u1", resumes: 1, stepStartedAt: "2026-01-01T00:00:30.000Z",
    vars: { github_repo: "acme/app", issue: "7", hidden: "SENTINEL_HIDDEN", fixed: "F", input: "I", unlisted: "U" },
    flowDef: {
      name: "leaky", description: "d", workspace: "worktree", defaults: { model: "opus", agent: "claude" }, limits: { max_cost_usd: 5 }, sandbox: {}, vars: { hidden: "h" },
      publish: { enabled: true, version: 3, vars: { hidden: { mode: "hidden" }, fixed: { mode: "fixed" }, input: { mode: "input" } } },
      steps: [{ id: "think", type: "claude", prompt: "SECRET prompt", model: "opus", description: "Thinks" }, { id: "sh", type: "shell", run: "echo SECRET" }],
    },
    history: [
      { id: "think", type: "claude", visit: 1, ok: true, output: "SECRET output", costUsd: 0.5, tokens: { input: 1, output: 2 }, agent: "claude:x:opus", sessionId: "s", startedAt: "2026-01-01T00:00:01.000Z", durationMs: 5, logFile: "/runs/r1/logs/0.log" },
      { id: "sh", type: "shell", visit: 1, ok: false, output: "SECRET shell", error: "exit code 1", exitCode: 1, denied: ["Bash: x"], startedAt: "2026-01-01T00:00:02.000Z", durationMs: 6, logFile: "/runs/r1/logs/1.log", parent: "p" },
    ],
    state: { next: "sh", steps: { think: { output: "SECRET" } }, visits: {} },
    waiting: { stepId: "g", message: "Go on in /work/dir?", since: "2026-01-01T00:00:40.000Z" },
    next: nextStep("approval", { repo: "/srv/repo", runId: "r1" }, { message: "Go on" }),
    superseded: true,
  } as unknown as RunSummary & { superseded: boolean };

  it("has exactly the fields a user may see, at every level", () => {
    const u = userRun(full);
    expect(keys(u)).toEqual(["branch", "finishedAt", "flow", "flowDef", "history", "next", "owner", "resumes", "runId", "startedAt", "state", "status", "superseded", "task", "vars", "waiting"]);
    expect(keys(u.flowDef)).toEqual(["name", "publish", "steps"]);
    expect(u.flowDef.publish).toEqual({ enabled: true, version: 3 });
    expect(u.flowDef.steps).toEqual([{ id: "think", type: "agent", description: "Thinks" }, { id: "sh", type: "shell" }]);
    expect(keys(u.history[0]!)).toEqual(["durationMs", "id", "ok", "startedAt", "type", "visit"]);
    expect(keys(u.history[1]!)).toEqual(["durationMs", "error", "id", "ok", "parent", "startedAt", "type", "visit"]);
    expect(u.history[0]!.type).toBe("agent");
    expect(u.history[1]!.error).toBe("Its command ended with an error");
    expect(u.state).toEqual({ next: "sh" });
    expect(keys(u.waiting!)).toEqual(["message", "since", "stepId"]);
    expect(JSON.stringify(u)).not.toMatch(/SECRET|opus|claude|cost|tokens|sessionId|logFile/i);
  });

  it("keeps fixed, input, github_repo and issue; drops hidden and unlisted variables", () => {
    expect(userRun(full).vars).toEqual({ github_repo: "acme/app", issue: "7", fixed: "F", input: "I" });
  });

  it("replaces the folders of the run in the free text", () => {
    const u = userRun(full);
    expect(u.task).toBe("do it in (folder)");
    expect(u.waiting!.message).toBe("Go on in (folder)?");
    expect(u.next!.repo).toBe("");
  });

  it("shows the questions of a run that stopped to ask them, from that step only", () => {
    const base = { ...full, status: "stopped", reason: 'stopped at step "ask_for_info"', waiting: undefined, history: [
      { id: "plan", type: "claude", visit: 1, ok: true, output: "SECRET plan", startedAt: "x", durationMs: 1 },
      { id: "ask_for_info", type: "shell", visit: 1, ok: true, output: "Q1. Which format in /work/dir?", startedAt: "x", durationMs: 1 },
    ] } as unknown as RunSummary;
    const u = userRun(base);
    expect(u.questions).toBe("Q1. Which format in (folder)?");
    expect(JSON.stringify(u)).not.toContain("SECRET");
    expect(userRun({ ...base, reason: 'stopped at step "other"' } as unknown as RunSummary).questions).toBeUndefined();
    expect(userRun({ ...base, status: "failed" } as unknown as RunSummary).questions).toBeUndefined();
  });

  it("does not throw on an old run without history, flow definition or state", () => {
    const u = userRun({ runId: "old", flow: "f", task: "", status: "succeeded", startedAt: "x", vars: {} } as unknown as RunSummary);
    expect(u).toMatchObject({ history: [], state: { next: null }, flowDef: { name: "f", steps: [] }, vars: {} });
  });
});

describe("userLogLine", () => {
  const rows: [string, string][] = [
    ["run r1 · flow walk · /work/dir (branch factory/r1)", "run r1 · flow walk (branch factory/r1)"],
    ["run r1 · flow walk · /work dir/x", "run r1 · flow walk"],
    ['↻ resuming run r1 at "gate" (approved)', '↻ resuming run r1 at "gate" (approved)'],
    ['↻ resuming run r1 at "gate"', '↻ resuming run r1 at "gate"'],
    ["▶ think (claude)", "▶ think (agent)"],
    ["▶ sub/sh (shell, visit 2)", "▶ sub/sh (shell, visit 2)"],
    ["✔ think (1.2s, $0.0100, 3k tok)", "✔ think (1.2s)"],
    ["✔ sh (0.1s)", "✔ sh (0.1s)"],
    ["✘ sh (0.1s) — exit code 1", "✘ sh (0.1s) — Its command ended with an error"],
    ["✘ think (2.0s, $0.1000) — claude result: error_max_budget_usd", "✘ think (2.0s) — The administrator's limit was reached"],
    ["  ⇉ running a, b in parallel", "  ⇉ running a, b in parallel"],
    ["⏸ waiting for approval: Go on?", "⏸ waiting for approval: Go on?"],
    ["    · Write: /work/dir/note.txt", "    · Write"],
    ["    · Bash: cat /etc/x --model opus", "    · Bash"],
    ["    · mcp__github__create_issue: x", "    · tool"],
    ["    · github.create_issue", "    · tool"],
    ["    ⚠ blocked: Bash: curl http://x", "    ⚠ blocked: Bash"],
    ["    ⚠ blocked: mcp__x__y: z", "    ⚠ blocked: tool"],
    ["✘ could not start: the run's workspace no longer exists", "✘ could not start: the run's workspace no longer exists"],
    ["✘ could not start: run r1 not found", "✘ could not start: run r1 not found"],
    ['✘ could not start: unknown step "x"', '✘ could not start: unknown step "x"'],
    ["✘ could not start: nothing to resume", "✘ could not start: nothing to resume"],
    ["✘ could not start: EACCES: permission denied, open '/secret/run.json'", `✘ could not start: ${USER_ERROR}`],
    ["first line\nsecond", "undefined"],
    ["▶ think (claude)\n    · Bash: cat /etc/x", "▶ think (agent)"],
  ];
  it.each(rows)("%j", (line, want) => {
    expect(String(userLogLine(line))).toBe(want);
  });

  it.each([
    "    · agent claude:anthropic:opus",
    "    · not resuming plan: it ran on codex, this step on claude",
    "⚠ daily budget reached — agent steps continue on ollama:x",
    "    ↪ claude:x hit a limit — retrying on codex:y",
    "    ⚠ build: not sandboxed (no sandbox.docker_image configured)",
    "⚠ something new",
    "  ↳ sub-flow x",
    "■ cancelled while waiting for approval",
    "",
  ])("drops %j", (line) => {
    expect(userLogLine(line)).toBeUndefined();
  });
});

describe("userError, userRecord, hidePaths, movedText", () => {
  it.each([
    ["cancelled", "It was cancelled"],
    ["output matched fail_if", "Its output did not pass the check of the step"],
    ["output did not match pass_if", "Its output did not pass the check of the step"],
    ["failed: build", "One of its steps failed"],
    ["usage limit reached: x", "The usage limit was reached"],
    ["signed out — the Claude Code login has expired", "The Foundry is signed out of its AI account"],
    ["exit code 2", "Its command ended with an error"],
    ["claude result: error_max_budget_usd", "The administrator's limit was reached"],
    ["run budget of $2 reached", "The administrator's limit was reached"],
    ["whatever /secret/path $5", "The error is not one the Foundry can explain"],
  ])("userError %j", (raw, want) => {
    const out = userError(raw);
    expect(out).toBe(want);
    expect(out).not.toMatch(/\$|budget|Codex|claude/i);
  });

  it("userRecord empties a folder and keeps owner/name", () => {
    expect(userRecord(nextStep("queued", { repo: "/srv/repo" })).repo).toBe("");
    expect(userRecord(nextStep("queued", { repo: "acme/app.js" })).repo).toBe("acme/app.js");
  });

  it("hidePaths replaces the longest path first, walks arrays and objects, and ignores /", () => {
    const s = { workdir: "/a/b/work", runDir: "/a/b", repo: "/" };
    expect(hidePaths({ x: ["/a/b/work/f", { y: "in /a/b/logs" }], n: 1 }, s)).toEqual({ x: ["(folder)/f", { y: "in (folder)/logs" }], n: 1 });
    expect(hidePaths("a/b", { repo: "/" })).toBe("a/b");
    expect(hidePaths("x")).toBe("x");
  });

  it("movedText names the folder for an admin only", () => {
    expect(movedText("/new/home", true)).toContain("/new/home");
    expect(movedText("/new/home", false)).toBe("the server restarts — try again in a minute");
  });
});

/* ── a server: what a user's answers hold ── */

interface Srv { base: string; tmp: string; home: string; runsDir: string; repo: string; ctx: Awaited<ReturnType<typeof startServer>>["ctx"]; close: () => void }
const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
const open: Srv[] = [];
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  for (const s of open) s.close();
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

function prepare() {
  const tmp = mkdtempSync(join(tmpdir(), "user-view-"));
  const home = join(tmp, "home");
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  process.env.FACTORY_HOME = home;
  return { tmp, home, repo, runsDir: join(tmp, "runs") };
}

async function boot(p: ReturnType<typeof prepare>, extra: Partial<ServerOptions> = {}): Promise<Srv> {
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const started = await startServer({ repo: p.repo, runsDir: p.runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {}, ...extra });
      const s: Srv = { ...p, base: `http://127.0.0.1:${port}`, ctx: started.ctx, close: () => { started.close(); rmSync(p.tmp, { recursive: true, force: true }); } };
      open.push(s);
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
    }
  }
}

const call = async (s: Srv, who: TestSession, method: string, path: string, body?: unknown) => {
  const r = await fetch(s.base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
};

async function stream(s: Srv, who: TestSession, path: string, ms = 400) {
  const ctl = new AbortController();
  const r = await fetch(s.base + path, { headers: who.headers(), signal: ctl.signal });
  let text = "";
  if (r.status !== 200) text = await r.text();
  else {
    const reader = r.body!.getReader();
    const end = Date.now() + ms;
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      while (Date.now() < end) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {
      // aborted
    }
    clearTimeout(timer);
  }
  ctl.abort();
  return { status: r.status, text };
}

const writeRun = (s: Srv, id: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(s.runsDir, id), { recursive: true });
  writeFileSync(join(s.runsDir, id, "run.json"), JSON.stringify({
    runId: id, flow: "old", task: "", vars: {}, repo: s.repo, status: "succeeded", runDir: join(s.runsDir, id),
    startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...extra,
  }));
};

/** Every key of a JSON value, at any depth. */
const allKeys = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), allKeys(x, out));
  return out;
};

const MODEL = "zz-model-name";
const LEAKY = `name: leaky
workspace: empty
publish:
  enabled: true
  vars:
    secret: {mode: hidden}
    shown: {mode: fixed}
vars:
  secret: SENTINEL_HIDDEN
  shown: SENTINEL_FIXED
steps:
  - id: think
    type: claude
    model: ${MODEL}
    prompt: |
      WRITE note.txt x
      DENY Bash cat /etc/SENTINEL_DENY
      SENTINEL_PROMPT price $9.99 1500 tokens
  - id: say
    type: shell
    run: echo "SENTINEL_SHELL costs $3.21"
  - id: gate
    type: approval
    message: "Go on with {{vars.shown}}?"
`;

describe("what a user's answers hold", () => {
  let s: Srv;
  let admin: TestSession;
  let ann: TestSession;
  const logs: string[] = [];
  let id: string;

  beforeAll(async () => {
    s = await boot(prepare(), { log: (m) => void logs.push(m) });
    admin = await signInAs(s.base);
    ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    expect((await call(s, admin, "PUT", "/api/flows/leaky", { yaml: LEAKY, scope: "repo" })).status).toBe(200);
    const r = await call(s, ann, "POST", "/api/runs", { flow: "leaky", task: "do it" });
    expect(r.status).toBe(201);
    id = r.json().runId;
    expect((await s.ctx.scheduler.wait(id))?.status).toBe("waiting");
  });
  afterEach(() => {
    for (const q of [...s.ctx.scheduler.queue().pending, ...s.ctx.scheduler.queue().active]) s.ctx.scheduler.cancel(q.runId);
  });

  const HIDDEN_KEYS = ["totalCostUsd", "costUsd", "tokens", "agent", "sessionId", "output", "defaults", "limits", "sandbox", "prompt", "model", "reason", "runDir", "workdir", "baseSha", "logFile", "denied", "concurrency", "pid", "source", "stepStartedAt", "exitCode", "steps_state"];
  const BAD = [/SENTINEL_PROMPT/, /SENTINEL_SHELL/, /SENTINEL_DENY/, /SENTINEL_HIDDEN/, new RegExp(MODEL), /--model/, /\$\d/, /\btok/i, /tokens/i, /price/i, /budget/i, /claude/i, /anthropic/i, /codex/i, /note\.txt/];
  const clean = (what: string, text: string) => {
    for (const re of BAD) expect(text, `${what} ${re}`).not.toMatch(re);
    expect(text, what).not.toContain(s.tmp);
    for (const k of allKeys(JSON.parse(text.replace(/^[^[{]*/, "") || "{}"))) if (k !== "steps") expect(HIDDEN_KEYS, `${what} key ${k}`).not.toContain(k);
  };

  it("lists, shows and streams a run without costs or setup", async () => {
    const list = await call(s, ann, "GET", "/api/runs");
    const detail = await call(s, ann, "GET", `/api/runs/${id}`);
    const queue = await call(s, ann, "GET", "/api/queue");
    const ev = await stream(s, ann, `/api/runs/${id}/events`);
    expect(ev.status).toBe(200);
    clean("list", list.text);
    clean("detail", detail.text);
    clean("queue", queue.text);
    // every data line of the stream is JSON on its own
    const lines = ev.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    for (const l of lines) clean("event", JSON.stringify(l));

    const run = detail.json();
    expect(run.status).toBe("waiting");
    expect(run.waiting.message).toContain("SENTINEL_FIXED");
    expect(run.next.kind).toBe("approval");
    expect(run.vars).toEqual({ shown: "SENTINEL_FIXED" });
    const log = lines.filter((l) => l.type === "log").map((l) => l.line as string);
    for (const want of ["▶ think (agent)", "    · Write", "    ⚠ blocked: Bash"]) expect(log, want).toContain(want);
    expect(log.some((l) => l.startsWith("✔ think ("))).toBe(true);
    // the update events keep their envelope
    const updates = lines.filter((l) => l.type === "update");
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(keys(u)).toEqual(["summary", "type"]);
  });

  it("shows an admin the costs, the agent, the output and the log with the cost", async () => {
    const run = (await call(s, admin, "GET", `/api/runs/${id}`)).json();
    expect(run.totalCostUsd).toBe(0.01);
    expect(run.history[0].agent).toBeTruthy();
    expect(run.history[0].output).toContain("SENTINEL_PROMPT");
    expect(run.flowDef.steps[0].prompt).toContain("SENTINEL_PROMPT");
    const ev = await stream(s, admin, `/api/runs/${id}/events`);
    expect(ev.text).toContain("$0.0100");
    const updates = ev.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).filter((l) => l.type === "update");
    for (const u of updates) expect(keys(u)).toEqual(["summary", "type"]);
  });

  it("answers 403 to a user for a transcript, 200 for the admin, and 200 for the diff", async () => {
    expect((await call(s, ann, "GET", `/api/runs/${id}/transcript/0`)).status).toBe(403);
    expect((await call(s, admin, "GET", `/api/runs/${id}/transcript/0`)).status).toBe(200);
    expect((await call(s, ann, "GET", `/api/runs/${id}/diff`)).status).toBe(200);
  });

  it("words limits and sign-in problems without money or setup", async () => {
    const mk = (rid: string, extra: Record<string, unknown>) => writeRun(s, rid, { owner: ann.user.id, ...extra });
    mk("20260102-000000-day", { status: "stopped", reason: "daily budget of $5 reached — resume tomorrow" });
    mk("20260102-000000-run", { status: "failed", reason: "run budget of $2 reached" });
    mk("20260102-000000-max", { status: "failed", reason: 'step "a" failed: claude result: error_max_budget_usd' });
    mk("20260102-000000-out", { status: "stopped", reason: "signed out — the Claude Code login has expired. Sign in again: run \"claude\" in a terminal and type /login. The run continues by itself after that." });
    mk("20260102-000000-git", { status: "failed", reason: 'workspace "worktree" needs a git repository, but /secret/path is not one' });
    const get = async (who: TestSession, rid: string) => (await call(s, who, "GET", `/api/runs/${rid}`));
    const day = (await get(ann, "20260102-000000-day")).json().next;
    expect(day.status).toBe("paused — the administrator's limit was reached");
    expect(day.kind).toBe("usage_limit");
    expect(JSON.stringify(day)).not.toMatch(/budget|\$|Settings/);
    expect((await get(admin, "20260102-000000-day")).json().next.status).toBe("paused — daily budget");
    for (const rid of ["run", "max"]) {
      expect((await get(ann, `20260102-000000-${rid}`)).json().next.status).toBe("stopped — the administrator's limit was reached");
      expect((await get(admin, `20260102-000000-${rid}`)).json().next.status).toBe("failed");
    }
    const out = await get(ann, "20260102-000000-out");
    expect(out.json().next.who).not.toBe("You");
    expect(out.text).not.toMatch(/claude/i);
    expect((await get(admin, "20260102-000000-out")).json().next.who).toBe("You");
    const git = await get(ann, "20260102-000000-git");
    expect(git.text).not.toContain("/secret/path");
  });

  it("rebuilds a hand-written log: no sentinel for a user, all for the admin", async () => {
    const rid = "20260102-000000-log";
    writeRun(s, rid, { owner: ann.user.id, workdir: "/secret/work/SENTINEL_DIR" });
    const lines = [
      "run 20260102-000000-log · flow old · /secret/work/SENTINEL_DIR",
      "▶ a (claude)",
      "    · agent claude:anthropic:SENTINEL_AGENT",
      "    · Bash: cat /secret/SENTINEL_ARGS --model opus",
      "⚠ run budget reached — agent steps continue on SENTINEL_FALLBACK",
      "✔ a (1.0s, $0.0100, 3k tok)",
      "✘ could not start: ENOENT /secret/SENTINEL_START",
    ];
    appendFileSync(join(s.runsDir, rid, "live.log"), lines.join("\n") + "\n");
    const ann1 = (await stream(s, ann, `/api/runs/${rid}/events`)).text;
    const adm = (await stream(s, admin, `/api/runs/${rid}/events`)).text;
    for (const w of ["SENTINEL_DIR", "SENTINEL_AGENT", "SENTINEL_ARGS", "SENTINEL_FALLBACK", "SENTINEL_START", "$0.01", "tok", "opus"]) {
      expect(ann1, w).not.toContain(w);
      if (w !== "opus") expect(adm, w).toContain(w);
    }
    expect(ann1).toContain("▶ a (agent)");
    expect(ann1).toContain("    · Bash");
  });

  it("keeps the queue entries to an allow-list and holds no concurrency, and keeps the admin's", async () => {
    const days = ["day", "run", "out"].map((k) => `20260102-000000-${k}`);
    s.ctx.config().concurrency = 0;
    try {
      for (const rid of days) expect((await call(s, ann, "POST", `/api/runs/${rid}/resume`, {})).status, rid).toBe(202);
      const q = (await call(s, ann, "GET", "/api/queue")).json();
      expect(q.pending).toHaveLength(3);
      expect(keys(q)).toEqual(["active", "pending"]);
      const allowed = ["runId", "kind", "enqueuedAt", "waitingFor", "githubRepo", "issue", "task", "next", "ahead"];
      for (const p of q.pending) for (const k of Object.keys(p)) expect(allowed, k).toContain(k);
      expect(JSON.stringify(q)).not.toMatch(/\$|budget|Settings|claude/i);
      const a = (await call(s, admin, "GET", "/api/queue")).json();
      expect(a.concurrency).toBe(0);
      expect(a.pending).toHaveLength(3);
      expect(a.pending[0]).toHaveProperty("source");
    } finally {
      s.ctx.config().concurrency = 2;
    }
  });
});

describe("errors a user gets", () => {
  let s: Srv;
  let admin: TestSession;
  let ann: TestSession;
  const logs: string[] = [];

  beforeAll(async () => {
    s = await boot(prepare(), { log: (m) => void logs.push(m) });
    admin = await signInAs(s.base);
    ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
  });
  afterEach(() => {
    rmSync(join(s.home, "queue.json"), { recursive: true, force: true });
    s.ctx.config().concurrency = 2;
    for (const q of [...s.ctx.scheduler.queue().pending, ...s.ctx.scheduler.queue().active]) s.ctx.scheduler.cancel(q.runId);
  });

  const resumable = (rid: string, owner: string) =>
    writeRun(s, rid, { owner, status: "stopped", workdir: s.repo, flowDef: { name: "x", workspace: "empty", steps: [{ id: "a", type: "shell", run: "true" }] }, state: { next: "a", steps: {}, visits: {} } });

  it("answers a generic 500 to a user and the git message to the admin when the diff fails", async () => {
    const work = join(s.tmp, "work");
    mkdirSync(work);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: work, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    writeRun(s, "20260103-000000-diff", { owner: ann.user.id, workdir: work, baseSha: "0".repeat(40) });
    const user = await call(s, ann, "GET", "/api/runs/20260103-000000-diff/diff");
    expect(user.status).toBe(500);
    expect(user.json()).toEqual({ error: USER_ERROR });
    expect(logs.some((l) => l.startsWith("api GET runs/:id/diff:"))).toBe(true);
    const adm = await call(s, admin, "GET", "/api/runs/20260103-000000-diff/diff");
    expect(adm.status).toBe(400);
    expect(adm.json().error).toMatch(/git|fatal|0000/i);
  });

  it("answers 400 to both roles for a resume of a run that is already queued", async () => {
    s.ctx.config().concurrency = 0;
    resumable("20260103-000000-q1", ann.user.id);
    resumable("20260103-000000-q2", admin.user.id);
    for (const [who, rid] of [[ann, "20260103-000000-q1"], [admin, "20260103-000000-q2"]] as const) {
      expect((await call(s, who, "POST", `/api/runs/${rid}/resume`, {})).status).toBe(202);
      const again = await call(s, who, "POST", `/api/runs/${rid}/resume`, {});
      expect(again.status).toBe(400);
      expect(again.json().error).toBe(`run ${rid} is already queued or running`);
    }
  });

  it("answers a generic 500 to a user when the queue file cannot be written, without the path", async () => {
    resumable("20260103-000000-wr", ann.user.id);
    resumable("20260103-000000-wa", admin.user.id);
    rmSync(join(s.home, "queue.json"), { force: true });
    mkdirSync(join(s.home, "queue.json"));
    const user = await call(s, ann, "POST", "/api/runs/20260103-000000-wr/resume", {});
    expect(user.status).toBe(500);
    expect(user.json()).toEqual({ error: USER_ERROR });
    expect(user.text).not.toContain(s.home);
    expect(logs.some((l) => l.includes("queue.json"))).toBe(true);
    const adm = await call(s, admin, "POST", "/api/runs/20260103-000000-wa/resume", {});
    expect(adm.status).toBe(400);
    expect(adm.json().error).toContain("queue.json");
  });

  it("answers the moved-folder 503 to a user without the folder", async () => {
    expect(movedText("/x", false)).not.toContain("/x");
    expect(readFileSync(resolve("src/server/server.ts"), "utf8")).toContain("movedText(moved, admin)");
  });
});
