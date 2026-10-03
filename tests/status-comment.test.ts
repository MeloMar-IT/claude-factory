import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { commentId, isBot, isStatusComment, sameBody, STATUS_MARKER, upsertStatusComment } from "../src/github.js";
import { issueRank, issueRecord } from "../src/issue-record.js";
import { firstLine, nextStep, runNextStep, type NextData, type NextStep } from "../src/next-step.js";
import { leftBody, StatusComments, statusBody, statusTargets, type StatusView } from "../src/queue/status-comment.js";
import { toHold, type Hold, type TrackedIssue } from "../src/queue/watcher.js";
import { fakeGithub } from "./helpers/fake-github.js";

const REPO = "acme/app";
const URL7 = `https://github.com/${REPO}/issues/7`;
const base = { repo: REPO, issue: 7, title: "T", runId: "r1" };
const data: NextData = { watched: true, issueUrl: URL7 };

const run = (over: Partial<RunSummary> = {}) =>
  ({
    runId: "r1", flow: "issue-gitflow", task: "do it", status: "succeeded", startedAt: "2026-10-01T08:00:00Z", finishedAt: "2026-10-01T08:10:00Z",
    vars: { github_repo: REPO, issue: "7" }, history: [], totalCostUsd: 0, state: { next: null, steps: {}, visits: {} }, runDir: "/tmp/none", ...over,
  }) as unknown as RunSummary;

const lines = (body: string) => body.split("\n");

describe("statusBody", () => {
  const cases: [string, NextStep][] = [
    ["questions", nextStep("questions", base, { ...data, questions: 2 })],
    ["running", nextStep("running", base, data)],
    ["dependency", nextStep("dependency", base, { ...data, blockers: [{ issue: 3 }] })],
    ["release with a pull request", nextStep("release", base, { ...data, pr: { number: 12, url: "https://github.com/acme/app/pull/12" } })],
    ["release with a time", nextStep("release", base, { ...data, releaseAt: "02:00" })],
    ["closed_elsewhere", nextStep("closed_elsewhere", base, data)],
    ["done", nextStep("done", base, data)],
  ];

  it.each(cases)("%s: first line is the record's, last line the marker, one Where line", (_name, next) => {
    const body = statusBody(next, URL7);
    const l = lines(body);
    expect(l[0]).toBe(firstLine(next));
    expect(l.at(-1)).toBe(STATUS_MARKER);
    expect(l.filter((x) => x.startsWith("- **Where:**"))).toHaveLength(1);
    expect(body.match(/<!--/g)).toHaveLength(1);
    expect(isStatusComment({ body })).toBe(true);
  });

  it("running and done point at this issue", () => {
    expect(statusBody(cases[1]![1], URL7)).toContain("- **Where:** this issue");
    expect(statusBody(cases[6]![1], URL7)).toContain("- **Where:** this issue");
  });

  it("has a Continues line for a dependency and a release time, links a pull request", () => {
    expect(statusBody(cases[2]![1], URL7)).toContain("- **Continues:** after #3");
    expect(statusBody(cases[4]![1], URL7)).toContain("- **Continues:** 02:00 release");
    expect(statusBody(cases[3]![1], URL7)).toContain("- **Where:** [Release pull request #12](https://github.com/acme/app/pull/12)");
    expect(statusBody(cases[1]![1], URL7)).not.toContain("Continues");
  });

  it("names a page of the app instead of linking it", () => {
    const body = statusBody(cases[5]![1], URL7);
    expect(body).toContain("- **Where:** the Run page in the Foundry app (run `r1`)");
    expect(body).not.toContain("#/");
    expect(body).not.toContain("http://localhost");
    expect(statusBody(nextStep("approval", { repo: REPO, issue: 7 }, { watched: true }), URL7)).toContain("- **Where:** the Watchers page in the Foundry app\n");
  });

  it("puts what to do first for a record that needs the reader, and the reason for one that does not", () => {
    const need = statusBody(cases[0]![1], URL7);
    expect(lines(need)[0]).toMatch(/^\*\*What you need to do:\*\* Answer 2 questions\.$/);
    const wait = statusBody(cases[1]![1], URL7);
    expect(lines(wait)[0]).toBe("**Nothing needed from you** — it is being worked on.");
    expect(lines(wait)[2]).toBe("Nothing to do, it continues by itself.");
  });

  it("neutralises hidden comments and mentions in a record's text", () => {
    const next = { ...nextStep("done", base, data), text: "It is done <!-- x --> thanks @bob" };
    const body = statusBody(next, URL7);
    expect(body).not.toContain("<!-- x -->");
    expect(body).not.toContain("@bob");
    expect(body).toContain("@​bob");
  });
});

