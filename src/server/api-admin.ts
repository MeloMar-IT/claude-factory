import { agentStatuses, providerStatuses, testSpec } from "../agents/health.js";
import { watcherOwnerProblem } from "../auth/run-owner.js";
import { hasAdmin } from "../auth/users.js";
import { CONFIG_PATH, ConfigSchema, saveConfig } from "../config.js";
import { spentToday } from "../engine/state.js";
import { cleanRuns } from "../clean.js";
import { listEvalReports } from "../evals.js";
import { clickThrough } from "../notify.js";
import { computeStats } from "../stats.js";
import { HttpError, readJson, send } from "./http.js";
import { hostAllowed, listenCovers, listenProblem } from "./net.js";
import { watchersWithNext } from "./next.js";
import type { Route } from "./server.js";

export const adminRoutes: Route = async (ctx, req, res, seg, method) => {
  const { opts, scheduler, watchers } = ctx;

  if (seg[0] === "info" && method === "GET") {
    const config = ctx.config();
    return send(res, 200, {
      repo: opts.repo,
      runsDir: opts.runsDir,
      configPath: CONFIG_PATH(),
      spentToday: spentToday(opts.runsDir),
      dailyBudget: config.cost_limits ? config.daily_budget_usd : undefined,
      costLimits: config.cost_limits,
      listening: ctx.listen,
      clickThrough: process.platform === "darwin" ? clickThrough() : undefined,
    }), true;
  }

  if (seg[0] === "config") {
    if (method === "GET") return send(res, 200, ctx.config()), true;
    if (method === "PUT") {
      const body = await readJson(req);
      let saved;
      try {
        // Do not let a change shut out the browser that sends it (or the proxy it comes through).
        const parsed = ConfigSchema.parse(body);
        const next = parsed.server;
        if (!hostAllowed(req.headers.host, next.allowed_hosts, opts.port)) {
          throw new Error(`allowed_hosts must keep "${req.headers.host}", the name you are using now`);
        }
        if (!listenCovers(next.listen, req.socket.localAddress)) {
          throw new Error(`listen "${next.listen}" would not answer on ${req.socket.localAddress}, where you are connected`);
        }
        const problem = listenProblem(next.listen, hasAdmin);
        if (problem) throw new Error(problem);
        const bad = watcherOwnerProblem(parsed.watchers, ctx.config().watchers);
        if (bad) throw new Error(bad);
        saved = saveConfig(body);
      } catch (e) {
        throw new HttpError(400, `invalid config: ${(e as Error).message}`);
      }
      ctx.reloadConfig();
      watchers.sync();
      return send(res, 200, saved), true;
    }
  }

  if (seg[0] === "watchers") {
    if (!seg[1] && method === "GET") return send(res, 200, watchersWithNext(ctx)), true;
    if (seg[1] && seg[2] === "tick" && method === "POST") return send(res, 200, await watchers.runNow(seg[1])), true;
  }

  if (seg[0] === "clean" && method === "POST") {
    const body = await readJson(req);
    const days = Number(body.olderThanDays ?? 7);
    if (!(days >= 0)) throw new HttpError(400, "olderThanDays must be >= 0");
    return send(res, 200, cleanRuns({
      runsDir: opts.runsDir,
      olderThanDays: days,
      purge: body.purge === true,
      includePaused: body.includePaused === true,
      dryRun: body.dryRun !== false,
      isActive: (id) => scheduler.isActive(id) || scheduler.isQueued(id),
    })), true;
  }

  if (seg[0] === "providers" && method === "GET") {
    const [agents, providers] = await Promise.all([agentStatuses(), providerStatuses(ctx.config())]);
    return send(res, 200, { agents, providers }), true;
  }

  if (seg[0] === "providers" && seg[1] === "test" && method === "POST") {
    const body = await readJson(req);
    if (typeof body.spec !== "string" || !body.spec.trim() || body.spec.length > 200) throw new HttpError(400, "spec required");
    try {
      return send(res, 200, await testSpec(body.spec, ctx.config(), { claudeBin: opts.claudeBin })), true;
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  if (seg[0] === "evals" && method === "GET") return send(res, 200, listEvalReports()), true;

  if (seg[0] === "stats" && method === "GET") {
    return send(res, 200, computeStats(scheduler.list(2000))), true;
  }
  return false;
};
