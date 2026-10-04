import { breakerWhy, currentState, describeEntry, switchStories, type StoriesState } from "../monitor/guard.js";
import { HttpError, send } from "./http.js";
import type { ApiContext, Route } from "./server.js";

/** The state as the card shows it. `reportTo` is false when no repository is set for the stories. */
function view(ctx: ApiContext) {
  const monitor = ctx.config().monitor;
  const state: StoriesState = currentState({ startedAt: ctx.watchers.startedAt, cooldownMinutes: monitor.cooldown_minutes });
  return { ...state, ...(state.state === "breaker" ? { why: breakerWhy(state) } : {}), reportTo: !!monitor.report_to };
}

/** The off switch of the monitor's bug stories (admin only; the rules are in permissions.ts). */
export const monitorRoutes: Route = async (ctx, _req, res, seg, method, user) => {
  if (seg[0] !== "monitor" || seg.length > 2) return false;
  if (seg.length === 1) {
    if (method !== "GET") throw new HttpError(405, "method not allowed");
    return send(res, 200, view(ctx)), true;
  }
  if ((seg[1] !== "off" && seg[1] !== "on") || method !== "POST") return false;
  const sub = seg[1];
  let r;
  try {
    r = switchStories(sub, user.id, { onLogError: (m) => ctx.diagLog?.(m) });
  } catch (e) {
    throw new HttpError(409, (e as Error).message);
  }
  if (r.changed) ctx.watchers.monitorAct(describeEntry({ event: sub }));
  if ("closed" in r && r.closed) ctx.watchers.monitorAct(describeEntry({ event: "breaker-closed" }));
  return send(res, 200, { ...view(ctx), changed: r.changed, ...("closed" in r && r.closed ? { closed: true } : {}), ...("reset" in r && r.reset ? { reset: r.reset } : {}) }), true;
};
