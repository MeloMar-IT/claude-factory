import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataHome } from "../src/auth/store.js";
import { ConfigSchema } from "../src/config.js";
import { canWrite, commentOnIssue, issueComments, repoPermission, setLabels } from "../src/github.js";
import { nextStep, type NextStep } from "../src/next-step.js";
import { readAct, turnAct, turnDetail } from "../src/server/turn-actions.js";
import { turnFor } from "../src/server/your-turn.js";
import type { ApiContext } from "../src/server/server.js";
import { fakeGithub } from "./helpers/fake-github.js";

// The answer, approve and retry actions against a stub context and the fake gh.

const NOW = new Date("2026-10-01T12:00:00Z");
const user = { id: "u1", name: "Marcel K" };
const cfg = (status_labels?: Record<string, string>) => ConfigSchema.parse({ watchers: [{ id: "a", github_repo: "acme/app", flow: "github-issue", ...(status_labels ? { status_labels } : {}) }] });

const hold = (next: NextStep, since: string) => ({ issue: next.issue, reason: next.text, next, since });
const rec = (kind: Parameters<typeof nextStep>[0], issue: number, runId?: string, data: Record<string, unknown> = {}) =>
  nextStep(kind, { repo: "acme/app", issue, title: `T${issue}`, runId }, { watched: true, issueUrl: `https://github.com/acme/app/issues/${issue}`, failedLabel: "factory:failed", ...data });

let gh: ReturnType<typeof fakeGithub>;
let kick: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof vi.fn>;

function stub(holds: ReturnType<typeof hold>[], labels?: Record<string, string>) {
  const config = cfg(labels);
  kick = vi.fn();
  log = vi.fn();
  return {
    opts: { log },
    config: () => config,
    scheduler: { list: () => [], get: () => undefined, briefs: () => [], queue: () => ({ pending: [], active: [] }) },
    watchers: { statuses: () => [], tracked: () => [{ watcher: config.watchers[0], status: { id: "a", lastActions: [], holds }, issues: holds.filter((h) => h.issue !== undefined && h.next.kind !== "release").map((h) => ({ issue: h.issue, title: `T${h.issue}`, runId: h.next.runId })) }], kickRepo: kick },
  } as unknown as ApiContext;
}

const SINCE = "2026-10-01T10:00:00Z";
const QKEY = "acme/app#5|questions|";
const PKEY = "acme/app#6|approve_plan|r1";
const FKEY = "acme/app#8|failed|";
const questionsComment = "**What you need to do:** Answer.\n\n**Q1. Which?**\nOptions.\n**Recommendation:** (a)\n\n**Q2. Where?**\nHere or there.\n**Recommendation:** here\n\n_Answer or /defaults._\n\n<!-- claude-factory run=r0 questions -->";
const planComment = (run: string, risk: number) => `**What you need to do:** Decide.\n\n🤖 **Spaghetti Code Foundry plan**\n\n**Risk: ${risk}/100** — touches login\n\nthe plan\n\n✋ **A human decides before coding starts:** the risk score is above 75.\n\n_Reply._\n\n<!-- claude-factory run=${run} approval -->`;
const setComments = (...c: { login?: string; body: string }[]) =>
  (process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c.map((x, i) => ({ author: { login: x.login ?? "foundry-owner" }, body: x.body, createdAt: `2026-10-01T0${i}:00:00Z` })) }));
const ctxAll = () => stub([hold(rec("questions", 5, undefined, { questions: 2 }), SINCE), hold(rec("approve_plan", 6, "r1"), SINCE), hold(rec("failed", 8), SINCE)]);
/** Acts like the app: it sends back the digest of the comment it showed (read now), unless the test gives one. */
const act = async (ctx: ApiContext, body: Record<string, unknown>, now = NOW) => {
  let b = body;
  if (b.digest === undefined && b.action !== "retry" && b.action !== "retry_hint") {
    try {
      b = { ...b, digest: (await turnDetail(ctx, b.key as string, now)).digest };
    } catch {
      // no detail: the request goes without a digest
    }
  }
  return turnAct(ctx, user, readAct(b), now);
};
const status = async (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);
const stampOf = (ctx: ApiContext, key: string) => turnFor(ctx, NOW).all.find((i) => i.key === key)!.stamp;
const comments = () => (gh.ghLog().match(/gh issue comment/g) ?? []).length;

beforeEach(() => {
  gh = fakeGithub();
  setComments({ body: questionsComment }, { body: planComment("r1", 80) });
});
afterEach(() => gh.restore());

