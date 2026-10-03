import { api, setCsrf } from "./api.js";
import { h, mount, toast } from "./dom.js";

const PASSWORD_MIN = 10;

const LINK_PREFIX = "#/set-password/";

/** The token in a set-password link (`#/set-password/<token>`), or null for any other hash. */
export function linkToken(hash) {
  const m = /^#\/set-password\/([A-Za-z0-9_-]+)$/.exec(typeof hash === "string" ? hash : "");
  return m ? m[1] : null;
}

/** The hash of a set-password link for a token. */
export const linkHash = (token) => LINK_PREFIX + token;

/** Which form to show: "password" (a set-password link), "setup" (no admin yet), "signin", or null when signed in. */
export function formKind(session, hash) {
  if (linkToken(hash)) return "password";
  if (session?.user) return null;
  return session?.setupNeeded ? "setup" : "signin";
}

/** What is wrong with the input, or "" when it can be sent. v = { name, email, password, repeat }. */
export function formProblem(kind, v) {
  const text = (s) => String(s ?? "").trim();
  if (kind === "password") {
    if (String(v.password ?? "").length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters.`;
    if (v.password !== v.repeat) return "The two passwords are not the same.";
    return "";
  }
  if (kind === "setup") {
    if (!text(v.name) || !text(v.email)) return "Fill in your name and e-mail.";
    if (String(v.password ?? "").length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters.`;
    if (v.password !== v.repeat) return "The two passwords are not the same.";
    return "";
  }
  if (!text(v.email) || !v.password) return "Fill in your e-mail and password.";
  return "";
}

/** The text to show for a failed call. */
export function errorText(e) {
  return e instanceof TypeError ? "Could not reach the server." : e?.message || "Something went wrong.";
}

/** Sends the form. Returns "" on success, else the text to show. Nothing is sent while the input has a problem. */
export async function submitForm(a, kind, v) {
  const problem = formProblem(kind, v);
  if (problem) return problem;
  try {
    if (kind === "password") await a.setPassword(v.token, v.password);
    else if (kind === "setup") await a.setup(v.name.trim(), v.email.trim(), v.password);
    else await a.signIn(v.email.trim(), v.password);
    return "";
  } catch (e) {
    return errorText(e);
  }
}

/** Signs out. Returns "" (after calling reload) on success, else the text to show. */
export async function signOut(a, reload) {
  try {
    await a.signOut();
  } catch (e) {
    return errorText(e);
  }
  reload();
  return "";
}

/** The address bar and its changes; a test passes a fake. Safe where there is no browser. */
const browserPage = {
  hash: () => (typeof location === "undefined" ? "" : location.hash),
  clearHash: () => history.replaceState(null, "", location.pathname + location.search),
  onHashChange: (fn) => typeof window !== "undefined" && window.addEventListener("hashchange", fn),
};

/** `state.kind` is the form shown now; `onPasswordSet` draws the sign-in form after a link was used. */
function renderForm(a, kind, reload, { state, page, token, note } = {}) {
  const setup = kind === "setup";
  const choose = kind === "password";
  const input = (name, label, type, autocomplete) => ({
    name,
    el: h("input", { name, type, autocomplete, required: true }),
    label: h("label", {}, label),
  });
  const fields = choose
    ? [input("password", "New password", "password", "new-password"), input("repeat", "Repeat password", "password", "new-password")]
    : [
        ...(setup ? [input("name", "Name", "text", "name")] : []),
        input("email", "E-mail", setup ? "email" : "text", "username"),
        input("password", "Password", "password", setup ? "new-password" : "current-password"),
        ...(setup ? [input("repeat", "Repeat password", "password", "new-password")] : []),
      ];
  const error = h("p", { class: "status bad" });
  const button = h("button", { type: "submit", class: "primary" }, choose ? "Set password" : setup ? "Create account" : "Sign in");
  const onSubmit = async (e) => {
    e.preventDefault();
    button.disabled = true;
    const values = Object.fromEntries(fields.map((f) => [f.name, f.el.value]));
    const problem = await submitForm(a, kind, choose ? { ...values, token } : values);
    if (!problem && choose) {
      state.kind = "signin";
      page.clearHash();
      return renderForm(a, "signin", reload, { state, page, note: "Your password is set. Sign in with it." });
    }
    if (!problem) return reload();
    error.textContent = problem;
    button.disabled = false;
  };
  const form = h(
    "form",
    { class: "card auth-card", onSubmit },
    h("h2", {}, choose ? "Choose your password" : setup ? "Create the admin account" : "Sign in"),
    setup ? h("p", { class: "muted" }, "There is no account yet. This one will be the admin.") : null,
    choose ? h("p", { class: "muted" }, "Type the password you want to use, twice.") : null,
    note ? h("p", { class: "muted" }, note) : null,
    fields.map((f) => h("div", {}, f.label, f.el)),
    error,
    button,
  );
  mount(document.getElementById("main"), form);
}

/**
 * Resolves with the user once signed in. Otherwise it shows the sign-in (or first admin) form and never resolves:
 * a successful submit reloads the page. `a` and `reload` are arguments so tests can run this without a browser.
 */
export async function ensureSignedIn(a = api, reload = () => location.reload(), page = browserPage) {
  const token = linkToken(page.hash());
  if (token) {
    // A set-password link: no session call. Any hash change leaves the link form, except after the password is set.
    const state = { kind: "password" };
    document.body.classList.add("signed-out");
    renderForm(a, "password", reload, { state, page, token });
    page.onHashChange(() => {
      if (state.kind === "password" || linkToken(page.hash())) reload();
    });
    return new Promise(() => {});
  }
  let session;
  try {
    session = await a.session();
  } catch (e) {
    document.body.classList.add("signed-out");
    mount(document.getElementById("main"), h("div", { class: "errors" }, errorText(e)));
    return new Promise(() => {});
  }
  const kind = formKind(session);
  if (kind) {
    document.body.classList.add("signed-out");
    renderForm(a, kind, reload, { state: { kind }, page });
    page.onHashChange(() => {
      if (linkToken(page.hash())) reload();
    });
    return new Promise(() => {});
  }
  setCsrf(session.csrfToken);
  const out = h(
    "button",
    {
      class: "small",
      type: "button",
      onClick: async () => {
        const problem = await signOut(a, reload);
        if (problem) toast(problem, "error");
      },
    },
    "Sign out",
  );
  const box = document.getElementById("user");
  mount(box, h("span", {}, session.user.name), out);
  box.hidden = false;
  return session.user;
}

/** True for an account with the role admin. */
export const isAdmin = (user) => user?.role === "admin";

/** The pages a user may open: Refinement (and one session), Runs, a run page and My repositories. Anything else becomes the Runs list. */
export function userHash(hash) {
  return /^#\/(runs(\/[\w-]+)?|refinement(\/[\w-]+)?|repos)$/.test(hash ?? "") ? hash : "#/runs";
}

/** The hash to draw. A user never gets a page they may not open; `replace(to)` puts the allowed hash in the address bar. */
export function allowedHash(admin, hash, replace) {
  if (admin) return hash;
  const to = userHash(hash);
  if (to !== hash) replace(to);
  return to;
}

/** Starts the app for the signed-in account: an admin gets the whole start-up, a user only Runs and My repositories. */
export async function startApp(user, { startAdmin, route }) {
  if (isAdmin(user)) return startAdmin();
  document.body.classList.add("role-user");
  return route();
}
