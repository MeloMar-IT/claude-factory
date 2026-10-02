import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { nextStep } from "../src/next-step.js";
import { toHold } from "../src/queue/watcher.js";
import { health } from "../src/server/health.js";
import type { ApiContext } from "../src/server/server.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

let n = 0;
const run = (over: Partial<RunSummary> = {}): RunSummary =>
  ({
    runId: `r${++n}`, flow: "github-issue", task: "do it", status: "failed", startedAt: ago(10 * MIN), finishedAt: ago(5 * MIN),
    vars: { github_repo: "acme/app", issue: String(100 + n) }, history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} },
    runDir: "/tmp/none", ...over,
  }) as unknown as RunSummary;
const limited = (agent: string | undefined, over: Partial<RunSummary> = {}) =>
  run({ status: "stopped", reason: "usage limit reached — resets 11:52", history: agent ? [{ agent } as never] : [], ...over });
const factoryFailure = (over: Partial<RunSummary> = {}) => run({ status: "failed", reason: "internal error: boom", ...over });

const wcfg = (id: string, repo = "acme/app", over: Record<string, unknown> = {}) => WatcherSchema.parse({ id, github_repo: repo, ...over });
const wstatus = (id: string, over: Record<string, unknown> = {}) => ({ id, lastActions: [], ...over });

interface Setup {
  runs?: RunSummary[];
  active?: string[];
  pending?: string[];
  watchers?: { cfg: ReturnType<typeof wcfg>; status: ReturnType<typeof wstatus> }[];
  restart?: ApiContext["restart"];
  config?: Record<string, unknown>;
  runsDir?: string;
  get?: (id: string) => Partial<RunSummary> | undefined;
}
const ctxOf = (s: Setup = {}): ApiContext => {
  const runs = s.runs ?? [];
  const watchers = s.watchers ?? [];
  return {
    opts: { runsDir: s.runsDir ?? "/nonexistent" },
    restart: s.restart,
    config: () => ConfigSchema.parse({ protected_branches: [], ...s.config }),
    scheduler: {
      list: () => runs,
      get: (id: string) => s.get?.(id) ?? runs.find((r) => r.runId === id),
      queue: () => ({ active: (s.active ?? []).map((runId) => ({ runId })), pending: (s.pending ?? []).map((runId) => ({ runId, kind: "run" })) }),
    },
    watchers: {
      tracked: () => watchers.map((w) => ({ watcher: w.cfg, status: w.status, issues: [] })),
      statuses: () => watchers.map((w) => ({ ...w.cfg, status: w.status })),
    },
  } as unknown as ApiContext;
};
const kinds = (h: ReturnType<typeof health>) => h.problems.map((p) => p.kind);

