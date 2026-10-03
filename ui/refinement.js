import { api } from "./api.js";
import { h, modal, mount, timeAgo, toast } from "./dom.js";

/** The states of a refinement session, in words. Later steps move a session along; for now only Drop and Restore change it. */
export const STATE_LABELS = {
  exploring: "Exploring",
  drafting: "Drafting",
  ready: "Ready",
  published: "Published",
  dropped: "Dropped",
};

const text = (s) => String(s ?? "").trim();

/** What is missing in the input, or "" when it can be sent. */
export function sessionProblem({ repo, idea } = {}) {
  if (!text(repo)) return "Choose a repository.";
  if (!text(idea)) return "Describe your idea.";
  return "";
}

/** The request body: the title is left out when it is blank. */
export function sessionBody({ repo, idea, title }) {
  const body = { repo: text(repo), idea: String(idea ?? "") };
  if (text(title)) body.title = text(title);
  return body;
}

/** One line of the log in words. */
export function logText(entry) {
  const who = entry.who || "Someone";
  if (entry.what === "created") return `${who} started the session`;
  if (entry.what === "renamed") return `${who} renamed it${entry.detail ? ` to "${entry.detail}"` : ""}`;
  if (entry.what === "dropped") return `${who} dropped the session`;
  if (entry.what === "restored") return `${who} restored the session`;
  return `${who}: ${entry.what}`;
}

/** The server's sentence for a failed call. */
export function errorText(e) {
  if (e instanceof TypeError) return "Could not reach the server.";
  return e?.message || "Something went wrong.";
}

async function whileBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent((location.hash ?? "").split("/")[1] ?? "") === "refinement";
  } catch {
    return false;
  }
};

const date = (iso) => new Date(iso).toLocaleDateString();
const goTo = (hash) => {
  location.hash = hash;
};

let showDropped = false;

/** Asks for the repository, the idea and an optional title. Resolves with the new session, or undefined when closed. */
function newSessionDialog(repos, onMade) {
  return modal("New refinement session", (close) => {
    if (!repos.length) {
      return h("div", { style: { display: "grid", gap: "12px" } },
        h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
        h("a", { href: "#/repos", onClick: () => close(undefined) }, "Go to My repositories"));
    }
    const select = h("select", { name: "repo" }, repos.map((r) => h("option", { value: r }, r)));
    select.value = repos[0];
    const title = h("input", { name: "title", placeholder: "Optional. The first line of the idea is used when empty.", autocomplete: "off" });
    const idea = h("textarea", { name: "idea", rows: 8, placeholder: "Describe your idea in your own words" });
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    let busy = false;
    const run = async () => {
      if (busy) return;
      const input = { repo: select.value, idea: idea.value, title: title.value };
      const problem = sessionProblem(input);
      if (problem) return void (err.textContent = problem);
      busy = true;
      start.disabled = true;
      err.textContent = "";
      try {
        const made = await api.createRefinement(sessionBody(input));
        onMade?.(made); // also when the dialog was closed while the request ran
        close(made);
      } catch (e) {
        busy = false;
        err.textContent = errorText(e);
        start.disabled = false;
      }
    };
    const start = h("button", { class: "primary", onClick: run }, "Start session");
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("label", { class: "field" }, h("span", {}, "Repository"), select),
      h("label", { class: "field" }, h("span", {}, "Title"), title),
      h("label", { class: "field" }, h("span", {}, "Your idea"), idea),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), start));
  });
}