describe("leftBody", () => {
  it("names the label", () => {
    const body = leftBody("claude-factory");
    expect(body).toContain("`claude-factory`");
    expect(lines(body)[0]).toBe("**Nothing needed from you** — the Foundry no longer follows this issue.");
    expect(lines(body).at(-1)).toBe(STATUS_MARKER);
  });
});

describe("isStatusComment", () => {
  it("is true for both product markers on the last line, and such a comment is ours", () => {
    for (const m of ["<!-- claude-factory status -->", "<!-- spaghetti-code-foundry status -->"]) {
      const c = { body: `text\n\n${m}\n` };
      expect(isStatusComment(c)).toBe(true);
      expect(isBot(c)).toBe(true);
    }
  });
  it("is false for a plan comment that only quotes the marker", () => {
    expect(isStatusComment({ body: `The plan quotes <!-- claude-factory status --> here\n\n<!-- claude-factory run=x plan -->` })).toBe(false);
    expect(isStatusComment({ body: "nothing" })).toBe(false);
  });
});

describe("commentId and sameBody", () => {
  it("reads the id from the comment link", () => {
    expect(commentId("https://github.com/a/b/issues/3#issuecomment-4567")).toBe("4567");
    expect(commentId("https://github.com/a/b/issues/3")).toBeUndefined();
    expect(commentId(undefined)).toBeUndefined();
  });
  it("ignores line ends and trailing white space; no text is never the same", () => {
    expect(sameBody("a\r\nb\r\n", "a\nb")).toBe(true);
    expect(sameBody("a\nb\n\n", "a\nb")).toBe(true);
    expect(sameBody("a", "b")).toBe(false);
    expect(sameBody(undefined, undefined)).toBe(false);
    expect(sameBody("a", undefined)).toBe(false);
  });
});

describe("issueRecord", () => {
  const nextOf = (r: RunSummary) => runNextStep(r, { watched: true });
  const hold = nextStep("questions", base, data);

  it("takes the first source that knows something, in order", () => {
    const r = run({ status: "running" });
    expect(issueRecord({ base, data, run: r, live: true, queuedJob: {}, hold, done: true, nextOf })).toMatchObject({ source: "live", next: { kind: "running" } });
    expect(issueRecord({ base, data, live: false, queuedJob: { waitingFor: "r0" }, hold, done: true, nextOf })).toMatchObject({ source: "queued", next: { kind: "one_at_a_time" } });
    expect(issueRecord({ base, data, live: false, queuedJob: {}, done: true, nextOf }).next.kind).toBe("queued");
    expect(issueRecord({ base, data, run: r, live: false, hold, done: true, nextOf })).toMatchObject({ source: "hold", next: { kind: "questions" } });
    expect(issueRecord({ base, data, run: run(), live: false, done: true, nextOf })).toMatchObject({ source: "run", next: { kind: "done" } });
    expect(issueRecord({ base, data, live: false, done: true, nextOf })).toMatchObject({ source: "done", next: { kind: "done" } });
    expect(issueRecord({ base, data, live: false, nextOf })).toMatchObject({ source: "start", next: { kind: "starting" } });
  });

  it("says restart instead of starting while the server waits to restart", () => {
    expect(issueRecord({ base, data, live: false, restart: true, restartWhy: "new_version", nextOf }).next.kind).toBe("restart");
  });

  it("ranks a live issue first and a done one last", () => {
    expect([issueRank(true, false), issueRank(false, false), issueRank(false, true)]).toEqual([0, 1, 2]);
  });
});

