import { api } from "./api.js";
import { h, modal, toast } from "./dom.js";

/** The choices of the mute form: label → hours ("" is for good). */
export const DURATIONS = [["For good", ""], ["1 hour", "1"], ["1 day", "24"], ["1 week", "168"], ["30 days", "720"]];
/** How many findings are drawn at first, and with each "Show more". */
export const PAGE = 100;
const REASON_MAX = 200;

export const untilText = (until) => (until ? `until ${new Date(until).toLocaleString()}` : "for good");
const when = (iso) => new Date(iso).toLocaleString();

/** The body of the mute call; throws an Error with a plain sentence when the reason is empty or too long. */
export function muteBody(target, reason, hours) {
  const text = String(reason ?? "").trim();
  if (!text) throw new Error("Give a reason.");
  if (text.length > REASON_MAX) throw new Error(`The reason is too long (at most ${REASON_MAX} characters).`);
  return { ...target, reason: text, ...(hours ? { hours: Number(hours) } : {}) };
}

/** The story as a link (only for an https address), else "#12" as text; null without a story. */
export function storyCell(story) {
  if (!story) return null;
  const state = story.state === "not_planned" ? " (closed as not planned)" : story.state === "closed" ? " (closed)" : "";
  const link = typeof story.url === "string" && story.url.startsWith("https://")
    ? h("a", { href: story.url, target: "_blank", rel: "noopener noreferrer" }, `#${story.issue}`)
    : h("span", {}, `#${story.issue}`);
  return h("span", {}, link, state);
}

/** The mute form in a modal; resolves true when a mute was made. */
export function muteForm(target, detectors) {
  const what = target.finding ? "this finding" : "this detector";
  return modal(target.finding ? "Mute a finding" : "Mute a detector", (close) => {
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const detector = target.detector === undefined && target.pick
      ? h("select", {}, (detectors ?? []).map((d) => h("option", { value: d.name }, d.name)))
      : null;
    const reason = h("input", { maxlength: REASON_MAX, placeholder: "Why is this known noise?" });
    const hours = h("select", {}, DURATIONS.map(([label, v]) => h("option", { value: v }, label)));
    const field = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
    const go = async () => {
      err.textContent = "";
      try {
        const t = target.finding ? { finding: target.finding } : { detector: detector ? detector.value : target.detector };
        const body = muteBody(t, reason.value, hours.value);
        await api.muteMonitor(body);
        toast("Muted");
        close(true);
      } catch (e) {
        err.textContent = e.message;
      }
    };
    return h("div", { class: "modal-body" },
      h("p", {}, `No bug story is made for ${what} while it is muted. It is still recorded.`),
      detector ? field("Detector", detector) : null,
      field("Reason", reason),
      field("For", hours),
      err,
      h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { class: "primary", onClick: go }, "Mute")));
  }).then((v) => v === true);
}

let isOpen = false;
let shown = PAGE;

const mutesTable = (m, reload) => {
  const end = async (x) => {
    try {
      await api.unmuteMonitor(x.id);
      toast("Mute ended");
    } catch (e) {
      toast(e.message, "error");
    }
    await reload();
  };
  return h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, ["What", "Reason", "Since", "Until", ""].map((c) => h("th", {}, c)))),
    h("tbody", {}, m.mutes.map((x) => h("tr", {},
      h("td", {}, x.kind === "finding" ? `${x.detector}: ${x.summary ?? x.finding}` : x.detector),
      h("td", {}, x.reason),
      h("td", {}, when(x.since)),
      h("td", {}, x.until ? when(x.until) : "for good"),
      h("td", {}, h("button", { class: "small", onClick: () => end(x) }, "End mute"))))));
};

const findingsTable = (m, reload, redraw) => {
  const rows = m.findings.slice(0, shown);
  const mute = async (f) => {
    if (await muteForm({ finding: f.id }, m.detectors)) await reload();
  };
  const table = h("table", { class: "table compact" },
    h("thead", {}, h("tr", {}, ["Severity", "Detector", "What", "First seen", "Last seen", "Story", "Muted", ""].map((c) => h("th", {}, c)))),
    h("tbody", {}, rows.map((f) => h("tr", {},
      h("td", {}, f.severity),
      h("td", {}, f.detector),
      h("td", {}, f.summary),
      h("td", {}, when(f.firstSeen)),
      h("td", {}, when(f.lastSeen)),
      h("td", {}, storyCell(f.story)),
      h("td", {}, f.mute ? `muted ${untilText(f.mute.until)}: ${f.mute.reason}` : ""),
      h("td", {}, f.mute ? null : h("button", { class: "small", onClick: () => mute(f) }, "Mute"))))));
  const left = m.findings.length - rows.length;
  return h("div", {},
    table,
    left > 0 ? h("button", { class: "small", onClick: () => { shown += PAGE; redraw(); } }, `Show ${Math.min(PAGE, left)} more`) : null);
};

/** The findings and mutes of the monitor's card; null when `m` has no `findings` list. */
export function monitorLists(m, reload) {
  if (!m || !Array.isArray(m.findings)) return null;
  const body = h("div", {});
  const redraw = () => {
    body.replaceChildren(
      h("div", { class: "row" },
        h("button", { class: "small", onClick: async () => { if (await muteForm({ pick: true }, m.detectors)) await reload(); } }, "Mute a detector")),
      m.mutes.length ? mutesTable(m, reload) : null,
      m.findings.length ? findingsTable(m, reload, redraw) : h("p", { class: "muted" }, "No findings."));
  };
  redraw();
  return h("details", { open: isOpen, onToggle: (e) => { isOpen = !!e.target.open; } },
    h("summary", {}, `Findings (${m.findings.length}) · Mutes (${m.mutes.length})`),
    body);
}
