import { h, svg } from "./dom.js";

const W = 200, H = 48, GAP = 34, X = 16, TOP = 12, LANE = 18;

/** Next step in top-to-bottom order (jump_only steps are skipped). */
function nextSequential(steps, i) {
  while (i < steps.length && steps[i].jump_only) i++;
  return i;
}

function targetIndex(steps, i, target) {
  if (target === "next") return nextSequential(steps, i + 1); // may equal steps.length → END
  if (target === "end") return steps.length;
  if (target === "fail" || target === "stop") return -1;
  const j = steps.findIndex((s) => s.id === target);
  return j === -1 ? -2 : j; // -2: dangling reference
}

const ICON = { claude: "◆", shell: "$", approval: "✋", parallel: "⇉", flow: "⧉" };

function subtitle(s) {
  if (s.type === "shell") return "$ " + (s.run ?? "").split("\n")[0];
  if (s.type === "approval") return s.message ?? "";
  if (s.type === "parallel") return (s.steps ?? []).join(" + ");
  if (s.type === "flow") return `flow: ${s.flow ?? ""}`;
  return (s.model ? `${s.model} · ` : "") + (s.resume ? `↺ ${s.resume}` : (s.prompt ?? "").split("\n")[0]);
}

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/**
 * Render a flow as a vertical node list with jump arcs on the right.
 * Green = on_success, red dashed = on_failure, grey = fall-through to next.
 */
export function renderGraph(flow, { selected, onSelect } = {}) {
  const steps = Array.isArray(flow?.steps) ? flow.steps.filter((s) => s && typeof s === "object") : [];
  if (!steps.length) return h("div", { class: "empty" }, "No steps yet");

  const y = (i) => TOP + i * (H + GAP);
  const edges = [];
  steps.forEach((s, i) => {
    const ok = targetIndex(steps, i, s.on_success ?? "next");
    const fail = targetIndex(steps, i, s.on_failure ?? "fail");
    edges.push({ from: i, to: ok, kind: "ok", label: s.on_success });
    if (s.on_failure) edges.push({ from: i, to: fail, kind: "fail", label: s.on_failure });
    for (const r of s.routes ?? []) edges.push({ from: i, to: targetIndex(steps, i, r.goto), kind: "route", label: r.if });
    if (s.type === "parallel") for (const id of s.steps ?? []) edges.push({ from: i, to: steps.findIndex((x) => x.id === id), kind: "par" });
  });

  // Straight edges go down the middle; everything else gets its own lane on the right.
  let lanes = 0;
  const arcs = [];
  const straight = [];
  for (const e of edges) {
    if (e.to < 0) continue;
    if (e.to === e.from + 1 && e.kind === "ok") straight.push(e);
    else arcs.push({ ...e, lane: lanes++ });
  }

  const width = X + W + 24 + lanes * LANE + 16;
  const height = y(steps.length) + H + TOP;
  const cx = X + W / 2;
  const defs = svg("defs", {},
    ["ok", "fail", "seq", "route", "par"].map((k) =>
      svg("marker", { id: `arrow-${k}`, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" },
        svg("path", { d: "M0,0 L10,5 L0,10 z", class: `arrow ${k}` }))));

  const lines = straight.map((e) =>
    svg("path", { class: "edge seq", d: `M${cx},${y(e.from) + H} L${cx},${y(e.to) - 2}`, "marker-end": "url(#arrow-seq)" }));

  const arcEls = arcs.map((e) => {
    const x0 = X + W;
    const lx = x0 + 24 + e.lane * LANE;
    const y0 = y(e.from) + H / 2 + ({ fail: 8, route: 0, par: 0 }[e.kind] ?? -8);
    const y1 = y(e.to) + H / 2 + (e.to > e.from ? -8 : 8);
    const r = 8;
    const dir = y1 > y0 ? 1 : -1;
    const d = `M${x0},${y0} L${lx - r},${y0} Q${lx},${y0} ${lx},${y0 + r * dir} L${lx},${y1 - r * dir} Q${lx},${y1} ${lx - r},${y1} L${x0 + 2},${y1}`;
    return svg("g", {},
      svg("path", { class: `edge ${e.kind}`, d, "marker-end": `url(#arrow-${e.kind})` }),
      svg("title", {}, `${steps[e.from].id} ${{ ok: "on success", fail: "on failure", route: `if /${e.label}/`, par: "runs in parallel" }[e.kind]} → ${e.to === steps.length ? "end" : steps[e.to]?.id}`));
  });

  const nodes = steps.map((s, i) =>
    svg("g", { class: `node${selected === i ? " sel" : ""}${s.jump_only ? " jump" : ""}`, transform: `translate(${X},${y(i)})`, onClick: () => onSelect?.(i) },
      svg("rect", { width: W, height: H, rx: 8 }),
      svg("rect", { class: `bar ${s.type}`, width: 4, height: H - 12, x: 6, y: 6, rx: 2 }),
      svg("text", { x: 18, y: 20, "font-weight": 600, "font-size": 13 }, clip(`${ICON[s.type] ?? "?"} ${s.id ?? "?"}`, 26)),
      svg("text", { x: 18, y: 37, class: "sub" }, clip(subtitle(s), 28)),
      s.on_success === "stop" || s.on_failure === "stop"
        ? svg("text", { x: W - 8, y: 20, "text-anchor": "end", class: "sub stop" }, "■ stop") : null,
      svg("title", {}, (s.jump_only ? "[only via jumps] " : "") + (s.description ?? s.id ?? ""))));

  const end = svg("g", { class: "terminal", transform: `translate(${X},${y(steps.length)})` },
    svg("rect", { width: W, height: H, rx: 24 }),
    svg("text", { x: W / 2, y: H / 2 + 4, "text-anchor": "middle", class: "sub" }, "end ✓"));

  const dangling = edges.filter((e) => e.to === -2);
  return h("div", {},
    svg("svg", { class: "graph", width, height, viewBox: `0 0 ${width} ${height}` }, defs, lines, arcEls, nodes, end),
    h("div", { class: "legend" },
      h("span", {}, h("i", { style: { borderColor: "var(--muted)" } }), "next"),
      h("span", {}, h("i", { style: { borderColor: "var(--ok)" } }), "on success"),
      h("span", {}, h("i", { style: { borderColor: "var(--fail)", borderTopStyle: "dashed" } }), "on failure"),
      h("span", {}, h("i", { style: { borderColor: "var(--route)" } }), "route"),
      h("span", {}, h("i", { style: { borderColor: "var(--muted)", borderTopStyle: "dotted" } }), "parallel")),
    dangling.length ? h("p", { class: "status bad" }, `${dangling.length} jump(s) point to missing steps`) : null);
}
