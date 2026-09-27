import { h } from "./dom.js";

// ── bound inputs: each writes into obj[key] (deleting when empty) and calls onChange ──

export function setKey(obj, key, v) {
  if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete obj[key];
  else obj[key] = v;
}

export function text(obj, key, onChange, { placeholder, mono, list, type = "text", onCommit } = {}) {
  return h("input", {
    type, placeholder, list, class: mono ? "mono" : null,
    value: obj[key] ?? "",
    onInput: (e) => {
      const raw = e.target.value;
      setKey(obj, key, type === "number" ? (raw === "" ? "" : Number(raw)) : raw);
      onChange();
    },
    onChange: onCommit,
  });
}

export function area(obj, key, onChange, { rows = 4, placeholder } = {}) {
  return h("textarea", {
    rows, placeholder, value: obj[key] ?? "",
    onInput: (e) => { setKey(obj, key, e.target.value); onChange(); },
  });
}

export function select(obj, key, options, onChange, { emptyLabel } = {}) {
  const opts = emptyLabel != null ? [["", emptyLabel], ...options] : options;
  return h("select", { onChange: (e) => { setKey(obj, key, e.target.value); onChange(); } },
    opts.map(([v, l]) => h("option", { value: v, selected: (obj[key] ?? "") === v }, l)));
}

export function list(obj, key, onChange, placeholder) {
  return h("input", {
    placeholder, class: "mono", value: (obj[key] ?? []).join(", "),
    onInput: (e) => {
      setKey(obj, key, e.target.value.split(",").map((s) => s.trim()).filter(Boolean));
      onChange();
    },
  });
}

export const field = (label, input, hint) => h("label", { class: "field" }, h("span", {}, label), input, hint ? h("small", {}, hint) : null);

export function insertAtCursor(textarea, snippet) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  textarea.value = value.slice(0, a) + snippet + value.slice(b);
  textarea.selectionStart = textarea.selectionEnd = a + snippet.length;
  textarea.dispatchEvent(new Event("input"));
  textarea.focus();
}

