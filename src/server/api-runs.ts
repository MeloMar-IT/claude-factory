import { existsSync, readFileSync } from "node:fs";
import { supersededRuns } from "../stats.js";
import { resolve } from "node:path";
import { runDiff } from "../engine/diff.js";
import { readTranscript } from "../engine/transcript.js";
import { parseFlow, resolveFlowPath } from "../flow/load.js";
import { HttpError, NAME_RE, readJson, send, str } from "./http.js";
import { nextFor } from "./next.js";
import type { RunEvent } from "../queue/scheduler.js";
import type { Route } from "./server.js";

const NEXT_RECHECK_MS = 2_000;

export const runRoutes: Route = async (ctx, req, res, seg, method) => {
  const { opts, scheduler } = ctx;
  if (seg[0] === "queue" && method === "GET") return send(res, 200, scheduler.queue()), true;
  if (seg[0] !== "runs") return false;
  const id = seg[1];

  if (!id && method === "GET") {
    const runs = scheduler.list(200);
    const replaced = supersededRuns(runs);
    const next = nextFor(ctx, runs);
    return send(res, 200, runs.map((r) => ({ ...r, ...(replaced.has(r.runId) ? { superseded: true } : {}), next: next(r) }))), true;
  }
  if (!id && method === "POST") {
    const body = await readJson(req);
    const task = str(body, "task", false).trim();
    const repo = resolve(str(body, "repo", false) || opts.repo);
    if (!existsSync(repo)) throw new HttpError(400, `repo not found: ${repo}`);
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries((body.vars as Record<string, unknown>) ?? {})) {
      if (!NAME_RE.test(k) || typeof v !== "string") throw new HttpError(400, `invalid var "${k}"`);
      vars[k] = v;
    }
    const flow = typeof body.yaml === "string"
      ? parseFlow(body.yaml)
      : parseFlow(readFileSync(resolveFlowPath(str(body, "flow"), opts.repo), "utf8"));
    const lockKey = vars.github_repo && (vars.issue || vars.pr) ? `${vars.github_repo}#${vars.issue || vars.pr}` : undefined;
    const runId = scheduler.submit({ kind: "run", flow, task, repo, vars }, { lockKey, source: "ui" });
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
    scheduler.submit(
      action === "resume"
        ? { kind: "resume", runId: id, from }
        : { kind: "resume", runId: id, decision: { approved: action === "approve", by: "ui", note: str(body, "note", false) || undefined } },
      { lockKey, source: `ui ${action}` },
    );
    return send(res, 202, { runId: id }), true;
  }

  if (action === "events" && method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    let last = ""; // text of the record sent last
    const write = (e: RunEvent) => {
      let out: unknown = e;
      if (e.type === "update") {
        const next = nextFor(ctx)(e.summary);
        last = next.text;
        out = { ...e, summary: { ...e.summary, next } };
      }
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(out)}\n\n`);
    };
    const unsubscribe = scheduler.subscribe(id, write);
    // A wait for a code area shows up in the step log only, without an update event: look again now and then.
    const recheck = setInterval(() => {
      const s = scheduler.get(id);
      if (s?.status === "running" && nextFor(ctx)(s).text !== last) write({ type: "update", summary: s });
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
  if (!action && method === "GET") return send(res, 200, { ...s, next: nextFor(ctx)(s) }), true;
  if (action === "diff" && method === "GET") return send(res, 200, runDiff(s)), true;
  if (action === "transcript" && method === "GET") {
    const n = Number(seg[3]);
    const rec = s.history[n];
    if (!Number.isInteger(n) || !rec) throw new HttpError(404, "no such step");
    if (!rec.logFile.startsWith(s.runDir)) throw new HttpError(400, "bad log path");
    return send(res, 200, { step: rec.id, type: rec.type, events: readTranscript(rec.logFile) }), true;
  }
  return false;
};
