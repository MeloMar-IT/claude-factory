import { existsSync, readFileSync } from "node:fs";
import { CANNOT_READ, redactedJson } from "../credentials/redact.js";
import { supersededRuns } from "../stats.js";
import { resolve } from "node:path";
import { runDiff } from "../engine/diff.js";
import { readTranscript } from "../engine/transcript.js";
import { ownsRepo } from "../auth/repos.js";
import { ownerNames } from "../auth/run-owner.js";
import { effectiveVars } from "../engine/runner.js";
import type { RunSummary } from "../engine/state.js";
import { parseFlow, resolveFlowPath } from "../flow/load.js";
import { isPublished, userVars } from "../flow/publish.js";
import { isVarName, type Flow } from "../flow/schema.js";
import { guardedRepos } from "./api-repos.js";
import { publishedFlows } from "./permissions.js";
import { HttpError, NAME_RE, readJson, send, str } from "./http.js";
import { hideForeign, nextFor, ownQueue, ownRecord, queueWithNext } from "./next.js";
import { hidePaths, userLogLine, userRecord, userRun } from "./user-view.js";
import type { NextStep } from "../next-step.js";
import type { RunEvent } from "../queue/scheduler.js";
import type { Route } from "./server.js";

const NEXT_RECHECK_MS = 2_000;