describe("statusTargets", () => {
  const sched = (o: { pending?: unknown[]; active?: string[]; runs?: RunSummary[] } = {}) =>
    ({
      queue: () => ({ pending: o.pending ?? [], active: (o.active ?? []).map((runId) => ({ runId })) }),
      get: (id: string) => o.runs?.find((r) => r.runId === id),
    }) as unknown as StatusView["scheduler"];
  const view = (over: Partial<StatusView> = {}): StatusView => ({
    id: "w", label: "claude-factory", failedLabel: "factory:failed", tracked: [], holds: [], closed: [], complete: true,
    scheduler: sched(), lastRunId: () => undefined, ...over,
  });
  const known = (...n: number[]) => new Map(n.map((x) => [x, { owners: ["w"] }]));
  const t7 = (over: Partial<TrackedIssue> = {}): TrackedIssue => ({ issue: 7, title: "T", ...over });
  const holdOf = (next: NextStep): Hold => toHold(next);
  const only = (list: ReturnType<typeof statusTargets>) => {
    expect(list).toHaveLength(1);
    return list[0]!;
  };

  it("gives a tracked done issue the done text and a comment to create", () => {
    const t = only(statusTargets(REPO, [view({ tracked: [t7({ done: true })] })], new Map(), true));
    expect(t.body).toContain("it is done");
    expect(t).toMatchObject({ create: true, final: false, urgent: false, rank: 2 });
  });

  it("says what the reader must do and writes it first", () => {
    const hold = holdOf(nextStep("questions", base, { ...data, questions: 2 }));
    const t = only(statusTargets(REPO, [view({ tracked: [t7()], holds: [hold] })], new Map(), true));
    expect(t.body).toContain("Answer 2 questions");
    expect(t.urgent).toBe(true);
  });

  it("gives a closed issue with a closed_elsewhere hold that text, without creating a comment", () => {
    const hold = holdOf(nextStep("closed_elsewhere", base, data));
    const v = view({ closed: [{ issue: 7, title: "T" }], holds: [hold], scheduler: sched({ active: ["r1"], runs: [run({ status: "running" })] }), lastRunId: () => "r1" });
    const t = only(statusTargets(REPO, [v], new Map(), true));
    expect(t.body).toContain("Cancel the run if the work is no longer wanted");
    expect(t.create).toBe(false);
    expect(t.final).toBe(false);
  });

  describe("an issue that is gone", () => {
    const gone = (r: RunSummary | undefined, over: Partial<StatusView> = {}) =>
      view({ scheduler: sched({ runs: r ? [r] : [], active: r?.status === "running" ? [r.runId] : [] }), lastRunId: () => r?.runId, ...over });

    it("with a succeeded run gets the final done text", () => {
      const t = only(statusTargets(REPO, [gone(run())], known(7), true));
      expect(t.body).toContain("it is done");
      expect(t).toMatchObject({ final: true, create: false, rank: 3 });
    });
    it("with a succeeded run that waits for the release gets the release text, not final", () => {
      const t = only(statusTargets(REPO, [gone(run(), { releaseAt: () => "02:00" })], known(7), true));
      expect(t.body).toContain("02:00 release");
      expect(t.final).toBe(false);
    });
    it("after a split gets the left text", () => {
      const t = only(statusTargets(REPO, [gone(run({ history: [{ id: "create_split" } as never] }))], known(7), true));
      expect(t.body).toBe(leftBody("claude-factory"));
    });
    it("with a failed run gets the final left text", () => {
      const t = only(statusTargets(REPO, [gone(run({ status: "failed", reason: "boom" }))], known(7), true));
      expect(t).toMatchObject({ body: leftBody("claude-factory"), final: true });
    });
    it("with a live run gets the working text, not final", () => {
      const t = only(statusTargets(REPO, [gone(run({ status: "running" }))], known(7), true));
      expect(t.body).toContain("it is being worked on");
      expect(t).toMatchObject({ final: false, rank: 0 });
    });
    it("is left alone unless every list was whole", () => {
      expect(statusTargets(REPO, [gone(run())], known(7), false)).toEqual([]);
    });
    it("owned by the second view only names the second view's label", () => {
      const a = view({ id: "a", label: "plan-label" });
      const b = view({ id: "b", label: "code-label" });
      const t = only(statusTargets(REPO, [a, b], new Map([[7, { owners: ["b"] }]]), true));
      expect(t.body).toBe(leftBody("code-label"));
    });
  });

  it("says running for a live run that has no file yet", () => {
    const v = view({ tracked: [t7({ runId: "r9" })], scheduler: sched({ active: ["r9"] }) });
    expect(only(statusTargets(REPO, [v], new Map(), true)).body).toContain("it is being worked on");
  });

  it("picks one text per issue: live beats the rest, a hold beats done, the first view wins a tie", () => {
    const live = view({ id: "a", tracked: [t7({ runId: "r1" })], scheduler: sched({ active: ["r1"], runs: [run({ status: "running" })] }) });
    const done = view({ id: "b", tracked: [t7({ done: true })] });
    expect(only(statusTargets(REPO, [done, live], new Map(), true)).body).toContain("it is being worked on");
    const held = view({ id: "c", tracked: [t7()], holds: [holdOf(nextStep("questions", base, { ...data, questions: 2 }))] });
    expect(only(statusTargets(REPO, [done, held], new Map(), true)).body).toContain("Answer 2 questions");
    const h3 = view({ id: "d", tracked: [t7()], holds: [holdOf(nextStep("questions", base, { ...data, questions: 3 }))] });
    expect(only(statusTargets(REPO, [held, h3], new Map(), true)).body).toContain("Answer 2 questions");
    expect(only(statusTargets(REPO, [h3, held], new Map(), true)).body).toContain("Answer 3 questions");
  });

  describe("in words for a user", () => {
    it("keeps a folder out of a failure and sends the reader to the administrator", () => {
      const failed = run({ status: "failed", reason: 'workspace "/Users/me/private" is gone' });
      const hold = holdOf(runNextStep(failed, { watched: true, failedLabel: "factory:failed" }));
      expect(hold.next.kind).toBe("failed");
      for (const holds of [[hold], []]) {
        const v = view({ tracked: [t7({ runId: "r1" })], holds, scheduler: sched({ runs: [failed] }) });
        const body = only(statusTargets(REPO, [v], new Map(), true)).body;
        expect(body).not.toContain("/Users/me");
        expect(body).toContain("The Foundry failed, not the code");
        expect(body).toContain("ask the administrator");
      }
    });

    it("names the administrator's limit, not the budget", () => {
      const hold = holdOf(nextStep("daily_budget", base, data));
      const body = only(statusTargets(REPO, [view({ tracked: [t7()], holds: [hold] })], new Map(), true)).body;
      expect(body).toContain("the administrator's limit was reached");
      expect(body).not.toMatch(/budget/i);
    });

    it("does not tell the reader to sign in to the agent", () => {
      const stopped = run({ status: "stopped", reason: "signed out — run Codex login again" });
      const v = view({ tracked: [t7({ runId: "r1" })], scheduler: sched({ runs: [stopped] }) });
      const body = only(statusTargets(REPO, [v], new Map(), true)).body;
      expect(body).toContain("signed out of its AI account");
      expect(body).not.toMatch(/codex login|\/login/i);
    });

    it("keeps a failed hold of a cancelled run a failed record", () => {
      const hold = holdOf(nextStep("failed", base, { ...data, failedLabel: "factory:failed", reason: "boom" }));
      const v = view({ tracked: [t7({ runId: "r1" })], holds: [hold], scheduler: sched({ runs: [run({ status: "cancelled" })] }) });
      expect(only(statusTargets(REPO, [v], new Map(), true)).body).toContain("label to start over");
    });
  });
});

