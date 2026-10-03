import { api } from "./api.js";
import { h, modal, mount, timeAgo, toast } from "./dom.js";

/**
 * The ways to sign in to a repository. A later method (the GitHub App) is another entry:
 * `fields` are the inputs to show; a `secret` field is never shown again, a `multiline` one is a textarea.
 * An `ssh` method needs an SSH address of the repository, an `https` one an https address.
 */
export const METHODS = [
  {
    id: "github-token",
    https: true,
    label: "GitHub fine-grained personal access token",
    help: [
      "Create a fine-grained personal access token on GitHub, limited to this repository.",
      'Repository permissions: Contents, Issues and Pull requests, each "Read and write".',
    ],
    fields: [{ key: "token", label: "Token", secret: true }],
  },
  {
    id: "https-token",
    https: true,
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
    id: "ssh-deploy-key",
    label: "SSH deploy key",
    ssh: true,
    fields: [],
    help: [
      "The Foundry makes a key pair for this repository and shows you the public key.",
      "Add the public key in the settings of the repository as a deploy key with write access.",
      "Needs the SSH address of the repository (git@host:path or ssh://…).",
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

export const DEPLOY_KEY_HINT =
  'Add this public key in the settings of the repository as a deploy key with write access (on GitHub: Settings → Deploy keys → Add deploy key, with "Allow write access").';

const text = (s) => String(s ?? "").trim();

/** True for an SSH address: ssh://… or git@host:path. */
export const isSshUrl = (url) => /^(ssh:\/\/|git@)/i.test(text(url));

/** Copies text to the clipboard. False when the browser has none (plain http) or refuses. */
export async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** The connection status in a word: "Not tested yet", "Connected" or "Failed". */
export const connectionStatus = (repo) => (!repo?.connection ? "Not tested yet" : repo.connection.ok ? "Connected" : "Failed");

const CHECK_LABELS = { clone: "Read", push: "Write", "github-api": "GitHub API" };

/**
 * The lines of the last test as { ok, text } ("Read: the message"). A failed test shows every check; a good one only
 * the checks that were skipped (they say why something was not checked).
 */
export function connectionLines(repo) {
  const c = repo?.connection;
  if (!c) return [];
  return c.checks
    .filter((x) => !c.ok || x.skipped)
    .map((x) => ({ ok: !!x.ok, text: `${CHECK_LABELS[x.check] ?? x.check}: ${x.message}` }));
}

const connectionCell = (repo) => {
  const c = repo.connection;
  return h("td", {},
    h("span", { class: c ? (c.ok ? "pill ok" : "pill fail") : "pill" }, connectionStatus(repo)),
    c ? [" ", h("span", { class: "muted", title: new Date(c.at).toLocaleString() }, `tested ${timeAgo(c.at)}`)] : null,
    connectionLines(repo).map((l) => h("div", { class: l.ok ? "status ok" : "status bad" }, l.text)));
};

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
    const HTTPS_EXAMPLE = "https://github.com/owner/name";
    const SSH_EXAMPLE = "git@github.com:owner/name.git";
    const urlInput = repo ? null : h("input", { name: "url", class: "mono", placeholder: HTTPS_EXAMPLE, autocomplete: "off" });
    const initial = methods.some((m) => m.id === repo?.method) ? repo.method : methods[0].id;
    const select = h("select", { name: "method" }, methods.map((m) => h("option", { value: m.id }, m.label)));
    select.value = initial;
    const values = repo ? { ...repo } : {};
    delete values.token;
    // the address of the record is not a field value; the SSH address input starts empty
    delete values.url;
    let els = {};
    const area = h("div", { style: { display: "grid", gap: "12px" } });
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const draw = () => {
      const m = methodOf(methods, select.value);
      els = {};
      if (urlInput) urlInput.setAttribute("placeholder", m.ssh ? SSH_EXAMPLE : HTTPS_EXAMPLE);
      // a method whose address form differs from the stored one needs the other form of the address
      const toSsh = repo && m.ssh && !isSshUrl(repo.url);
      const toHttps = repo && m.https && isSshUrl(repo.url);
      if (toSsh || toHttps) {
        els.url = h("input", { name: "url", class: "mono", placeholder: toSsh ? SSH_EXAMPLE : HTTPS_EXAMPLE, autocomplete: "off", value: values.url ?? "" });
      }
      mount(area,
        h("div", { class: "field" }, (m.help ?? []).map((t) => h("small", {}, t))),
        els.url ? h("label", { class: "field" }, h("span", {}, toSsh ? "SSH address" : "HTTPS address"), els.url) : null,
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
      const withUrl = !repo || !!els.url;
      const input = { url: els.url ? v.url : urlInput?.value, method, values: v, methods };
      const needSecret = !repo || method !== repo.method;
      const problem = repoProblem({ ...input, needUrl: withUrl, needSecret });
      if (problem) return void (err.textContent = problem);
      const body = repoBody({ ...input, withUrl });
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
    return h("div", { style: { display: "grid", gap: "12px" } },
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
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("/")[1] ?? "") === "repos";
  } catch {
    return false;
  }
};

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
  const copy = async (value) => {
    if (await copyText(value)) toast("Public key copied");
    else toast("Could not copy. Select the key and copy it yourself.", "error");
  };
  const newKey = (e, repo) => {
    const btn = e.currentTarget;
    if (!confirm(`Generate a new key for ${repo.url}? The old key stops working. Add the new public key as a deploy key and remove the old one.`)) return;
    return whileBusy(btn, async () => {
      try {
        await api.setRepoAuth(repo.id, { newKey: true });
      } catch (err) {
        // the client cannot tell whether a key was made, so there is no retry button
        return reload({ text: plainError(err) });
      }
      toast("New key generated");
      return reload();
    });
  };
  const test = (e, repo) => {
    const btn = e.currentTarget;
    btn.textContent = "Testing…";
    return whileBusy(btn, async () => {
      try {
        const r = await api.testRepo(repo.id);
        if (r.ok) toast("Connection works");
        else toast("Connection failed", "error");
      } catch (err) {
        toast(plainError(err), "error");
      } finally {
        btn.textContent = "Test connection";
      }
      return reload();
    });
  };
  const keyBlock = (repo) => h("div", { class: "field", style: { marginTop: "6px", maxWidth: "520px" } },
    h("span", {}, "Public key"),
    h("code", { class: "mono", style: { wordBreak: "break-all", userSelect: "all" } }, repo.publicKey),
    h("button", { class: "small", onClick: () => copy(repo.publicKey) }, "Copy"),
    h("small", {}, DEPLOY_KEY_HINT));
  const row = (repo) => h("tr", {},
    h("td", { class: "mono" }, repo.url),
    h("td", {}, methodLabel(repo, admin), repo.method === "ssh-deploy-key" && repo.publicKey ? keyBlock(repo) : null),
    connectionCell(repo),
    h("td", {},
      h("button", { class: "small", onClick: (e) => test(e, repo) }, "Test connection"), " ",
      h("button", { class: "small", onClick: async () => {
        await repoDialog({ admin, repo });
        reload();
      } }, "Change authentication"), " ",
      repo.method === "ssh-deploy-key" ? [h("button", { class: "small", onClick: (e) => newKey(e, repo) }, "Generate a new key"), " "] : null,
      h("button", { class: "small danger", onClick: (e) => {
        const btn = e.currentTarget;
        if (!confirm(`Remove ${repo.url}? ${repo.method === "ssh-deploy-key" ? "Its stored key is deleted too." : "Its stored token is deleted too."}`)) return;
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
