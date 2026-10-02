import { api } from "./api.js";
import { h, modal, mount, toast } from "./dom.js";

/**
 * The ways to sign in to a repository. A later method (an SSH deploy key, a GitHub App) is another entry:
 * `fields` are the inputs to show; a `secret` field is never shown again, a `multiline` one is a textarea.
 */
export const METHODS = [
  {
    id: "github-token",
    label: "GitHub fine-grained personal access token",
    help: [
      "Create a fine-grained personal access token on GitHub, limited to this repository.",
      'Repository permissions: Contents, Issues and Pull requests, each "Read and write".',
    ],
    fields: [{ key: "token", label: "Token", secret: true }],
  },
  {
    id: "https-token",
    label: "HTTPS user name + token",
    help: [
      "For other git hosts. Use your user name on that host and an access token, not your password.",
      "The token must be allowed to read and write the repository.",
    ],
    fields: [
      { key: "username", label: "User name" },
      { key: "token", label: "Token", secret: true },
    ],
  },
  {
    id: "none",
    label: "The server's own access",
    help: ["The server uses its own access to this repository. No token is stored."],
    fields: [],
  },
];

/** The methods an account may choose: only an admin may use the server's own access. */
export const methodsFor = (admin) => METHODS.filter((m) => admin || m.id !== "none");

/** How the repository signs in, in words. */
export function methodLabel(repo, admin) {
  const m = METHODS.find((x) => x.id === repo.method);
  if (!m) return String(repo.method);
  if (m.id === "none") return admin ? m.label : "Needs authentication";
  return m.id === "https-token" && repo.username ? `${m.label} (${repo.username})` : m.label;
}

/** The connection status. Until the connection test exists, every repository is untested. */
export const connectionStatus = (_repo) => "Not tested yet";

const text = (s) => String(s ?? "").trim();
const methodOf = (methods, id) => methods.find((m) => m.id === id) ?? { id, fields: [] };

/** What is missing in the input, or "" when it can be sent. */
export function repoProblem({ url, method, values = {}, needUrl = true, needSecret = true, methods = METHODS }) {
  if (needUrl && !text(url)) return "Fill in the repository URL.";
  for (const f of methodOf(methods, method).fields) {
    if (f.secret && !needSecret) continue;
    if (!text(values[f.key])) return `Fill in the ${f.label.toLowerCase()}.`;
  }
  return "";
}

/** The request body: only the fields of the chosen method, trimmed; an empty secret is left out. */
export function repoBody({ url, method, values = {}, withUrl = true, methods = METHODS }) {
  const body = withUrl ? { url: text(url), method } : { method };
  for (const f of methodOf(methods, method).fields) {
    const v = text(values[f.key]);
    if (v || !f.secret) body[f.key] = v;
  }
  return body;
}

/** The server's sentence for a failed call, with method ids written as their names. */
export function plainError(e) {
  if (e instanceof TypeError) return "Could not reach the server.";
  const message = e?.message || "Something went wrong.";
  return message.replace(/"([\w-]+)"/g, (all, id) => {
    const m = METHODS.find((x) => x.id === id);
    return m && id !== "none" ? m.label : all;
  });
}

/**
 * Asks for the URL (when adding) and the method. Resolves once the dialog is closed and any request that
 * was started has finished; the caller then loads the list again.
 */