describe("with the fake gh", () => {
  let gh: ReturnType<typeof fakeGithub>;
  beforeEach(() => {
    gh = fakeGithub();
  });
  afterEach(() => gh.restore());

  const ours = (id: number, over: Record<string, unknown> = {}) => ({
    author: { login: "bot" }, body: `old ${id}\n\n${STATUS_MARKER}`, createdAt: `2026-01-01T00:0${id % 10}:00Z`,
    url: `https://github.com/${REPO}/issues/3#issuecomment-${id}`, viewerDidAuthor: true, ...over,
  });
  const setComments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const calls = (re: RegExp) => gh.ghLog().split("\n").filter((l) => re.test(l));
  const BODY = `new text\n\n${STATUS_MARKER}`;

  it("the helper keeps a comment that only quotes the status marker, whole", async () => {
    const { commentOnIssue } = await import("../src/github.js");
    await commentOnIssue(REPO, 3, `plan quotes ${STATUS_MARKER} here\n\nmore text\n<!-- claude-factory run=x plan -->`);
    await commentOnIssue(REPO, 3, BODY_FOR_HELPER);
    expect(gh.comments()).toHaveLength(1);
    expect(gh.comments()[0]!.body).toContain("more text");
    expect(gh.statusComments()).toHaveLength(1);
  });
  const BODY_FOR_HELPER = `status\n\n${STATUS_MARKER}`;

  describe("upsertStatusComment", () => {
    it("does not edit a plan comment that quotes the marker, and creates a status comment", async () => {
      setComments({ ...ours(5), body: `plan quotes ${STATUS_MARKER} here\n\n<!-- claude-factory run=x plan -->` });
      const r = await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(r).toMatchObject({ changed: true, created: true, id: "1" });
      expect(gh.statusEdits()).toEqual([]);
      expect(gh.statusComments()).toHaveLength(1);
    });

    it("without viewerDidAuthor, compares the author with the gh login (one api user call)", async () => {
      process.env.FAKE_GH_LOGIN = "bot";
      setComments(ours(5, { viewerDidAuthor: undefined }), ours(6, { viewerDidAuthor: undefined }));
      const r = await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(r).toMatchObject({ id: "5", changed: true, removed: 1 });
      expect(gh.statusEdits().map((e) => e.id)).toEqual(["5"]);
      expect(calls(/^gh api user/)).toHaveLength(1);
    });

    it("without viewerDidAuthor, leaves another author's comment alone and creates a new one", async () => {
      process.env.FAKE_GH_LOGIN = "bot";
      setComments(ours(5, { viewerDidAuthor: undefined, author: { login: "mallory" } }));
      await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(gh.statusEdits()).toEqual([]);
      expect(gh.statusComments()).toHaveLength(1);
    });

    it("creates a new comment when viewerDidAuthor is false", async () => {
      setComments(ours(5, { viewerDidAuthor: false }));
      await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(gh.statusEdits()).toEqual([]);
      expect(gh.statusComments()).toHaveLength(1);
    });

    it("edits the first of ours, deletes the second and leaves another account's alone", async () => {
      setComments(ours(1), ours(2), ours(3, { viewerDidAuthor: false }));
      const r = await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(r).toMatchObject({ id: "1", removed: 1, left: 0 });
      expect(gh.statusEdits().map((e) => e.id)).toEqual(["1"]);
      expect(gh.statusDeletes()).toEqual(["2"]);
    });

    it("deletes at most five extras", async () => {
      setComments(...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ours(i)));
      const r = await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(r).toMatchObject({ id: "1", removed: 5, left: 2 });
      expect(gh.statusDeletes()).toHaveLength(5);
    });

    it("does not write when the text is the same", async () => {
      setComments(ours(1, { body: BODY }));
      const r = await upsertStatusComment(REPO, 3, BODY, { create: true });
      expect(r).toMatchObject({ id: "1", changed: false });
      expect(gh.statusEdits()).toEqual([]);
    });

    it("rejects for a comment of ours without a link, and creates nothing", async () => {
      setComments(ours(1, { url: undefined }));
      await expect(upsertStatusComment(REPO, 3, BODY, { create: true })).rejects.toThrow(/no link/);
      expect(gh.statusComments()).toEqual([]);
    });

    it("writes nothing when create is false and there is no comment", async () => {
      setComments();
      expect(await upsertStatusComment(REPO, 3, BODY, { create: false })).toMatchObject({ changed: false });
      expect(calls(/issue comment|api repos/)).toEqual([]);
    });

    it("edits a known id without reading the issue", async () => {
      expect(await upsertStatusComment(REPO, 3, BODY, { create: false, id: "42" })).toMatchObject({ id: "42", changed: true });
      expect(calls(/issue view/)).toEqual([]);
      expect(gh.statusEdits()).toEqual([{ id: "42", body: BODY }]);
    });

    it("rejects with out of time, without a call, after the deadline", async () => {
      await expect(upsertStatusComment(REPO, 3, BODY, { create: true, deadline: Date.now() - 1 })).rejects.toThrow(/out of time/);
      expect(gh.ghLog()).toBe("");
    });

    it("sends the edit text through stdin, not in the arguments", async () => {
      setComments(ours(1));
      await upsertStatusComment(REPO, 3, "secretive words\n\n" + STATUS_MARKER, { create: true });
      expect(gh.statusEdits()[0]!.body).toContain("secretive words");
      expect(calls(/^gh /).join("\n")).not.toContain("secretive");
    });
  });

  describe("StatusComments", () => {
    let log: string[];
    beforeEach(() => {
      log = [];
      setComments();
    });
    const sched = { queue: () => ({ pending: [], active: [] }), get: () => undefined } as unknown as StatusView["scheduler"];
    const doneView = (nums: number[], over: Partial<StatusView> = {}): StatusView => ({
      id: "w", label: "claude-factory", failedLabel: "factory:failed",
      tracked: nums.map((issue) => ({ issue, title: "T", done: true })), holds: [], closed: [], complete: true,
      scheduler: sched, lastRunId: () => undefined, ...over,
    } as StatusView);
    const make = (o: { file?: string; maxMs?: number } = {}) => {
      const sc = new StatusComments(REPO, (m) => log.push(m), o);
      sc.expect("w");
      return sc;
    };
    const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

    it("handles 30 issues per pass and the rest at the next one", async () => {
      const sc = make();
      await sc.report("w", doneView(nums(35)));
      expect(gh.statusComments()).toHaveLength(30);
      expect(log).toContain("status comments: 5 more at the next check");
      await sc.report("w", doneView(nums(35)));
      expect(gh.statusComments()).toHaveLength(35);
    });

    it("stops after three failures", async () => {
      process.env.FAKE_GH_FAIL = "issue comment";
      const sc = make();
      await sc.report("w", doneView(nums(10)));
      expect(log.filter((l) => l.startsWith("! status comment #"))).toHaveLength(3);
      expect(log).toContain("status comments: 7 more at the next check");
    });

    it("ends a pass at its time limit without calling that a failure", async () => {
      process.env.FAKE_GH_SLEEP = "2";
      const sc = make({ maxMs: 500 });
      await sc.report("w", doneView([1, 2]));
      expect(log.some((l) => /more at the next check/.test(l))).toBe(true);
      expect(log.some((l) => l.startsWith("! status comment"))).toBe(false);
    });

    it("reads the issue again after an extra comment could not be removed, when the text changes", async () => {
      setComments(...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ours(i)));
      const sc = make();
      await sc.report("w", doneView([3]));
      expect(log.some((l) => /! status comment #3: 2 extra could not be removed/.test(l))).toBe(true);
      expect(calls(/issue view 3/)).toHaveLength(1);
      await sc.report("w", doneView([3], { tracked: [{ issue: 3, title: "T" }] })); // another text: "starting"
      expect(calls(/issue view 3/)).toHaveLength(2);
    });

    it("retries the removal of extra comments at the next check, even when the text is the same", async () => {
      setComments(...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ours(i)));
      const sc = make();
      await sc.report("w", doneView([3]));
      expect(gh.statusDeletes()).toHaveLength(5);
      await sc.report("w", doneView([3]));
      expect(calls(/issue view 3/)).toHaveLength(2);
      expect(gh.statusDeletes()).toHaveLength(10); // the fake keeps returning all eight
    });

    it("ignores a report from a watcher that was stopped meanwhile", async () => {
      const sc = make();
      await sc.report("w", doneView([4]), () => false);
      expect(gh.ghLog()).toBe("");
    });

    it("keeps watcher ids that are names of object properties", async () => {
      const file = join(gh.tmp, "data", "status-comments.json");
      const sc = new StatusComments(REPO, (m) => log.push(m), { file });
      for (const id of ["constructor", "toString", "__proto__"]) {
        sc.expect(id);
        await sc.report(id, doneView([id.length], { id }));
      }
      expect(log.filter((l) => l.startsWith("!"))).toEqual([]);
      const owners = Object.keys(JSON.parse(readFileSync(file, "utf8"))[REPO]);
      expect(owners.sort()).toEqual(["__proto__", "constructor", "toString"]);
      expect(() => new StatusComments(REPO, () => {}, { file })).not.toThrow();
    });

    it("makes no call for the same view again, and one comment for two reports at once", async () => {
      const sc = make();
      await Promise.all([sc.report("w", doneView([4])), sc.report("w", doneView([4]))]);
      expect(gh.statusComments()).toHaveLength(1);
      const before = gh.ghLog();
      await sc.report("w", doneView([4]));
      expect(gh.ghLog()).toBe(before);
    });

    it("drops the id after a failed edit, so the next check reads again", async () => {
      const sc = make();
      await sc.report("w", doneView([4]));
      process.env.FAKE_GH_FAIL = `api repos/${REPO}/issues/comments/1`;
      await sc.report("w", doneView([4], { tracked: [{ issue: 4, title: "T" }] }));
      expect(log.some((l) => l.startsWith("! status comment #4:"))).toBe(true);
      delete process.env.FAKE_GH_FAIL;
      setComments(ours(1, { url: `https://github.com/${REPO}/issues/4#issuecomment-1` }));
      await sc.report("w", doneView([4], { tracked: [{ issue: 4, title: "T" }] }));
      expect(calls(/issue view 4/)).toHaveLength(2); // the first create, and the read after the failed edit
      expect(gh.statusEdits().at(-1)!.id).toBe("1");
    });

    describe("the file", () => {
      let file: string;
      beforeEach(() => {
        file = join(gh.tmp, "data", "status-comments.json");
      });
      const read = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, number[]>>;
      const wait = () => new Promise((r) => setTimeout(r, 30));

      it("lists the issue under its watcher after a write, and a new object knows it", async () => {
        await make({ file }).report("w", doneView([7]));
        expect(read()).toEqual({ [REPO]: { w: [7] } });
        // the new object knows 7 although it is not in any list: its last text is written
        setComments(ours(77, { url: `https://github.com/${REPO}/issues/7#issuecomment-77` }));
        const again = make({ file });
        await again.report("w", doneView([]));
        expect(gh.statusEdits()).toEqual([{ id: "77", body: expect.stringContaining("no longer follows") }]);
        expect(existsSync(file) ? read()[REPO] : undefined).toBeUndefined(); // a final write removes it
      });

      it("is cleared by forget", async () => {
        const sc = make({ file });
        await sc.report("w", doneView([7]));
        sc.forget("w");
        await wait();
        expect(read()[REPO]).toBeUndefined();
      });

      it("keeps the entries of two repositories in one file", async () => {
        const other = new StatusComments("acme/other", (m) => log.push(m), { file });
        other.expect("o");
        await make({ file }).report("w", doneView([7]));
        await other.report("o", doneView([9], { id: "o" }));
        expect(read()).toEqual({ [REPO]: { w: [7] }, "acme/other": { o: [9] } });
        const again = new StatusComments("acme/other", () => {}, { file });
        again.expect("o");
        await again.report("o", doneView([], { id: "o" }));
        expect(read()[REPO]).toEqual({ w: [7] });
      });

      it("reads a broken file as empty", async () => {
        mkdirSync(join(gh.tmp, "data"), { recursive: true });
        writeFileSync(file, JSON.stringify({ [REPO]: { w: "nope" } }));
        const sc = make({ file });
        await sc.report("w", doneView([]));
        expect(gh.ghLog()).toBe("");
      });

      it("drops a watcher that is not expected any more without an edit", async () => {
        mkdirSync(join(gh.tmp, "data"), { recursive: true });
        writeFileSync(file, JSON.stringify({ [REPO]: { a: [7], b: [9] } }));
        setComments(ours(99, { url: `https://github.com/${REPO}/issues/9#issuecomment-99` }));
        const sc = new StatusComments(REPO, (m) => log.push(m), { file });
        sc.expect("b");
        await sc.report("b", doneView([], { id: "b" }));
        expect(gh.statusEdits()).toEqual([{ id: "99", body: expect.stringContaining("no longer follows") }]);
        expect(calls(/issue view 7/)).toEqual([]);
        expect(existsSync(file) ? read()[REPO] : undefined).toBeUndefined();
      });

      it("gives no final text while an expected watcher has not reported", async () => {
        mkdirSync(join(gh.tmp, "data"), { recursive: true });
        writeFileSync(file, JSON.stringify({ [REPO]: { a: [7], b: [9] } }));
        const sc = new StatusComments(REPO, (m) => log.push(m), { file });
        sc.expect("a");
        sc.expect("b");
        await sc.report("b", doneView([], { id: "b" }));
        expect(gh.ghLog()).toBe("");
        expect(read()[REPO]).toEqual({ a: [7], b: [9] });
        sc.expect("a"); // a new watcher object of the same id drops the old view
        await sc.report("b", doneView([], { id: "b" }));
        expect(gh.ghLog()).toBe("");
      });
    });
  });
});