export const runRoutes: Route = async (ctx, req, res, seg, method, user) => {
  const { opts, scheduler } = ctx;
  const admin = user.role === "admin";
  // What a user sees of a record: another account's run is not named in it.
  const mine = (rid: string) => scheduler.ownerOf(rid) === user.id;
  const view = admin ? (n: NextStep) => n : (n: NextStep) => userRecord(ownRecord(n, mine));
  // What a user sees of a run: no costs and no setup (see user-view.ts).
  const shape: (r: RunSummary & { next?: NextStep; superseded?: boolean; ownerName?: string }) => unknown = admin ? (r) => r : userRun;
  const hide = <T,>(v: T): T => (admin ? v : hideForeign(v, mine));
  if (seg[0] === "queue" && method === "GET") return send(res, 200, admin ? queueWithNext(ctx) : ownQueue(ctx, user.id)), true;
  if (seg[0] === "run-owners" && !seg[1] && method === "GET") {
    const counts = new Map<string, number>();
    for (const b of scheduler.briefs()) if (b.owner) counts.set(b.owner, (counts.get(b.owner) ?? 0) + 1);
    const names = ownerNames();
    const owners = [...counts].map(([oid, runs]) => ({ id: oid, name: names.get(oid) ?? "deleted account", runs }));
    return send(res, 200, owners.sort((a, b) => a.name.localeCompare(b.name))), true;
  }
  if (seg[0] !== "runs") return false;
  const id = seg[1];

  if (!id && method === "GET") {
    let ownerParam: string | undefined;
    if (admin) {
      const o = new URL(req.url ?? "/", "http://x").searchParams.get("owner");
      if (o !== null) {
        if (!NAME_RE.test(o) || o.length > 64) throw new HttpError(400, "invalid owner");
        ownerParam = o;
      }
    }
    const want = admin ? ownerParam : user.id;
    const runs = want
      // Loaded by folder name; the runId and owner inside the file must agree, else the run is left out.
      ? scheduler.briefs().filter((b) => b.owner === want).slice(0, 200).map((b) => ({ dir: b.dirName, s: scheduler.get(b.dirName) })).filter((x): x is { dir: string; s: RunSummary } => !!x.s && x.s.runId === x.dir && x.s.owner === want).map((x) => x.s)
      : scheduler.list(200);
    const replaced = supersededRuns(runs);
    const next = nextFor(ctx, runs, !admin);
    const names = admin ? ownerNames() : undefined;
    return send(res, 200, runs.map((r) => hide(shape({
      ...r,
      ...(replaced.has(r.runId) ? { superseded: true } : {}),
      ...(names && r.owner ? { ownerName: names.get(r.owner) ?? "deleted account" } : {}),
      next: view(next(r)),
    })))), true;
  }
  if (!id && method === "POST") {
    const body = await readJson(req);
    // What a user may never do is refused first, before any other field is looked at.
    if (!admin) {
      if (body.yaml !== undefined) throw new HttpError(403, "only an admin can run a flow that is not saved");
      if (body.repo !== undefined && body.repo !== null && body.repo !== "") throw new HttpError(403, "only an admin can choose the folder");
    }
    const task = str(body, "task", false).trim();
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries((body.vars as Record<string, unknown>) ?? {})) {
      if (!isVarName(k) || typeof v !== "string") throw new HttpError(400, `invalid var "${k}"`);
      vars[k] = v;
    }
    let flow: Flow;
    let repo: string;
    let runVars = vars;
    if (admin) {
      repo = resolve(str(body, "repo", false) || opts.repo);
      if (!existsSync(repo)) throw new HttpError(400, `repo not found: ${repo}`);
      flow = typeof body.yaml === "string"
        ? parseFlow(body.yaml)
        : parseFlow(readFileSync(resolveFlowPath(str(body, "flow"), opts.repo), "utf8"));
    } else {
      // A user starts a published, saved flow in the server's default folder, on one of their own repositories.
      const name = str(body, "flow");
      if (!NAME_RE.test(name)) throw new HttpError(400, "invalid flow name");
      const listing = publishedFlows(opts.repo).find((f) => f.name === name);
      if (!listing) throw new HttpError(404, "flow not found");
      try {
        flow = parseFlow(readFileSync(listing.path, "utf8"), listing.path);
      } catch {
        throw new HttpError(404, "flow not found"); // the message of a failure holds a file path
      }
      if (!isPublished(flow)) throw new HttpError(404, "flow not found");
      repo = resolve(opts.repo);
      if (!existsSync(repo)) throw new HttpError(400, "the server's folder was not found");
      // The folder's own settings are read now and kept with the job; the user may fill in the published inputs only.
      const set = userVars(flow, effectiveVars(flow, repo, {}, (m) => opts.log?.(m)), vars);
      if (!set.ok) throw new HttpError(set.status, set.error);
      runVars = set.vars;
      const given = vars.github_repo;
      if (given === undefined) {
        // A repository from the flow or the folder is fine only when it is one of the user's own.
        const dflt = runVars.github_repo;
        if (dflt !== undefined && !guardedRepos(ctx, () => ownsRepo(user.id, dflt))) {
          const input = flow.publish?.vars.github_repo?.mode === "input";
          throw new HttpError(403, input ? 'set the var "github_repo" to one of your repositories' : "this flow works on a repository that is not one of yours");
        }
      } else if (given === "" || given.toLowerCase() === "owner/repo") {
        throw new HttpError(403, 'set the var "github_repo" to one of your repositories');
      } else if (!guardedRepos(ctx, () => ownsRepo(user.id, given))) {
        throw new HttpError(403, `"${given}" is not one of your repositories`);
      }
    }
    const lockKey = runVars.github_repo && (runVars.issue || runVars.pr) ? `${runVars.github_repo}#${runVars.issue || runVars.pr}` : undefined;
    const runId = scheduler.submit(
      { kind: "run", flow, task, repo, vars: runVars, ...(admin ? {} : { frozenVars: true }) },
      { lockKey, source: "ui", owner: user.id, queuedBy: user.id },
    );
    return send(res, 201, { runId, queued: scheduler.isQueued(runId) }), true;
  }

  if (!id || !/^[\w-]+$/.test(id)) throw new HttpError(400, "invalid run id");
  const action = seg[2];

  if (action === "cancel" && method === "POST") return send(res, 200, { cancelled: scheduler.cancel(id) }), true;

  if ((action === "resume" || action === "approve" || action === "reject") && method === "POST") {
    const body = await readJson(req);
    const s = scheduler.get(id);
    if (!s) throw new HttpError(404, "run not found");
    if (action !== "resume" && s.status !== "waiting") throw new HttpError(409, "run is not waiting for approval");
    const from = str(body, "from", false) || undefined;
    const vars = s.vars ?? {};
    const lockKey = vars.github_repo && (vars.issue || vars.pr) ? `${vars.github_repo}#${vars.issue || vars.pr}` : undefined;
    // The same answer for both roles; any other failure of submit is unexpected (and generic for a user).
    if (scheduler.isActive(id) || scheduler.isQueued(id)) throw new HttpError(400, `run ${id} is already queued or running`);
    scheduler.submit(
      action === "resume"
        ? { kind: "resume", runId: id, from }
        : { kind: "resume", runId: id, decision: { approved: action === "approve", by: "ui", note: str(body, "note", false) || undefined } },
      { lockKey, source: `ui ${action}`, queuedBy: user.id },
    );
    return send(res, 202, { runId: id }), true;
  }

  if (action === "events" && method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    // What a viewer sees of the record, sent last.
    const shown = (n: NextStep) => [n.text, n.until, n.timing?.progress, n.timing?.estimate, n.timing?.note].join("\n");
    let last = "";
    // The folders of the run, to take out of what a user reads.
    let known = admin ? undefined : scheduler.get(id);
    const write = (e: RunEvent) => {
      let out: unknown = e;
      if (e.type === "update") {
        known = admin ? undefined : e.summary;
        const next = view(nextFor(ctx, undefined, !admin)(e.summary));
        last = shown(next);
        out = { type: "update", summary: shape({ ...e.summary, next }) };
      } else if (!admin) {
        const line = userLogLine(e.line);
        if (line === undefined) return;
        out = { type: "log", line: hidePaths(line, known) };
      }
      const data = redactedJson(hide(out));
      if (data === undefined) return void res.write(`event: log\ndata: ${JSON.stringify({ type: "log", line: CANNOT_READ })}\n\n`);
      res.write(`event: ${e.type}\ndata: ${data}\n\n`);
    };
    const unsubscribe = scheduler.subscribe(id, write);
    // A wait for a code area shows up in the step log only, without an update event: look again now and then.
    const recheck = setInterval(() => {
      const s = scheduler.get(id);
      if (s?.status === "running" && shown(view(nextFor(ctx, undefined, !admin)(s))) !== last) write({ type: "update", summary: s });
    }, NEXT_RECHECK_MS);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clearInterval(recheck);
      unsubscribe();
    });
    return true;
  }

  const s = scheduler.get(id);
  if (!s) throw new HttpError(404, "run not found");
  if (!action && method === "GET") return send(res, 200, hide(shape({ ...s, next: view(nextFor(ctx, undefined, !admin)(s)) }))), true;
  if (action === "diff" && method === "GET") return send(res, 200, runDiff(s)), true;
  if (action === "transcript" && method === "GET") {
    const n = Number(seg[3]);
    const rec = s.history[n];
    if (!Number.isInteger(n) || !rec) throw new HttpError(404, "no such step");
    if (!rec.logFile.startsWith(s.runDir)) throw new HttpError(400, "bad log path");
    return send(res, 200, hide({ step: rec.id, type: rec.type, events: readTranscript(rec.logFile) })), true;
  }
  return false;
};