export function repoDialog({ admin = false, methods = methodsFor(admin), repo } = {}) {
  let pending = null;
  let closed = false;
  const shown = modal(repo ? "Change authentication" : "Add repository", (close) => {
    const urlInput = repo ? null : h("input", { name: "url", class: "mono", placeholder: "https://github.com/owner/name", autocomplete: "off" });
    const initial = methods.some((m) => m.id === repo?.method) ? repo.method : methods[0].id;
    const select = h("select", { name: "method" }, methods.map((m) => h("option", { value: m.id }, m.label)));
    select.value = initial;
    const values = repo ? { ...repo } : {};
    delete values.token;
    let els = {};
    const area = h("div", {});
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const draw = () => {
      const m = methodOf(methods, select.value);
      els = {};
      mount(area,
        h("div", { class: "field" }, (m.help ?? []).map((t) => h("small", {}, t))),
        m.fields.map((f) => {
          const attrs = { name: f.key, autocomplete: f.secret ? "new-password" : "off" };
          els[f.key] = f.multiline
            ? h("textarea", { ...attrs, rows: 5, class: "mono" })
            : h("input", { ...attrs, type: f.secret ? "password" : "text", value: f.secret ? "" : values[f.key] ?? "" });
          return h("label", { class: "field" }, h("span", {}, f.label), els[f.key]);
        }));
    };
    const read = () => Object.fromEntries(Object.entries(els).map(([k, el]) => [k, el.value]));
    select.addEventListener("change", () => {
      // keep what was typed in plain fields; a secret is not carried over to another method
      for (const [k, v] of Object.entries(read())) if (!methods.some((m) => m.fields.some((f) => f.key === k && f.secret))) values[k] = v;
      draw();
      err.textContent = "";
    });
    draw();

    let busy = false;
    const run = () => {
      if (busy) return;
      const method = select.value;
      const v = read();
      const input = { url: urlInput?.value, method, values: v, methods };
      const needSecret = !repo || method !== repo.method;
      const problem = repoProblem({ ...input, needUrl: !repo, needSecret });
      if (problem) return void (err.textContent = problem);
      const body = repoBody({ ...input, withUrl: !repo });
      if (repo) {
        const same = method === repo.method && Object.entries(body).every(([k, x]) => k === "method" || (k !== "token" && x === repo[k]));
        if (same) return close(true);
      }
      busy = true;
      save.disabled = true;
      err.textContent = "";
      pending = (async () => {
        try {
          if (repo) await api.setRepoAuth(repo.id, body);
          else await api.addRepo(body);
        } catch (e) {
          busy = false;
          if (closed) return toast(plainError(e), "error");
          err.textContent = plainError(e);
          save.disabled = false;
          return;
        }
        toast(repo ? "Authentication changed" : "Repository added");
        if (!closed) close(true);
      })();
    };
    const save = h("button", { class: "primary", onClick: run }, repo ? "Save" : "Add repository");
    return h("div", { class: "modal-body" },
      repo ? h("p", { class: "mono" }, repo.url) : h("label", { class: "field" }, h("span", {}, "Repository URL"), urlInput),
      h("label", { class: "field" }, h("span", {}, "Authentication"), select),
      area, err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  shown.then(() => { closed = true; });
  return shown.then(() => pending);
}

async function whileBusy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => typeof location === "undefined" || location.hash === "#/repos";

/** The My repositories page. `notice` ({ text, retryId }) is a message kept from the last removal. Returns a cleanup. */
export async function renderRepos(main, { admin = false, notice } = {}) {
  const mine = ++generation;
  const repos = await api.repos();
  if (mine !== generation || !onPage()) return () => {};
  const reload = (next) => renderRepos(main, { admin, notice: next }).catch((e) => toast(plainError(e), "error"));
  const remove = async (id, again = false) => {
    try {
      await api.removeRepo(id);
    } catch (e) {
      // a repeat that finds no repository: the first try removed it, and the old key is gone now
      if (!(again && e.status === 404)) return reload({ text: plainError(e), retryId: e.status === 500 ? id : undefined });
    }
    toast("Repository removed");
    return reload();
  };
  const add = async () => {
    await repoDialog({ admin });
    reload();
  };
  const row = (repo) => h("tr", {},
    h("td", { class: "mono" }, repo.url),
    h("td", {}, methodLabel(repo, admin)),
    h("td", {}, h("span", { class: "pill" }, connectionStatus(repo))),
    h("td", {},
      h("button", { class: "small", onClick: async () => {
        await repoDialog({ admin, repo });
        reload();
      } }, "Change authentication"), " ",
      h("button", { class: "small danger", onClick: (e) => {
        const btn = e.currentTarget;
        if (!confirm(`Remove ${repo.url}? Its stored token is deleted too.`)) return;
        return whileBusy(btn, () => remove(repo.id));
      } }, "Remove")));
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "My repositories"),
      h("span", { class: "muted" }, "The repositories you work in, and how the Foundry signs in to them"),
      h("span", { class: "spacer" }), h("button", { class: "primary", onClick: add }, "+ Add repository")),
    notice ? h("p", { class: "status bad" }, notice.text,
      notice.retryId ? [" ", h("button", { class: "small", onClick: (e) => {
        const btn = e.currentTarget;
        return whileBusy(btn, () => remove(notice.retryId, true));
      } }, "Try again")] : null) : null,
    repos.length
      ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Repository", "Authentication", "Connection", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, repos.map(row)))
      : h("div", { class: "empty" }, "No repositories yet. Add the repository you work in.", h("div", {}, h("button", { class: "primary", onClick: add }, "+ Add repository"))));
  return () => {
    generation++;
  };
}