describe("turnDetail", () => {
  it("returns the parsed questions and the stamp, also with a newer Foundry comment after them", async () => {
    setComments({ body: questionsComment }, { body: "failed\n<!-- claude-factory run=r0 -->" });
    const d = await turnDetail(ctxAll(), QKEY, NOW);
    expect(d).toMatchObject({ stamp: SINCE, acts: ["defaults", "answer"], questions: [{ n: 1, title: "Which?", recommendation: "(a)" }, { n: 2 }] });
  });

  it("picks the approval comment of the item's run", async () => {
    setComments({ body: planComment("r0", 10) }, { body: planComment("r1", 80) }, { body: planComment("r2", 20) });
    const d = await turnDetail(ctxAll(), PKEY, NOW);
    expect(d.proposal).toMatchObject({ risk: 80, reason: "touches login", gate: "the risk score is above 75" });
  });

  it("makes no gh call for a failed item; refuses unknown, action-less items and a GitHub error", async () => {
    const ctx = ctxAll();
    expect((await turnDetail(ctx, FKEY, NOW)).acts).toEqual(["retry", "retry_hint"]);
    expect(gh.ghLog()).toBe("");
    expect(await status(turnDetail(ctx, "nope", NOW))).toBe(404);
    const pr = { number: 4, url: "https://github.com/acme/app/pull/4" };
    const rel = stub([hold(rec("release", undefined as unknown as number, undefined, { pr }), SINCE)]);
    expect(await status(turnDetail(rel, `release|${pr.url}`, NOW))).toBe(409);
    process.env.FAKE_GH_FAIL = "issue view";
    expect(await status(turnDetail(ctx, QKEY, NOW))).toBe(502);
  });
});

describe("trust and freshness", () => {
  it("ignores a Foundry-looking comment from another account", async () => {
    setComments({ login: "mallory", body: planComment("r1", 1) });
    expect(await status(turnDetail(ctxAll(), PKEY, NOW))).toBe(409);
    setComments({ body: planComment("r1", 80) }, { login: "mallory", body: planComment("r1", 1) });
    expect((await turnDetail(ctxAll(), PKEY, NOW)).proposal!.risk).toBe(80);
  });

  it("refuses when someone already answered or decided on GitHub", async () => {
    setComments({ body: questionsComment }, { login: "ann", body: "Use Postgres" });
    expect(await status(act(ctxAll(), { key: QKEY, action: "defaults", stamp: SINCE }))).toBe(409);
    setComments({ body: planComment("r1", 80) }, { login: "ann", body: "looks fine to me" }, { login: "ann", body: "/approve" });
    expect(await status(act(ctxAll(), { key: PKEY, action: "approve", stamp: SINCE }))).toBe(409);
    expect(comments()).toBe(0);
    setComments({ body: planComment("r1", 80) }, { login: "ann", body: "a question about the plan" });
    expect(await status(act(ctxAll(), { key: PKEY, action: "approve", stamp: SINCE }))).toBe(0);
  });

  it("a /approve from someone without write access does not block the in-app approval", async () => {
    setComments({ body: planComment("r1", 80) }, { login: "mallory", body: "/approve" });
    process.env.FAKE_GH_READONLY = "mallory";
    expect(await status(act(ctxAll(), { key: PKEY, action: "approve", stamp: SINCE }))).toBe(0);
    expect(comments()).toBe(1);
  });

  it("a /approve from someone with write access does block it", async () => {
    setComments({ body: planComment("r1", 80) }, { login: "ann", body: "/approve" });
    expect(await status(act(ctxAll(), { key: PKEY, action: "approve", stamp: SINCE }))).toBe(409);
    expect(comments()).toBe(0);
  });

  it("refuses when the comment was edited after the app showed it, or no digest is sent", async () => {
    const ctx = ctxAll();
    const d = await turnDetail(ctx, QKEY, NOW);
    setComments({ body: questionsComment.replace("Which?", "Something else?") }, { body: planComment("r1", 80) });
    expect(await status(act(ctx, { key: QKEY, action: "defaults", stamp: SINCE, digest: d.digest }))).toBe(409);
    expect(await status(act(ctx, { key: QKEY, action: "defaults", stamp: SINCE, digest: "" }))).toBe(409);
    expect(() => readAct({ key: QKEY, action: "defaults", stamp: SINCE })).toThrow(/digest/);
    expect(comments()).toBe(0);
  });

  it("checks the length of the whole comment before posting", async () => {
    const big = "x".repeat(40_000);
    expect(await status(act(ctxAll(), { key: QKEY, action: "answer", stamp: SINCE, answers: [{ n: 1, text: big }, { n: 2, text: big }] }))).toBe(400);
    expect(gh.ghLog()).not.toContain("issue comment");
  });
});

