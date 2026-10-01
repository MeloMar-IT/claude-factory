import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { whereLink } from "./next.js";
import { timeText } from "./turn.js";

// "Since you last looked": a strip under the header after a break. The last visit is kept per
// browser (localStorage) and shared by its tabs, so every write reads the store first.

export const BREAK_MS = 30 * 60_000;
export const RETRY_MS = 5 * 60_000;
const KEY = "scf.since";
const HEARTBEAT_MS = 30_000;

const defaultStore = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const ms = (iso) => (typeof iso === "string" ? Date.parse(iso) : NaN);

/** {} when storage is missing, throws, or holds garbage. */
export function readState(store) {
  try {
    const s = JSON.parse(store.getItem(KEY));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

export function writeState(state, store) {
  try {
    store.setItem(KEY, JSON.stringify(state));
  } catch {
    // no storage: nothing is remembered
  }
}

/** → { state, from }: the state to save and the start of the summary to show (null: none). */
export function visit(state, now = new Date(), breakMs = BREAK_MS) {
  const seen = ms(state?.seen);
  if (Number.isNaN(seen)) return { state: { seen: now.toISOString() }, from: null };
  const from = !Number.isNaN(ms(state.from)) ? state.from : now.getTime() - seen >= breakMs ? state.seen : null;
  return { state: from ? { seen: now.toISOString(), from } : { seen: now.toISOString() }, from };
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The strip for one answer of GET /api/since. */
export function sinceView(data, { onDismiss }) {
  const entry = (e) => {
    const issueOk = e.issue && /^[\w.-]+\/[\w.-]+$/.test(e.repo ?? "");
    return h("li", {},
      issueOk ? h("a", { href: `https://github.com/${e.repo}/issues/${e.issue}`, target: "_blank", rel: "noopener", class: "mono" }, `#${e.issue}`) : null,
      h("span", { class: "hold-title" }, e.title),
      whereLink(e.where));
  };
  const group = (g) => h("div", { class: "since-group" },
    h("b", {}, g.label),
    g.id === "waiting" ? h("a", { href: "#/your-turn", class: "hold-link" }, "Your turn") : null,
    h("ul", { class: "holds" },
      ...g.items.map(entry),
      g.count > g.items.length ? h("li", { class: "muted" }, `+${g.count - g.items.length} more`) : null));
  return h("div", { class: "since-body" },
    h("div", {}, h("b", {}, "Since you last looked"), " ", h("span", { class: "muted" }, timeText(data.since))),
    ...(data.groups ?? []).map(group),
    ...(data.notes ?? []).map((n) => h("div", { class: "since-note muted" }, n)),
    h("button", { class: "ghost small", onClick: () => onDismiss() }, "Dismiss"));
}

/** Checks now, on a heartbeat and whenever the tab becomes visible; returns a stop function. */
export function startSince(el, { store = defaultStore(), now = () => new Date() } = {}) {
  let gen = 0; // the newest request wins; a dismissal or a change in another tab drops older ones
  let answered = null; // the `from` of the last answer
  let pending = null; // the `from` of the request in flight
  let retryAt = 0; // an incomplete or failed answer is asked again after this time
  const hide = () => { el.hidden = true; };

  const forget = () => {
    gen++;
    answered = pending = null;
    hide();
  };

  const onAnswer = (from, g) => (data) => {
    if (g !== gen) return;
    pending = null;
    if (readState(store).from !== from) return; // dismissed in another tab meanwhile
    answered = from;
    retryAt = data.complete ? 0 : now().getTime() + RETRY_MS;
    if (data.total === 0) {
      if (data.complete) writeState({ seen: now().toISOString() }, store);
      hide();
      return;
    }
    mount(el, sinceView(data, { onDismiss: dismiss }));
    el.hidden = false;
  };

  const ask = (from) => {
    const g = ++gen;
    pending = from;
    retryAt = 0;
    api.since(from).then(onAnswer(from, g), () => {
      if (g !== gen) return;
      pending = null;
      retryAt = now().getTime() + RETRY_MS; // leave things as they are; try again later
    });
  };

  function dismiss() {
    gen++;
    answered = pending = null;
    writeState({ seen: now().toISOString() }, store);
    hide();
  }

  const check = (refetch) => {
    const t = now();
    const v = visit(readState(store), t);
    writeState(v.state, store);
    if (!v.from) {
      hide();
      return;
    }
    // Ask for a `from` not answered yet, or again when the last answer was incomplete (or failed) and the wait is over.
    const wanted = (answered !== v.from || retryAt > 0) && t.getTime() >= retryAt;
    if (refetch || (pending !== v.from && wanted)) ask(v.from);
  };

  const timer = setInterval(() => {
    if (document.visibilityState === "visible") check(false);
  }, HEARTBEAT_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") check(true);
  };
  const onStorage = (e) => {
    if (e?.key && e.key !== KEY) return;
    if (!readState(store).from) forget();
  };
  document.addEventListener("visibilitychange", onVisible);
  globalThis.addEventListener?.("storage", onStorage);

  check(false);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
