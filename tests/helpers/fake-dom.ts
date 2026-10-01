// A minimal stand-in for the parts of the DOM that `h` in ui/dom.js uses.

export class FakeNode {}

type Listener = (e?: unknown) => unknown;

export class FakeElement extends FakeNode {
  attrs: Record<string, string> = {};
  children: (FakeNode | string)[] = [];
  style: Record<string, string> = {};
  hidden = false;
  value = "";
  disabled = false;
  classList = {
    names: new Set<string>(),
    add: (n: string) => void this.classList.names.add(n),
    remove: (n: string) => void this.classList.names.delete(n),
    contains: (n: string) => this.classList.names.has(n),
  };
  listeners: Record<string, Listener[]> = {};
  parent?: FakeElement;
  private text?: string;
  constructor(public tag: string) {
    super();
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(type: string, fn: Listener) { (this.listeners[type] ??= []).push(fn); }
  /** Calls the listeners of an event type (a submit, for example) with `event`. */
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  private adopt(nodes: (FakeNode | string)[]) { for (const n of nodes) if (n instanceof FakeElement) n.parent = this; }
  append(...nodes: (FakeNode | string)[]) { this.adopt(nodes); this.children.push(...nodes); }
  replaceChildren(...nodes: (FakeNode | string)[]) { this.adopt(nodes); this.text = undefined; this.children = [...nodes]; }
  /** A click as a browser sends it: the listeners of this element, then of each parent, until one calls stopPropagation. */
  click(): void {
    let stopped = false;
    const event = { target: this as FakeElement, currentTarget: this as FakeElement, stopPropagation: () => { stopped = true; } };
    for (let el: FakeElement | undefined = this; el && !stopped; el = el.parent) {
      event.currentTarget = el;
      for (const fn of el.listeners.click ?? []) fn(event);
    }
  }
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
    body: make("body"),
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
