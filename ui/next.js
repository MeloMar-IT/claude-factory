import { h } from "./dom.js";

// Shows the next-step record from the server. No wording of its own: only fields of the record, plus the label of the "?" button.

const rank = (n) => (n.who === "You" ? 0 : n.who === "Something is wrong" ? 1 : 2);
const whoClass = (n) => "who-" + String(n.who).toLowerCase().replace(/[^a-z]+/g, "-");

/** Records with "You" first, then "Something is wrong", then the rest; order otherwise kept. */
export const sortNext = (records) => [...records].sort((a, b) => rank(a) - rank(b));

/** Runs whose record says the next move is yours (Runs "Needs you", Dashboard tile). */
export const needsYou = (runs) => runs.filter((r) => r.next?.who === "You");

/** A watcher's records: its error (status.next) first, then one per hold. `w` is an item of GET /api/watchers. */
export const watcherNext = (w) => [w.status?.next, ...(w.status?.holds ?? []).map((x) => x.next)].filter(Boolean);

/** Dashboard Waiting card: { yours, rest }, each a list of { w, records } for enabled watchers. Empty groups are left out. */
export function waitingGroups(watchers) {
  const yours = [];
  const rest = [];
  for (const w of watchers) {
    if (!w.enabled) continue;
    const records = watcherNext(w);
    const mine = records.filter((n) => n.who === "You");
    const other = records.filter((n) => n.who !== "You");
    if (mine.length) yours.push({ w, records: mine });
    if (other.length) rest.push({ w, records: other });
  }
  return { yours, rest };
}

/** { href, external } for https?:// (external) or "#/…" (same tab); undefined for anything else. */
export function whereTarget(where) {
  const url = where?.url;
  if (typeof url !== "string") return undefined;
  if (/^https?:\/\//i.test(url)) return { href: url, external: true };
  if (url.startsWith("#/")) return { href: url, external: false };
  return undefined;
}

/** The link of a record; a plain span when the url is not one we link. */
export function whereLink(where) {
  const t = whereTarget(where);
  const label = where?.label ?? "";
  if (!t) return label ? h("span", { class: "hold-link" }, label) : null;
  return t.external
    ? h("a", { href: t.href, target: "_blank", rel: "noopener", class: "hold-link" }, `${label} ↗`)
    : h("a", { href: t.href, class: "hold-link" }, label);
}

/** A "?" button: pressing it shows `text` under the line, pressing it again hides it. Mouse, keyboard and touch. */
export function helpMark(text) {
  if (!text) return null;
  const note = h("span", { class: "help-text", role: "note" }, text);
  note.hidden = true;
  const btn = h("button", { type: "button", class: "help-mark", "aria-label": "What does this mean?", "aria-expanded": "false", onClick: () => {
    note.hidden = !note.hidden;
    btn.setAttribute("aria-expanded", String(!note.hidden));
  } }, "?");
  // A press on the "?" or its text must not open the run (rows of the Runs list are links).
  return h("span", { class: "help", onClick: (e) => e.stopPropagation() }, btn, note);
}

/** A status name as a pill with its "?": [pill, help]. `x` has `status` and `help` (a record, or a watcher's `state`). */
export const statusMark = (x, cls = "", busy = false) => [
  h("span", { class: `pill ${cls}`.trim() }, busy ? h("span", { class: "spinner", style: { width: "10px", height: "10px" } }) : null, x.status),
  helpMark(x.help),
];

/** The status of a record. */
export const nextStatus = (n) => statusMark(n, `${whoClass(n)} kind-${n.kind}`, n.kind === "running");

/** The one renderer of a record: who, status, issue, title, action, why, until, link. `ref: false` leaves out issue and title, `status: false` the status. */
export function nextParts(n, { ref = true, status = true } = {}) {
  const issueOk = ref && n.issue && /^[\w.-]+\/[\w.-]+$/.test(n.repo ?? "");
  return [
    h("span", { class: `pill ${whoClass(n)}` }, n.who),
    ...(status ? nextStatus(n) : []),
    issueOk ? h("a", { href: `https://github.com/${n.repo}/issues/${n.issue}`, target: "_blank", rel: "noopener", class: "mono" }, `#${n.issue}`) : null,
    ref && n.title ? h("span", { class: "hold-title" }, n.title) : null,
    h("span", { class: "hold-action" }, n.action),
    h("span", { class: "muted" }, n.why),
    n.until ? h("span", { class: "muted" }, `Continues: ${n.until}`) : null,
    whereLink(n.where),
  ];
}

/** One line per record, "You" first. */
export const nextList = (records) => h("ul", { class: "holds" }, sortNext(records).map((n) => h("li", {}, nextParts(n))));

/** Run page block. */
export const nextBlock = (n) => h("div", { class: `card next-step ${whoClass(n)}` },
  h("b", {}, "What happens next"),
  h("div", { class: "next-parts" }, nextParts(n, { ref: false, status: false })));
