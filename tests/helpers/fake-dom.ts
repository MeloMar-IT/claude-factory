// A minimal stand-in for the parts of the DOM that `h` in ui/dom.js uses.

export class FakeNode {}

type Listener = (e?: unknown) => unknown;

export class FakeElement extends FakeNode {
  attrs: Record<string, string> = {};
  children: (FakeNode | string)[] = [];
  style: Record<string, string> = {};
  hidden = false;
  listeners: Record<string, Listener[]> = {};
  private text?: string;
  constructor(public tag: string) {
    super();
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  append(...nodes: (FakeNode | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (FakeNode | string)[]) { this.text = undefined; this.children = [...nodes]; }
  get textContent(): string {
    if (this.text !== undefined) return this.text;
    return this.children.map((c) => (typeof c === "string" ? c : c instanceof FakeElement ? c.textContent : "")).join("");
  }
  set textContent(v: string) { this.children = []; this.text = v; }
  all(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tag === tag ? [c] : []), ...c.all(tag)] : []));
  }
}

/** Installs `document` and `Node` on globalThis; returns a function that restores them. */
export function installFakeDom(): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, Node: g.Node };
  const make = (tag: string) => new FakeElement(tag);
  const byId = new Map<string, FakeElement>();
  const listeners: Record<string, Listener[]> = {};
  g.document = {
    createElement: make,
    createElementNS: (_ns: string, tag: string) => make(tag),
    getElementById: (id: string) => byId.get(id) ?? byId.set(id, make("div")).get(id),
    title: "",
    visibilityState: "visible",
    listeners,
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: Listener) => { listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn); },
  };
  g.Node = FakeNode;
  return () => {
    g.document = saved.document;
    g.Node = saved.Node;
  };
}
