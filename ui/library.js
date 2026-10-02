import YAML from "/vendor/yaml/index.js";
import { api } from "./api.js";
import { h, modal, mount, toast } from "./dom.js";

const RESERVED = ["next", "end", "fail", "stop"];
const CATEGORY_ORDER = ["GitHub", "Git", "Claude", "Agents", "Checks"];

function byCategory(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const cat = b.block?.category ?? "Invalid";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(b);
  }
  const rank = (c) => (CATEGORY_ORDER.indexOf(c) + 1 || 99);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Insert a block's steps at `at`, renaming ids that already exist (and the block's own references to them). */
export function insertBlock(flow, block, at) {
  const taken = new Set(flow.steps.map((s) => s.id));
  const rename = {};
  for (const s of block.steps) {
    let id = s.id;
    for (let n = 2; taken.has(id); n++) id = `${s.id}${n}`;
    rename[s.id] = id;
    taken.add(id);
  }
  const steps = block.steps.map((s) => {
    const c = structuredClone(s);
    c.id = rename[s.id];
    for (const k of ["on_success", "on_failure", "resume"]) if (c[k] && rename[c[k]]) c[k] = rename[c[k]];
    return c;
  });
  flow.steps.splice(at, 0, ...steps);
  flow.vars ??= {};
  for (const [k, v] of Object.entries(block.vars ?? {})) if (!(k in flow.vars)) flow.vars[k] = v;
  const renamed = Object.entries(rename).filter(([a, b]) => a !== b);
  return { count: steps.length, renamed };
}

function blockCard(b, onClick) {
  const blk = b.block;
  return h("button", { class: "block-card", onClick, disabled: !blk, title: b.error ?? "" },
    h("span", { class: "row" }, h("b", {}, blk?.name ?? b.id), h("span", { class: "spacer" }), b.scope !== "builtin" ? h("span", { class: "pill" }, b.scope) : null),
    h("span", { class: "muted d" }, blk?.description ?? b.error ?? ""),
    h("span", { class: "chips" }, (blk?.steps ?? []).map((s) =>
      h("span", { class: `pill ${s.type}` }, `${s.type === "claude" ? "◆" : "$"} ${s.id}${s.jump_only ? " ↪" : ""}`))));
}

/** Modal to pick a block. Resolves with the block listing or undefined. */
export async function pickBlock() {
  const blocks = await api.blocks();
  return modal("Insert from library", (close) => {
    const list = h("div");
    const search = h("input", { placeholder: "Search blocks…", onInput: () => draw() });
    const draw = () => {
      const q = search.value.toLowerCase();
      const hits = blocks.filter((b) => !q || `${b.id} ${b.block?.name} ${b.block?.description} ${b.block?.category}`.toLowerCase().includes(q));
      mount(list, byCategory(hits).map(([cat, items]) =>
        h("div", { class: "block-group" }, h("h3", {}, cat), h("div", { class: "block-grid" }, items.map((b) => blockCard(b, () => close(b)))))));
    };
    draw();
    return h("div", { style: { display: "grid", gap: "12px" } }, search, list);
  });
}

/** Variables a step refers to, via {{vars.x}} or $FACTORY_VAR_X / $SCF_VAR_X. */
function referencedVars(step, flowVars) {
  const text = JSON.stringify(step);
  return Object.fromEntries(Object.entries(flowVars ?? {}).filter(([k]) => {
    const suffix = k.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return text.includes(`vars.${k}`) || text.includes(`FACTORY_VAR_${suffix}`) || text.includes(`SCF_VAR_${suffix}`);
  }));
}

/** Save one step (plus the vars it uses) as a reusable block. */
export async function saveStepAsBlock(flow, step) {
  const blocks = await api.blocks();
  const categories = [...new Set(blocks.map((b) => b.block?.category).filter(Boolean))];
  const saved = await modal("Save step as block", (close) => {
    const id = h("input", { class: "mono", value: step.id.replace(/_/g, "-") });
    const name = h("input", { value: step.description ?? step.id });
    const category = h("input", { value: "Custom", list: "block-cats" });
    const description = h("input", { placeholder: "What this block does" });
    const scope = h("select", {}, h("option", { value: "global" }, "global (all repos)"), h("option", { value: "repo" }, "this repo"));
    const err = h("p", { class: "status bad", style: { margin: 0 } });
    const save = h("button", { class: "primary", onClick: async () => {
      if (!/^[\w-]+$/.test(id.value)) return (err.textContent = "Id may only contain letters, digits, _ and -");
      if (blocks.some((b) => b.id === id.value && b.scope !== "builtin") && !confirm(`Overwrite block "${id.value}"?`)) return;
      const s = structuredClone(step);
      // Blocks must be self-contained: drop jumps/resume that point at other steps.
      for (const k of ["on_success", "on_failure"]) if (s[k] && !RESERVED.includes(s[k])) delete s[k];
      delete s.resume;
      const block = { name: name.value || id.value, category: category.value || "Custom", description: description.value || undefined, vars: referencedVars(step, flow.vars), steps: [s] };
      if (!Object.keys(block.vars).length) delete block.vars;
      try {
        await api.saveBlock(id.value, YAML.stringify(block, { lineWidth: 0 }), scope.value);
        close(id.value);
      } catch (e) {
        err.textContent = e.message;
      }
    } }, "Save block");
    const f = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("datalist", { id: "block-cats" }, categories.map((c) => h("option", { value: c }))),
      h("div", { class: "grid" }, f("Id (file name)", id), f("Category", category)),
      f("Name", name), f("Description", description), f("Save to", scope),
      h("small", { class: "muted" }, "Jumps to other steps are removed so the block works in any flow."),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
  if (saved) toast(`Saved block "${saved}" to the library`);
}

/** The Library page: browse blocks, view their YAML, delete your own. */
export async function renderLibrary(main) {
  mount(main, h("div", { class: "row" }, h("span", { class: "spinner" }), " Loading library…"));
  const blocks = await api.blocks();
  const draw = (items) => mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Block library"), h("span", { class: "muted" }, `${items.length} blocks`)),
    h("p", { class: "muted", style: { marginTop: "-6px" } },
      "Reusable steps you can drop into any flow with “+ From library”. Create your own with “☆ Save as block” on any step."),
    byCategory(items).map(([cat, list]) => h("div", { class: "block-group" }, h("h3", {}, cat),
      h("div", { class: "block-grid" }, list.map((b) => h("div", { class: "block-item" },
        blockCard(b, null),
        h("details", {}, h("summary", {}, "YAML"), h("pre", { class: "mono" }, b.yaml)),
        b.scope !== "builtin" ? h("button", { class: "small danger", onClick: async () => {
          if (!confirm(`Delete block "${b.id}"?`)) return;
          await api.deleteBlock(b.id).catch((e) => toast(e.message, "error"));
          draw(await api.blocks());
        } }, "Delete") : null))))));
  draw(blocks);
}
