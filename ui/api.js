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
  validate: (yaml) => req("POST", "/api/validate", { yaml }),
  generate: (request, current) => req("POST", "/api/generate", { request, current }),
  runs: () => req("GET", "/api/runs"),
  run: (id) => req("GET", `/api/runs/${enc(id)}`),
  startRun: (body) => req("POST", "/api/runs", body),
  cancelRun: (id) => req("POST", `/api/runs/${enc(id)}/cancel`, {}),
  events: (id) => new EventSource(`/api/runs/${enc(id)}/events`),
};
