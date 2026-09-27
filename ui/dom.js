/** Tiny hyperscript helper: h("div", {class: "x", onClick}, ...children). */
export function h(tag, props = {}, ...children) {
  const el = tag === "svg" || props?.svg
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false || k === "svg") continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.setAttribute("class", v);
    else if (k === "value" || k === "checked") el[k] = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const svg = (tag, props = {}, ...children) => h(tag, { ...props, svg: true }, ...children);

export function mount(target, ...nodes) {
  target.replaceChildren(...nodes.flat().filter(Boolean));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

let toastTimer;
export function toast(msg, kind = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3500);
}

/** Show a modal; `build(close)` returns its content. Resolves with the value passed to close(). */
export function modal(title, build) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const close = (v) => {
      root.replaceChildren();
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === "Escape" && close(undefined);
    document.addEventListener("keydown", onKey);
    mount(root, h("div", { class: "backdrop", onMousedown: (e) => e.target === e.currentTarget && close(undefined) },
      h("div", { class: "modal", role: "dialog", "aria-label": title },
        h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { class: "icon", onClick: () => close(undefined), "aria-label": "Close" }, "✕")),
        build(close))));
    root.querySelector("textarea, input")?.focus();
  });
}

export function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