describe("answers", () => {
  it("posts /defaults with the signature, kicks the watcher and moves the item to continuing", async () => {
    const ctx = ctxAll();
    await act(ctx, { key: QKEY, action: "defaults", stamp: SINCE });
    expect(gh.ghLog()).toContain("issue comment 5 --repo acme/app --body-file -");
    expect(gh.ghLog()).toContain("\n/defaults\n");
    expect(gh.ghLog()).toContain("— Marcel K, via Spaghetti Code Foundry");
    expect(kick).toHaveBeenCalledWith("acme/app", 1000);
    expect(log.mock.calls.join()).toContain("u1");
    expect(log.mock.calls.join()).not.toContain("Marcel");
    const t = turnFor(ctx, NOW).data;
    expect(t.groups.flatMap((g) => g.items).map((i) => i.key)).not.toContain(QKEY);
    expect(t.continuing!.map((i) => i.key)).toEqual([QKEY]);
    expect(await status(act(ctx, { key: QKEY, action: "defaults", stamp: SINCE }))).toBe(409);
  });

  it("refuses /defaults for planner questions", async () => {
    const ctx = stub([hold(rec("planner_questions", 5, "r1"), SINCE)]);
    expect(await status(act(ctx, { key: "acme/app#5|planner_questions|r1", action: "defaults", stamp: SINCE }))).toBe(409);
  });

  it("posts the answers as one comment", async () => {
    await act(ctxAll(), { key: QKEY, action: "answer", stamp: SINCE, answers: [{ n: 1, text: "a" }, { n: 2, text: "b" }] });
    expect(gh.ghLog()).toMatch(/\*\*Q1\.\*\* a\n\n\*\*Q2\.\*\* b/);
    expect(comments()).toBe(1);
  });
});

describe("approve and reject", () => {
  const approve = (ctx: ApiContext, over: Record<string, unknown> = {}) => act(ctx, { key: PKEY, action: "approve", stamp: SINCE, text: "notes", ...over });

  it("posts /approve with the notes when the account may write", async () => {
    await approve(ctxAll());
    expect(gh.ghLog()).toContain("\n/approve notes\n");
    expect(gh.ghLog()).toContain("gh api user");
  });

  it("refuses when the account has no write access, without posting", async () => {
    process.env.FAKE_GH_PERMISSION = "read";
    expect(await status(approve(ctxAll()))).toBe(409);
    expect(comments()).toBe(0);
  });

  it("reads a 403 from the permission call as no access, other errors as 502", async () => {
    const ctx = ctxAll();
    process.env.FAKE_GH_FAIL = "api repos/acme/app/collaborators/foundry-owner/permission";
    process.env.FAKE_GH_FAIL_TEXT = "gh: Must have push access to view collaborator permission. (HTTP 403)";
    expect(await status(approve(ctx))).toBe(409);
    delete process.env.FAKE_GH_FAIL_TEXT;
    expect(await status(approve(ctx))).toBe(502);
    const digest = (await turnDetail(ctx, PKEY, NOW)).digest;
    process.env.FAKE_GH_FAIL = "api user";
    expect(await status(approve(ctx, { digest }))).toBe(502);
    expect(comments()).toBe(0);
    expect(turnFor(ctx, NOW).data.continuing).toBeUndefined();
  });

  it("rejects only with a reason, and needs a stamp that still matches", async () => {
    const ctx = ctxAll();
    expect(await status(act(ctx, { key: PKEY, action: "reject", stamp: SINCE }))).toBe(400);
    expect(await status(act(ctx, { key: PKEY, action: "approve" }))).toBe(400);
    expect(await status(act(ctx, { key: PKEY, action: "approve", stamp: "other" }))).toBe(409);
    expect(comments()).toBe(0);
    await act(ctx, { key: PKEY, action: "reject", stamp: SINCE, text: "use another way" });
    expect(gh.ghLog()).toContain("\n/reject use another way\n");
  });
});

