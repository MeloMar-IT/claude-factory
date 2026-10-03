let csrf = "";
/** The CSRF token of the signed-in session; sent with every call that is not a GET. */
export const setCsrf = (t) => {
  csrf = t || "";
};

async function req(method, url, body) {
  const headers = body ? { "content-type": "application/json" } : {};
  if (method !== "GET" && csrf) headers["x-csrf-token"] = csrf;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  // the session ended (expired, revoked, password changed): start again at the sign-in page
  if (r.status === 401 && !url.startsWith("/api/session")) location.reload();
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  session: () => req("GET", "/api/session"),
  signIn: (email, password) => req("POST", "/api/session", { email, password }),
  setPassword: (token, password) => req("POST", "/api/set-password", { token, password }),
  signOut: () => req("DELETE", "/api/session"),
  setup: (name, email, password) => req("POST", "/api/setup", { name, email, password }),
  info: () => req("GET", "/api/info"),
  flows: () => req("GET", "/api/flows"),
  flow: (name) => req("GET", `/api/flows/${enc(name)}`),
  saveFlow: (name, yaml, scope) => req("PUT", `/api/flows/${enc(name)}`, { yaml, scope }),
  deleteFlow: (name) => req("DELETE", `/api/flows/${enc(name)}`),
  blocks: () => req("GET", "/api/blocks"),
  saveBlock: (id, yaml, scope) => req("PUT", `/api/blocks/${enc(id)}`, { yaml, scope }),
  deleteBlock: (id) => req("DELETE", `/api/blocks/${enc(id)}`),
  validate: (yaml) => req("POST", "/api/validate", { yaml }),
  generate: (request, current) => req("POST", "/api/generate", { request, current }),
  runs: (owner) => req("GET", owner ? `/api/runs?owner=${enc(owner)}` : "/api/runs"),
  runOwners: () => req("GET", "/api/run-owners"),
  run: (id) => req("GET", `/api/runs/${enc(id)}`),
  startRun: (body) => req("POST", "/api/runs", body),
  cancelRun: (id) => req("POST", `/api/runs/${enc(id)}/cancel`, {}),
  resumeRun: (id, from) => req("POST", `/api/runs/${enc(id)}/resume`, { from }),
  approveRun: (id, note) => req("POST", `/api/runs/${enc(id)}/approve`, { note }),
  rejectRun: (id, note) => req("POST", `/api/runs/${enc(id)}/reject`, { note }),
  transcript: (id, n) => req("GET", `/api/runs/${enc(id)}/transcript/${n}`),
  diff: (id) => req("GET", `/api/runs/${enc(id)}/diff`),
  queue: () => req("GET", "/api/queue"),
  config: () => req("GET", "/api/config"),
  saveConfig: (config) => req("PUT", "/api/config", config),
  watchers: () => req("GET", "/api/watchers"),
  tickWatcher: (id) => req("POST", `/api/watchers/${enc(id)}/tick`, {}),
  providers: () => req("GET", "/api/providers"),
  testModel: (spec) => req("POST", "/api/providers/test", { spec }),
  next: () => req("GET", "/api/next"),
  health: () => req("GET", "/api/health"),
  yourTurn: () => req("GET", "/api/your-turn"),
  since: (from) => req("GET", `/api/since?since=${enc(from)}`),
  dismissTurn: (key) => req("POST", "/api/your-turn/dismiss", { key }),
  restoreTurn: () => req("POST", "/api/your-turn/restore", {}),
  turnDetail: (key) => req("GET", `/api/your-turn/detail?key=${enc(key)}`),
  actTurn: (body) => req("POST", "/api/your-turn/act", body),
  board: () => req("GET", "/api/board"),
  stats: () => req("GET", "/api/stats"),
  evals: () => req("GET", "/api/evals"),
  clean: (opts) => req("POST", "/api/clean", opts),
  events: (id) => new EventSource(`/api/runs/${enc(id)}/events`),
};
