import { api } from "./api.js";
import { h, mount, toast } from "./dom.js";
import { whereTarget } from "./next.js";

// The "Your turn" page: only what waits for the owner, from GET /api/your-turn. No wording of
// its own except labels; the text of each item comes from its next-step record.

export const TITLE = "Spaghetti Code Foundry";
export const tabTitle = (count) => (count > 0 ? `(${count}) Foundry` : TITLE);

/** The page to open at start: Your turn, when something waits and the URL names no page. */
export const startHash = (hash, count) => (!hash && count > 0 ? "#/your-turn" : null);

/** The count in the navigation badge and the tab title. */
export function showCount(count) {
  const badge = document.getElementById("turn-badge");
  if (badge) {
    badge.textContent = count > 0 ? String(count) : "";
    badge.hidden = !(count > 0);
  }
  document.title = tabTitle(count);
}

let gen = 0; // the newest request wins
let openOnWaiting = false; // the app opened with nothing waiting and no page chosen: open Your turn when the first item shows

/** Watchers check GitHub after the server starts, so the first answer can be empty. */
function openWhenWaiting(count) {
  if (!openOnWaiting || count <= 0) return;
  openOnWaiting = false;
  if (!globalThis.location?.hash) globalThis.location.hash = "#/your-turn";
}
let page = null; // set while the Your turn page is open: (data) => draws it

/** Asks the server (or runs `call`, which returns the same data), then updates the badge and the open page. */
export async function refresh(call = api.yourTurn) {
  const g = ++gen;
  const data = await call();
  if (g !== gen) return undefined; // a newer request was started; its answer is the one to show
  showCount(data.count);
  openWhenWaiting(data.count);
  page?.(data);
  return data;
}

/** Shows the badge now and every 30 seconds; returns the first count (0 when the server does not answer). */
export async function startBadge() {
  const first = await refresh().then((d) => d?.count ?? 0, () => 0);
  openOnWaiting = first === 0 && !!globalThis.location && !globalThis.location.hash;
  setInterval(() => refresh().catch(() => {}), 30_000);
  return first;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

/** "since 14:05" today, "since 28 Sep, 14:05" on another day, "" for no valid time. */
export function sinceText(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `since ${hm}`;
  return `since ${d.getDate()} ${MONTHS[d.getMonth()]}, ${hm}`;
}

const stories = (n) => `${n} ${n === 1 ? "story" : "stories"}`;

function itemView(item, { onDismiss, onLeave }) {
  const n = item.next;
  const issueOk = n.issue && /^[\w.-]+\/[\w.-]+$/.test(n.repo ?? "");
  const target = whereTarget(n.where);
  const action = !target
    ? h("span", { class: "muted" }, n.where?.label ?? "")
    : target.external
      ? h("a", { class: "btn primary", href: target.href, target: "_blank", rel: "noopener", onClick: () => onLeave(item) }, `${n.where.label} ↗`)
      : h("a", { class: "btn primary", href: target.href }, n.where.label);
  const since = sinceText(item.since);
  return h("div", { class: "turn-item" },
    h("div", { class: "turn-main" },
      h("div", {},
        issueOk ? h("a", { href: `https://github.com/${n.repo}/issues/${n.issue}`, target: "_blank", rel: "noopener", class: "mono", onClick: () => onLeave(item) }, `#${n.issue}`) : null,
        issueOk ? " " : null,
        h("b", {}, item.what)),
      h("div", {}, h("span", { class: "hold-action" }, n.action)),
      h("div", { class: "muted" }, n.why),
      item.unblocks > 0 ? h("div", { class: "muted" }, `Holds back ${stories(item.unblocks)}`) : null,
      since ? h("div", { class: "muted", title: new Date(item.since).toLocaleString() }, since) : null),
    h("div", { class: "turn-side" },
      action,
      item.dismissable ? h("button", { class: "ghost small", onClick: () => onDismiss(item.key) }, "Dismiss") : null));
}

/** The page for one answer of the server. */
export function turnView(data, { onDismiss, onRestore, onLeave }) {
  return [
    h("div", { class: "toolbar" }, h("h1", {}, "Your turn")),
    data.count === 0 ? h("div", { class: "empty" }, data.empty) : null,
    ...(data.groups ?? []).map((g) =>
      h("div", { class: "card turn-group" }, h("h3", {}, g.repo), ...g.items.map((i) => itemView(i, { onDismiss, onLeave })))),
    data.dismissed > 0
      ? h("p", { class: "muted" }, `${data.dismissed} dismissed `, h("button", { class: "small", onClick: () => onRestore() }, "Show again"))
      : null,
  ];
}

/** Opens the page; returns a function that closes it. */
export async function renderYourTurn(main) {
  let left; // an item with a watcher whose link was opened: check GitHub again when the user comes back
  const fail = (e) => toast(e.message, "error");
  const handlers = {
    onDismiss: (key) => refresh(() => api.dismissTurn(key)).catch(fail),
    onRestore: () => refresh(api.restoreTurn).catch(fail),
    onLeave: (item) => { if (item.watcher) left = item.watcher; },
  };
  page = (data) => mount(main, turnView(data, handlers));
  try {
    await refresh();
  } catch (e) {
    page = null;
    throw e;
  }
  const timer = setInterval(() => refresh().catch(() => {}), 5000);
  const onVisible = async () => {
    if (document.visibilityState !== "visible" || !left) return;
    const id = left;
    left = undefined;
    await api.tickWatcher(id).catch(() => {});
    refresh().catch(() => {});
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    page = null;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
