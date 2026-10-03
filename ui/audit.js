import { api } from "./api.js";
import { errorText } from "./auth.js";
import { h, mount } from "./dom.js";

/** Every action a line can have; the same names as AUDIT_ACTIONS on the server, by alphabet. */
export const ACTIONS = ["block", "create", "credential-add", "credential-remove", "delete", "edit", "flow-publish", "link",
  "password", "repo-add", "repo-change", "repo-remove", "repo-transfer", "role", "run-approve", "run-cancel", "run-reject",
  "run-resume", "run-start", "settings-change", "sign-in", "turn-answer", "turn-approve", "turn-reject", "turn-retry", "unblock"];

/** A day from a date field ("2026-10-02") as an ISO time in the browser's time zone: its first moment, or its last with `end`. "" when it is not a real date. */
export function dayTime(day, end = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(2000, 0, 1);
  t.setFullYear(y, mo - 1, d); // unlike the Date constructor, this keeps years 0-99 as they are
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) return "";
  if (end) t.setHours(23, 59, 59, 999);
  else t.setHours(0, 0, 0, 0);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString();
}

/** What is wrong with the dates, or "". */
export const filterProblem = ({ from, to }) => (from && to && from > to ? "The From date is after the To date." : "");

/** The form values as the API's filters: empty ones are left out, dates become ISO times. */
export function auditFilters({ user, action, from, to }) {
  const all = { user, action, from: dayTime(from), to: dayTime(to, true) };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
}

/** The options of the user filter: one per account, by name. */
export const userOptions = (users) => [...users]
  .sort((a, b) => String(a.name).localeCompare(String(b.name)))
  .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }));

/** Who did it: the account's name, "command line" for cli, "not signed in" for anonymous. */
export function actorText(actor) {
  if (actor?.type === "cli") return "command line";
  if (actor?.type === "anonymous") return "not signed in";
  return actor?.name ?? "";
}

/** What it was done to: the account's name, the text, or "" for none. */
export function targetText(target) {
  if (!target) return "";
  return target.type === "text" ? target.text ?? "" : target.name ?? "";
}

/** The time as the browser's local date and time. */
export const timeText = (iso) => new Date(iso).toLocaleString();

/** The line shown when the log has more matching lines than the page shows. */
export const moreText = (n) => `Showing the newest ${n} entries. There are more: narrow the filters, or use Export CSV to get them all.`;

// Each render gets a number; answers for an older render, or that arrive after the person left the page, are dropped.
// Each page also numbers its own list loads, so only the newest list answer is drawn.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("/")[1] ?? "") === "audit";
  } catch {
    return false;
  }
};

const isAccount = (x) => x && x.type !== "cli" && x.type !== "anonymous" && x.type !== "text";

function table(entries) {
  const row = (e) => h("tr", {},
    h("td", { class: "muted", title: e.time }, timeText(e.time)),
    h("td", { title: isAccount(e.actor) ? e.actor.id : null }, actorText(e.actor)),
    h("td", { class: "mono" }, e.action),
    h("td", { title: isAccount(e.target) ? e.target.id : null },
      targetText(e.target) || h("span", { class: "muted" }, "—"),
      e.detail ? h("div", { class: "muted" }, e.detail) : null),
    h("td", {}, h("span", { class: e.result === "failed" ? "pill fail" : "pill ok" }, e.result)));
  return h("table", { class: "table" },
    h("thead", {}, h("tr", {}, ["Time", "Who", "Action", "Target", "Result"].map((t) => h("th", {}, t)))),
    h("tbody", {}, entries.map(row)));
}

/** The Audit page (admins). Draws at once and returns its cleanup at once; the data arrives later. */
export function renderAudit(main) {
  const mine = ++generation;
  const live = () => mine === generation && onPage();
  const select = (name, first, options) => h("select", { name, class: "small-select", onChange: () => load() },
    h("option", { value: "" }, first), options.map((o) => h("option", { value: o.value }, o.label)));
  const date = (name) => h("input", { name, type: "date", class: "small-select", onChange: () => load() });
  const user = select("user", "All users", []);
  const action = select("action", "All actions", ACTIONS.map((a) => ({ value: a, label: a })));
  const from = date("from");
  const to = date("to");
  const labelled = (t, el) => h("label", { class: "row" }, h("span", { class: "muted" }, t), el);
  const exportSlot = h("span");
  const loading = () => h("div", { class: "row" }, h("span", { class: "spinner" }), " Loading…");
  const result = h("div", {}, loading());
  let loads = 0; // the number of the newest list load of this page

  const load = async () => {
    const my = ++loads;
    const values = { user: user.value, action: action.value, from: from.value, to: to.value };
    const problem = filterProblem(values);
    if (problem) {
      mount(exportSlot);
      return mount(result, h("div", { class: "errors" }, problem));
    }
    const filters = auditFilters(values);
    mount(exportSlot, h("a", { class: "btn", href: api.auditExportUrl(filters), download: "audit.csv" }, "Export CSV"));
    mount(result, loading());
    let data;
    try {
      data = await api.audit(filters);
    } catch (e) {
      if (my === loads && live()) mount(result, h("div", { class: "errors" }, errorText(e)));
      return;
    }
    if (my !== loads || !live()) return;
    mount(result,
      data.more ? h("p", { class: "status" }, moreText(data.entries.length)) : null,
      data.entries.length ? table(data.entries) : h("div", { class: "empty" }, "No entries."));
  };

  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Audit"), h("span", { class: "muted" }, "Who did what"),
      labelled("User", user), labelled("Action", action), labelled("From", from), labelled("To", to),
      h("span", { class: "spacer" }), exportSlot),
    result);

  (async () => {
    let users;
    try {
      users = await api.users();
    } catch (e) {
      if (live()) mount(result, h("div", { class: "errors" }, errorText(e)));
      return;
    }
    if (!live()) return;
    for (const o of userOptions(users)) user.append(h("option", { value: o.value }, o.label));
    await load();
  })();

  return () => {
    generation++;
  };
}
