async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
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
  runs: () => req("GET", "/api/runs"),
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
  stats: () => req("GET", "/api/stats"),
  events: (id) => new EventSource(`/api/runs/${enc(id)}/events`),
};
