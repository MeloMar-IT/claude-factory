import { api } from "./api.js";
import { h, modal, mount, toast } from "./dom.js";
import { connectionStatus, methodLabel, plainError } from "./repos.js";

const lines = (s) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
const PATTERN_HINT = '"*" matches any text, ? one character.';

/** The request body for the settings: every setting is sent, trimmed; an empty one clears it. */
export function settingsBody(values = {}) {
  return {
    testCommand: String(values.testCommand ?? "").trim(),
    docs: lines(values.docs),
    protectedBranches: lines(values.protectedBranches),
    mainBranch: String(values.mainBranch ?? "").trim(),
    developBranch: String(values.developBranch ?? "").trim(),
  };
}

/** The owner as "Name (e-mail)", or "Unknown account" when the account is gone. */
export const ownerText = (repo) => (repo.account ? `${repo.account.name} (${repo.account.email})` : "Unknown account");

/** The list for the page: by owner e-mail, then by address. */
export const sortRepos = (repos) =>
  [...repos].sort((a, b) => (a.account?.email ?? "").localeCompare(b.account?.email ?? "") || String(a.url).localeCompare(String(b.url)));

const field = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);

/** Runs `send` for a dialog: shows the error in the dialog and enables the button again, or toasts and closes. Resolves when the dialog is closed. */
function sendFrom({ button, err, send, done, close, state }) {
  if (state.busy) return;
  state.busy = true;
  button.disabled = true;
  err.textContent = "";
  state.pending = (async () => {
    try {
      await send();
    } catch (e) {
      state.busy = false;
      if (state.closed) return toast(plainError(e), "error");
      err.textContent = plainError(e);
      button.disabled = false;
      return;
    }
    toast(done);
    if (!state.closed) close(true);
  })();
}

/** Edits the settings of one repository. Resolves once the dialog is closed and any request has finished. */
export function settingsDialog(repo) {
  const s = repo.settings ?? {};
  const state = { busy: false, closed: false, pending: null };
  const shown = modal("Repository settings", (close) => {
    const els = {
      testCommand: h("input", { name: "testCommand", class: "mono", value: s.testCommand ?? "", autocomplete: "off", placeholder: "npm test" }),
      docs: h("textarea", { name: "docs", rows: 3, class: "mono", placeholder: "docs/CHANGELOG.md" }),
      protectedBranches: h("textarea", { name: "protectedBranches", rows: 3, class: "mono", placeholder: "release/*" }),
      mainBranch: h("input", { name: "mainBranch", class: "mono", value: s.mainBranch ?? "", placeholder: "main", autocomplete: "off" }),
      developBranch: h("input", { name: "developBranch", class: "mono", value: s.developBranch ?? "", placeholder: "develop", autocomplete: "off" }),
    };
    els.docs.value = (s.docs ?? []).join("\n");
    els.protectedBranches.value = (s.protectedBranches ?? []).join("\n");
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const save = h("button", { class: "primary", onClick: () =>
      sendFrom({
        button: save, err, close, state, done: "Settings saved",
        send: () => api.setRepoSettings(repo.id, settingsBody(Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value])))),
      }) }, "Save");
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("p", { class: "mono" }, repo.url),
      field("Test command", els.testCommand),
      field("Docs to update (one path per line)", els.docs),
      field("Protected branches (one pattern per line)", els.protectedBranches, PATTERN_HINT),
      field("Main branch", els.mainBranch),
      field("Develop branch", els.developBranch),
      h("small", {}, "Stored with the repository. Runs do not use these settings yet."),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  shown.then(() => { state.closed = true; });
  return shown.then(() => state.pending);
}

/** Asks for the e-mail of the new owner. Resolves once the dialog is closed and any request has finished. */
export function transferDialog(repo) {
  const state = { busy: false, closed: false, pending: null };
  const shown = modal("Transfer repository", (close) => {
    const email = h("input", { name: "email", type: "text", placeholder: "name@example.com", autocomplete: "off" });
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const note = repo.method === "github-token" || repo.method === "https-token"
      ? "The stored token is deleted. The new owner must set the authentication again. If the new owner is an admin, the repository uses the server's own access until then."
      : repo.method !== "none" ? "The sign-in of this repository stays with it." : null;
    const go = h("button", { class: "primary", onClick: () => {
      if (state.busy) return;
      const to = email.value.trim();
      if (!to) return void (err.textContent = "Fill in the e-mail of the new owner.");
      sendFrom({ button: go, err, close, state, done: "Repository transferred", send: () => api.transferRepo(repo.id, to) });
    } }, "Transfer");
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("p", { class: "mono" }, repo.url),
      h("p", {}, `Owner now: ${ownerText(repo)}`),
      field("E-mail of the new owner", email),
      note ? h("small", {}, note) : null,
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), go));
  });
  shown.then(() => { state.closed = true; });
  return shown.then(() => state.pending);
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("/")[1] ?? "") === "all-repos";
  } catch {
    return false;
  }
};

/** The admin page with the repositories of all accounts. Returns a cleanup. */
export async function renderAllRepos(main) {
  const mine = ++generation;
  const repos = await api.allRepos();
  if (mine !== generation || !onPage()) return () => {};
  const reload = () => renderAllRepos(main).catch((e) => toast(plainError(e), "error"));
  const row = (repo) => h("tr", {},
    h("td", { class: "mono" }, repo.url),
    h("td", {}, ownerText(repo), repo.account?.status === "blocked" ? [" ", h("span", { class: "pill" }, "blocked")] : null),
    h("td", {}, methodLabel(repo, repo.account?.role === "admin")),
    h("td", {}, h("span", { class: "pill" }, connectionStatus(repo))),
    h("td", {},
      h("button", { class: "small", onClick: async () => {
        await settingsDialog(repo);
        reload();
      } }, "Settings"), " ",
      h("button", { class: "small", onClick: async () => {
        await transferDialog(repo);
        reload();
      } }, "Transfer")));
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Repositories"), h("span", { class: "muted" }, "The repositories of all accounts")),
    repos.length
      ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Repository", "Owner", "Authentication", "Connection", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, sortRepos(repos).map(row)))
      : h("div", { class: "empty" }, "No repositories yet."));
  return () => {
    generation++;
  };
}