describe("health()", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("says All good when nothing is wrong", () => {
    expect(health(ctxOf(), NOW)).toEqual({ ok: true, summary: "All good", problems: [], repos: [] });
  });

  it("a server that waits to restart says how many runs it waits for", () => {
    const h = health(ctxOf({ restart: { why: "new_version", since: ago(MIN) }, active: ["a"], pending: ["b"] }), NOW);
    expect(h.summary).toBe("1 problem");
    expect(h.problems[0]!.text).toBe("A new version is waiting — it restarts after 2 runs.");
  });

  it("skips the stale check while restarting, but keeps a watcher error", () => {
    const cfg = wcfg("a");
    const stale = { cfg, status: wstatus("a", { startedAt: ago(DAY), lastTick: ago(DAY) }) };
    const restart = { why: "new_version" as const, since: ago(MIN) };
    expect(kinds(health(ctxOf({ restart, watchers: [stale] }), NOW))).toEqual(["restart"]);
    expect(kinds(health(ctxOf({ watchers: [stale] }), NOW))).toEqual(["watcher_stale"]);
    const err = { cfg, status: wstatus("a", { lastError: "boom" }) };
    expect(kinds(health(ctxOf({ restart, watchers: [err] }), NOW))).toEqual(["restart", "watcher_error"]);
  });

  describe("usage limit", () => {
    it("is one problem per agent, with the newest run", () => {
      const a = limited("codex:openai:gpt-5", { finishedAt: ago(20 * MIN), reason: "usage limit reached — resets 10:00" });
      const b = limited("codex:openai:gpt-5", { finishedAt: ago(5 * MIN), reason: "usage limit reached — resets 11:52" });
      const c = limited("claude:anthropic:sonnet", { finishedAt: ago(8 * MIN) });
      const h = health(ctxOf({ runs: [a, b, c] }), NOW);
      expect(h.problems.map((p) => p.why)).toEqual(["The Codex usage limit is reached", "The Claude usage limit is reached"]);
      expect(h.problems[0]!.until).toBe("11:52");
      expect(h.problems[0]!.where.url).toBe("#/runs");
    });

    it("ignores old, superseded and failed runs, and names an unknown agent AI", () => {
      const old = limited("codex", { finishedAt: ago(61 * MIN) });
      const first = limited("claude", { vars: { github_repo: "acme/app", issue: "9" }, startedAt: ago(30 * MIN) });
      const newer = run({ status: "succeeded", vars: { github_repo: "acme/app", issue: "9" }, startedAt: ago(20 * MIN) });
      const failed = run({ status: "failed", reason: "usage limit reached", history: [{ agent: "codex" } as never] });
      // A failed run is no usage-limit problem (it counts as a Foundry failure, with its own sentence).
      expect(kinds(health(ctxOf({ runs: [old, newer, first, failed] }), NOW)).filter((k) => k === "usage_limit")).toEqual([]);
      expect(health(ctxOf({ runs: [limited(undefined)] }), NOW).problems[0]!.why).toBe("The AI usage limit is reached");
    });
  });

  it("a used-up daily budget is a problem, when limits are on", () => {
    const runsDir = mkdtempSync(join(tmpdir(), "health-"));
    dirs.push(runsDir);
    const runDir = join(runsDir, "r-cost");
    mkdirSync(runDir);
    saveRun(run({ runId: "r-cost", runDir, status: "succeeded", startedAt: NOW.toISOString(), totalCostUsd: 6 }));
    const h = health(ctxOf({ runsDir, config: { daily_budget_usd: 5 } }), NOW);
    expect(h.problems).toHaveLength(1);
    expect(h.problems[0]).toMatchObject({ kind: "daily_budget", where: { url: "#/settings" } });
    expect(kinds(health(ctxOf({ runsDir, config: { daily_budget_usd: 5, cost_limits: false } }), NOW))).toEqual([]);
    expect(kinds(health(ctxOf({ runsDir }), NOW))).toEqual([]);
  });

  describe("watcher error", () => {
    it("names the repository and a connection problem", () => {
      const h = health(ctxOf({ watchers: [{ cfg: wcfg("a"), status: wstatus("a", { lastError: "cannot access acme/app with gh: boom" }) }] }), NOW);
      expect(h.problems[0]!.why).toBe("The watcher for acme/app can't reach GitHub: GitHub did not answer or did not let it in");
    });

    it("shows equal sentences once and different ones for the same repository both", () => {
      const conn = (id: string) => ({ cfg: wcfg(id), status: wstatus(id, { lastError: "cannot access acme/app with gh: boom" }) });
      expect(health(ctxOf({ watchers: [conn("a"), conn("b")] }), NOW).problems).toHaveLength(1);
      const bad = { cfg: wcfg("b"), status: wstatus("b", { lastError: 'invalid interval "soon"' }) };
      expect(health(ctxOf({ watchers: [conn("a"), bad] }), NOW).problems).toHaveLength(2);
    });
  });

  it("a closed issue with a busy run is listed once, until the run is not busy", () => {
    const hold = toHold(nextStep("closed_elsewhere", { repo: "acme/app", issue: 4, runId: "r-busy" }, { issueUrl: "https://github.com/acme/app/issues/4" }));
    const two = [{ cfg: wcfg("a"), status: wstatus("a", { holds: [hold] }) }, { cfg: wcfg("b"), status: wstatus("b", { holds: [hold] }) }];
    const busy = health(ctxOf({ watchers: two, get: () => ({ status: "running" }) }), NOW);
    expect(kinds(busy)).toEqual(["closed_elsewhere"]);
    expect(busy.problems[0]!.runId).toBe("r-busy");
    expect(kinds(health(ctxOf({ watchers: two, get: () => ({ status: "cancelled" }) }), NOW))).toEqual([]);
  });

  describe("Foundry failures", () => {
    it("shows the 5 newest of 7", () => {
      const runs = Array.from({ length: 7 }, (_, i) => factoryFailure({ startedAt: ago((i + 1) * MIN), finishedAt: ago(i * MIN + 30_000) }));
      const h = health(ctxOf({ runs }), NOW);
      expect(h.problems).toHaveLength(5);
      expect(h.problems.map((p) => p.runId)).toEqual(runs.slice(0, 5).map((r) => r.runId));
    });

    it("leaves out old, replaced, code and interrupted failures", () => {
      const oldRun = factoryFailure({ startedAt: ago(8 * DAY + MIN), finishedAt: ago(8 * DAY) });
      const first = factoryFailure({ vars: { github_repo: "acme/app", issue: "9" }, startedAt: ago(30 * MIN) });
      const newer = run({ status: "running", vars: { github_repo: "acme/app", issue: "9" }, startedAt: ago(20 * MIN) });
      const code = run({ status: "failed", reason: 'step "x" failed: exit code 1' });
      const interrupted = run({ status: "failed", reason: "interrupted — the server stopped" });
      expect(kinds(health(ctxOf({ runs: [oldRun, newer, first, code, interrupted] }), NOW))).toEqual([]);
    });
  });

  describe("repos", () => {
    it("gives the oldest last check, none for a repository with a watcher that never succeeded, and skips disabled ones", () => {
      const ws = [
        { cfg: wcfg("a"), status: wstatus("a", { lastOk: ago(5 * MIN), lastTick: ago(MIN) }) },
        { cfg: wcfg("b"), status: wstatus("b", { lastOk: ago(9 * MIN), lastTick: ago(MIN) }) },
        { cfg: wcfg("c", "acme/web"), status: wstatus("c", { lastTick: ago(MIN) }) },
        { cfg: wcfg("d", "acme/off", { enabled: false }), status: wstatus("d", { lastOk: ago(MIN) }) },
      ];
      expect(health(ctxOf({ watchers: ws }), NOW).repos).toEqual([{ repo: "acme/app", lastOk: ago(9 * MIN) }, { repo: "acme/web" }]);
    });
  });

  describe("only safe text", () => {
    it("has exactly the four keys and no paths, tokens or settings", () => {
      const local = factoryFailure({
        repo: "/work/app", vars: {}, task: "Fix /work/app/x.ts ghp_task456",
        reason: "internal error: ENOENT: open '/work/app/.env' ghp_abc123",
      } as never);
      const env = factoryFailure({ vars: {}, reason: 'bot.gh_token_env is "MY_TOKEN_ENV" but that env var is not set' });
      const runsDir = "/secret/runs/dir";
      const h = health(ctxOf({ runs: [local, env], runsDir }), NOW);
      expect(Object.keys(h).sort()).toEqual(["ok", "problems", "repos", "summary"]);
      expect(h.problems[0]).toMatchObject({ repo: "", title: "", why: "The Foundry failed, not the code" });
      expect(h.problems[1]!.action).toContain("Set that environment variable");
      const json = JSON.stringify(h);
      for (const s of [runsDir, "/work/app", "ghp_", "MY_TOKEN_ENV", "ENOENT"]) expect(json).not.toContain(s);
    });

    it("makes a watched failure brief too", () => {
      const r = factoryFailure({ vars: { github_repo: "acme/app", issue: "5" } });
      const hold = toHold(nextStep("failed", { repo: "acme/app", issue: 5, runId: r.runId }, { reason: r.reason, cause: "factory", what: "internal error: boom", fix: "restart or update the Foundry", watched: true }));
      const h = health(ctxOf({ runs: [r], watchers: [{ cfg: wcfg("a"), status: wstatus("a", { holds: [hold] }) }] }), NOW);
      expect(h.problems).toHaveLength(1);
      expect(JSON.stringify(h)).not.toContain("boom");
    });

    it("keeps no issue title and no free text in a limit's reset time", () => {
      const hold = toHold(nextStep("closed_elsewhere", { repo: "acme/app", issue: 4, title: "Fix /work/app ghp_title789", runId: "r-busy" }));
      const w = { cfg: wcfg("a"), status: wstatus("a", { holds: [hold] }) };
      const bad = limited("codex", { reason: "usage limit reached — resets /work/app/.env ghp_reset123" });
      const ok = limited("claude", { reason: "usage limit reached — resets 3:50pm (Europe/Amsterdam)" });
      const h = health(ctxOf({ watchers: [w], active: ["r-busy"], runs: [bad, ok] }), NOW);
      expect(h.problems.find((p) => p.kind === "closed_elsewhere")!.title).toBe("");
      const [codex, claude] = h.problems.filter((p) => p.kind === "usage_limit");
      expect(claude!.until).toBe("3:50pm (Europe/Amsterdam)");
      expect(codex!.until).toMatch(/^(\d\d:\d\d|the next check)$/); // the calculated retry time
      const json = JSON.stringify(h);
      for (const s of ["ghp_", "/work/app"]) expect(json).not.toContain(s);
    });

    it("only links https or in-page", () => {
      const hold = toHold({ ...nextStep("closed_elsewhere", { repo: "acme/app", issue: 4, runId: "r-busy" }), where: { label: "x", url: "http://example.test/x" } });
      const w = { cfg: wcfg("a"), status: wstatus("a", { holds: [hold], lastError: "boom" }) };
      const h = health(ctxOf({ watchers: [w], active: ["r-busy"], restart: { why: "data_folder", since: ago(MIN) } }), NOW);
      expect(h.problems.find((p) => p.kind === "closed_elsewhere")!.where.url).toBe("#/runs");
      for (const p of h.problems) expect(p.where.url).toMatch(/^(https:\/\/|#\/)/);
    });
  });
});