/** Asks for a new title. Resolves true when the session was renamed. */
function renameDialog(session, onRenamed) {
  return modal("Rename session", (close) => {
    const input = h("input", { name: "title", value: session.title, autocomplete: "off" });
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    let busy = false;
    const run = async () => {
      if (busy) return;
      const title = text(input.value);
      if (!title) return void (err.textContent = "Give the session a title.");
      busy = true;
      save.disabled = true;
      err.textContent = "";
      try {
        await api.renameRefinement(session.id, { title });
      } catch (e) {
        busy = false;
        err.textContent = errorText(e);
        save.disabled = false;
        return;
      }
      toast("Session renamed");
      onRenamed?.();
      close(true);
    };
    const save = h("button", { class: "primary", onClick: run }, "Save");
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("label", { class: "field" }, h("span", {}, "Title"), input), err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
}

/** The Refinement pages: the list (no `id`) and one session. Returns a cleanup. */
export async function renderRefinement(main, { admin = false, id } = {}) {
  const mine = ++generation;
  const current = () => mine === generation && onPage();
  const reload = () => renderRefinement(main, { admin, id }).catch((e) => toast(errorText(e), "error"));
  const restore = (btn, sid) =>
    whileBusy(btn, async () => {
      try {
        await api.restoreRefinement(sid);
        toast("Session restored");
      } catch (e) {
        toast(errorText(e), "error");
      }
      await reload();
    });
  const cleanup = () => {
    generation++;
  };

  if (id) {
    let s;
    try {
      s = await api.refinementSession(id);
    } catch (e) {
      if (!current()) return () => {};
      mount(main, h("a", { href: "#/refinement" }, "← All sessions"), h("p", { class: "status bad" }, errorText(e)));
      return cleanup;
    }
    if (!current()) return () => {};
    const open = s.state !== "dropped";
    const buttons = [];
    if (s.mine && open) {
      buttons.push(h("button", { class: "small", onClick: async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        await renameDialog(s, () => current() && reload());
      } }, "Rename"));
    }
    if (open && (s.mine || admin)) {
      buttons.push(h("button", { class: "small danger", onClick: (e) => {
        const btn = e.currentTarget;
        if (!confirm(`Drop "${s.title}"? You can restore it for 30 days.`)) return;
        return whileBusy(btn, async () => {
          try {
            await api.dropRefinement(s.id);
            toast("Session dropped");
          } catch (err) {
            toast(errorText(err), "error");
          }
          await reload();
        });
      } }, "Drop"));
    }
    if (!open && s.mine) buttons.push(h("button", { class: "small", onClick: (e) => restore(e.currentTarget, s.id) }, "Restore"));
    mount(main,
      h("a", { href: "#/refinement" }, "← All sessions"),
      h("div", { class: "toolbar" }, h("h1", {}, s.title), h("span", { class: `pill state-${s.state}` }, STATE_LABELS[s.state] ?? s.state),
        h("span", { class: "muted" }, s.repo), s.ownerName && !s.mine ? h("span", { class: "muted" }, `Owner: ${s.ownerName}`) : null,
        h("span", { class: "spacer" }), buttons),
      s.repoAvailable === false ? h("p", { class: "status bad" }, "This repository is not in My repositories any more. Add it again to keep working on this session.") : null,
      !open && s.removedOn ? h("p", { class: "muted" }, `Dropped. It is removed on ${date(s.removedOn)}.`) : null,
      h("h2", {}, "Idea"),
      h("p", { style: { whiteSpace: "pre-wrap" } }, s.idea),
      h("h2", {}, "Story drafts"),
      s.drafts.length ? h("ul", {}, s.drafts.map((d) => h("li", {}, String(d?.title ?? "Draft")))) : h("p", { class: "muted" }, "No story drafts yet."),
      h("h2", {}, "Log"),
      h("ul", { class: "log" }, s.log.map((l) => h("li", {}, `${timeAgo(l.at)} — ${logText(l)}`))));
    return cleanup;
  }

  let listed;
  try {
    listed = await api.refinement();
  } catch (err) {
    if (!current()) return () => {};
    throw err;
  }
  if (!current()) return () => {};
  const { sessions, repos } = listed;
  const shown = sessions.filter((s) => (s.state === "dropped") === showDropped);
  const row = (s) => h("tr", { class: "link", onClick: () => goTo(`#/refinement/${encodeURIComponent(s.id)}`) },
    h("td", {}, s.title),
    h("td", { class: "mono" }, s.repo),
    h("td", {}, h("span", { class: `pill state-${s.state}` }, STATE_LABELS[s.state] ?? s.state),
      s.state === "dropped" ? [" ", h("span", { class: "muted" }, `removed on ${date(s.removedOn)}`)] : null,
      s.state === "dropped" && s.mine ? [" ", h("button", { class: "small", onClick: (e) => {
        e.stopPropagation();
        return restore(e.currentTarget, s.id);
      } }, "Restore")] : null),
    h("td", {}, timeAgo(s.updated)),
    admin ? h("td", {}, s.ownerName ?? "") : null);
  const filter = (label, dropped) => h("button", { class: `small${showDropped === dropped ? " primary" : ""}`, onClick: () => {
    showDropped = dropped;
    reload();
  } }, label);
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Refinement"),
      h("span", { class: "muted" }, "Where a rough idea grows into a story"),
      h("span", { class: "spacer" }), filter("Open sessions", false), filter("Dropped", true),
      h("button", { class: "primary", onClick: async () => {
        await newSessionDialog(repos, (made) => {
          if (!made?.id) return;
          if (current()) goTo(`#/refinement/${encodeURIComponent(made.id)}`);
          else toast("Refinement session started");
        });
      } }, "New session")),
    shown.length
      ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Title", "Repository", "State", "Last change", admin ? "Owner" : null].filter(Boolean).map((t) => h("th", {}, t)))),
        h("tbody", {}, shown.map(row)))
      : h("div", { class: "empty" }, showDropped ? "No dropped sessions." : "No refinement sessions yet. Start one with a rough idea."));
  return cleanup;
}