describe("retry", () => {
  it("removes the failed label (its configured name) and posts nothing", async () => {
    const ctx = stub([hold(rec("failed", 8), SINCE)], { failed: "Factory_ERROR" });
    await act(ctx, { key: FKEY, action: "retry" });
    expect(gh.ghLog()).toContain("issue edit 8 --repo acme/app --remove-label Factory_ERROR");
    expect(comments()).toBe(0);
    expect(kick).toHaveBeenCalled();
  });

  it("does not continue when the label call fails", async () => {
    const ctx = ctxAll();
    process.env.FAKE_GH_FAIL = "issue edit";
    expect(await status(act(ctx, { key: FKEY, action: "retry" }))).toBe(502);
    expect(kick).not.toHaveBeenCalled();
    expect(turnFor(ctx, NOW).data.continuing).toBeUndefined();
  });

  it("posts the hint first, and never twice when the label call has to be repeated", async () => {
    const ctx = ctxAll();
    const body = { key: FKEY, action: "retry_hint", stamp: SINCE, text: "try the other file" };
    process.env.FAKE_GH_FAIL = "issue edit";
    const err = await act(ctx, body).catch((e: Error & { status: number }) => e);
    expect((err as { status: number }).status).toBe(502);
    expect((err as Error).message).toContain("the hint was posted");
    delete process.env.FAKE_GH_FAIL;
    await act(ctx, body);
    expect(comments()).toBe(1);
    const log = gh.ghLog();
    expect(log.indexOf("issue comment 8")).toBeLessThan(log.indexOf("issue edit 8"));
    expect(turnFor(ctx, NOW).data.continuing!.map((i) => i.key)).toEqual([FKEY]);
  });
});

