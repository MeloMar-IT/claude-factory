import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { nextParts } from "./next.js";
import { lastOkText } from "./admin.js";

export const REFRESH_MS = 30_000;
const NO_ANSWER = "The Foundry server does not answer. Check that it is still running.";

/** Draws the line for one answer of GET /api/health; `health` null: the server did not answer. */
export function renderHealth(el, health, { onCancel } = {}) {
  el.hidden = false;
  if (!health) {
    el.setAttribute("class", "health bad");
    mount(el, h("b", {}, NO_ANSWER));
    return;
  }
  el.setAttribute("class", health.ok ? "health ok" : "health bad");
  const problems = health.problems ?? [];
  const repos = health.repos ?? [];
  mount(el,
    h("b", {}, health.summary),
    problems.length ? h("ul", { class: "holds" }, problems.map((n) => h("li", {},
      nextParts(n, { status: false }),
      n.kind === "closed_elsewhere" && n.runId ? h("button", { class: "small danger", onClick: () => onCancel?.(n.runId) }, "Cancel run") : null))) : null,
    repos.length ? h("span", { class: "health-repos muted" }, repos.map((r) => h("span", {}, h("span", { class: "mono" }, r.repo), lastOkText({ lastOk: r.lastOk })))) : null,
    health.version || health.update ? h("span", { class: "health-version muted" },
      health.version ? `Version ${String(health.version.commit).slice(0, 7)} · ${new Date(health.version.date).toLocaleString()}` : "",
      health.version && health.update ? " · " : "",
      health.update?.text ?? "") : null);
}

let gen = 0; // the newest request wins

/** Asks the server and draws the line; the newest request wins. Never rejects. */
export async function loadHealth(el) {
  const g = ++gen;
  const health = await api.health().catch(() => null);
  if (g !== gen) return;
  renderHealth(el, health, {
    onCancel: async (runId) => {
      if (!confirm("Cancel this run? You can resume it later.")) return;
      await api.cancelRun(runId).catch((e) => toast(e.message, "error"));
      loadHealth(el);
    },
  });
}

/** Loads the line now, on every page change and every 30 seconds; returns a stop function. */
export function startHealth(el, { every = REFRESH_MS } = {}) {
  const load = () => loadHealth(el);
  load();
  const timer = setInterval(load, every);
  globalThis.addEventListener?.("hashchange", load);
  return () => {
    clearInterval(timer);
    globalThis.removeEventListener?.("hashchange", load);
  };
}
