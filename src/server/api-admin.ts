import { CONFIG_PATH, saveConfig } from "../config.js";
import { spentToday } from "../engine/state.js";
import { cleanRuns } from "../clean.js";
import { listEvalReports } from "../evals.js";
import { computeStats } from "../stats.js";
import { HttpError, readJson, send } from "./http.js";
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
      dailyBudget: config.daily_budget_usd,
    }), true;
  }

  if (seg[0] === "config") {
    if (method === "GET") return send(res, 200, ctx.config()), true;
    if (method === "PUT") {
      const body = await readJson(req);
      let saved;
      try {
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
    if (!seg[1] && method === "GET") return send(res, 200, watchers.statuses()), true;
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

  if (seg[0] === "evals" && method === "GET") return send(res, 200, listEvalReports()), true;

  if (seg[0] === "stats" && method === "GET") {
    return send(res, 200, computeStats(scheduler.list(2000))), true;
  }
  return false;
};