describe("refusals and guards", () => {
  it("refuses an action that is not in the item's acts", async () => {
    expect(await status(act(ctxAll(), { key: FKEY, action: "approve", stamp: SINCE, digest: "x" }))).toBe(409);
  });

  it("refuses without a matching hold, also for another run", async () => {
    // the item is built from one run; the watcher then holds another run
    const mixed = stub([hold(rec("approve_plan", 6, "r1"), SINCE)]);
    const tracked = mixed.watchers.tracked();
    let calls = 0;
    mixed.watchers.tracked = () => (++calls, tracked) as never;
    turnFor(mixed, NOW); // counts how often building the page reads the watchers; the check after it is the next read
    const reads = calls;
    calls = 0;
    mixed.watchers.tracked = () => (++calls <= reads ? tracked : [{ ...tracked[0]!, status: { ...tracked[0]!.status, holds: [hold(rec("approve_plan", 6, "r2"), SINCE)] } }]) as never;
    expect(await status(act(mixed, { key: PKEY, action: "approve", stamp: SINCE, digest: "x" }))).toBe(409);
    expect(comments()).toBe(0);
  });

  it("refuses text with a Foundry marker, and an account name with one", async () => {
    const ctx = ctxAll();
    expect(await status(act(ctx, { key: QKEY, action: "answer", stamp: SINCE, answers: [{ text: "x <!-- claude-factory run=1 -->" }] }))).toBe(400);
    expect(await status(turnAct(ctx, { id: "u", name: "<!-- claude-factory" }, readAct({ key: QKEY, action: "defaults", stamp: SINCE, digest: "x" }), NOW))).toBe(400);
    expect(comments()).toBe(0);
  });

  it("releases the key when posting fails, and the same action works afterwards", async () => {
    const ctx = ctxAll();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect(await status(act(ctx, { key: QKEY, action: "defaults", stamp: SINCE }))).toBe(502);
    expect(kick).not.toHaveBeenCalled();
    expect(turnFor(ctx, NOW).data.continuing).toBeUndefined();
    delete process.env.FAKE_GH_FAIL;
    expect(await status(act(ctx, { key: QKEY, action: "defaults", stamp: SINCE }))).toBe(0);
  });

  it("lets only one of two requests at once through", async () => {
    const ctx = ctxAll();
    const r = await Promise.allSettled([
      act(ctx, { key: PKEY, action: "approve", stamp: SINCE }),
      act(ctx, { key: PKEY, action: "reject", stamp: SINCE, text: "no" }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason.status)).toEqual([409]);
    expect(comments()).toBe(1);
  });

  it("shows the item as waiting again after 10 minutes", async () => {
    const ctx = ctxAll();
    await act(ctx, { key: QKEY, action: "defaults", stamp: SINCE });
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const t = turnFor(ctx, later).data;
    expect(t.continuing).toBeUndefined();
    expect(t.groups.flatMap((g) => g.items).map((i) => i.key)).toContain(QKEY);
    expect(stampOf(ctx, QKEY)).toBe(SINCE);
  });
});

describe("timeouts", () => {
  it("rejects a slow gh call and still answers false for canWrite", async () => {
    process.env.FAKE_GH_SLEEP = "1";
    await expect(repoPermission("acme/app", "x", 50)).rejects.toThrow();
    await expect(setLabels("acme/app", 1, undefined, ["a"], 50)).rejects.toThrow();
    await expect(commentOnIssue("acme/app", 1, "hi", 50)).rejects.toThrow();
    await expect(issueComments("acme/app", 1, 50)).rejects.toThrow();
    delete process.env.FAKE_GH_SLEEP;
    process.env.FAKE_GH_FAIL = "api repos/acme/app/collaborators/x/permission";
    expect(await canWrite("acme/app", "x")).toBe(false);
  });
});

describe("audit log", () => {
  const UID = "11111111-1111-4111-8111-111111111111";
  const auditFile = () => join(dataHome(), "audit.jsonl");
  const auditLines = () => (existsSync(auditFile()) ? readFileSync(auditFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const diag: string[] = [];
  const run = (ctx: ApiContext, body: Record<string, unknown>) => {
    (ctx as { diagLog?: (m: string) => void }).diagLog = (m) => diag.push(m);
    return turnAct(ctx, { id: UID, name: "Marcel K" }, readAct(body), NOW);
  };
  const digestOf = async (ctx: ApiContext, key: string) => (await turnDetail(ctx, key, NOW)).digest;
  beforeEach(() => {
    rmSync(auditFile(), { force: true, recursive: true });
    diag.length = 0;
  });

  it("writes one line per action with owner/repo#issue and no typed text", async () => {
    const ctx = ctxAll();
    await run(ctx, { key: QKEY, action: "answer", stamp: SINCE, digest: await digestOf(ctx, QKEY), answers: [{ n: 1, text: "SECRET-ANSWER" }] });
    const ctx2 = ctxAll();
    await run(ctx2, { key: PKEY, action: "approve", stamp: SINCE, digest: await digestOf(ctx2, PKEY), text: "SECRET-NOTE" });
    const ctx3 = ctxAll();
    await run(ctx3, { key: PKEY, action: "reject", stamp: SINCE, digest: await digestOf(ctx3, PKEY), text: "SECRET-REJECT" });
    const ctx4 = ctxAll();
    await run(ctx4, { key: FKEY, action: "retry_hint", stamp: SINCE, text: "SECRET-HINT" });
    const ctx5 = ctxAll();
    await run(ctx5, { key: FKEY, action: "retry" });
    const ctx6 = ctxAll();
    await run(ctx6, { key: QKEY, action: "defaults", stamp: SINCE, digest: await digestOf(ctx6, QKEY) });
    const lines = auditLines();
    expect(lines.map((l) => [l.action, l.target])).toEqual([
      ["turn-answer", "acme/app#5"],
      ["turn-approve", "acme/app#6"],
      ["turn-reject", "acme/app#6"],
      ["turn-retry", "acme/app#8"],
      ["turn-retry", "acme/app#8"],
      ["turn-answer", "acme/app#5"],
    ]);
    expect(lines.every((l) => l.by === UID && l.result === "ok")).toBe(true);
    expect(readFileSync(auditFile(), "utf8")).not.toMatch(/SECRET/);
  });

  it("writes no line for a refused or failed call", async () => {
    const ctx = ctxAll();
    expect(await status(run(ctx, { key: "nope", action: "retry" }))).toBe(404);
    expect(await status(run(ctx, { key: FKEY, action: "retry", stamp: "old" }))).toBe(409);
    setComments({ body: questionsComment }, { login: "ann", body: "Use Postgres" });
    expect(await status(run(ctx, { key: QKEY, action: "defaults", stamp: SINCE, digest: "x" }))).toBe(409);
    process.env.FAKE_GH_FAIL = "issue edit";
    expect(await status(run(ctxAll(), { key: FKEY, action: "retry" }))).toBe(502);
    expect(auditLines()).toEqual([]);
  });

  it("does not fail the action when the file cannot be written", async () => {
    mkdirSync(auditFile());
    const ctx = ctxAll();
    await run(ctx, { key: QKEY, action: "defaults", stamp: SINCE, digest: await digestOf(ctx, QKEY) });
    expect(diag).toContain("audit: audit.jsonl cannot-write (turn-answer)");
  });
});
