// A minimal stand-in for the parts of the DOM that `h` in ui/dom.js uses.

export class FakeNode {}

export class FakeElement extends FakeNode {
  attrs: Record<string, string> = {};
  children: (FakeNode | string)[] = [];
  style: Record<string, string> = {};
  constructor(public tag: string) {
    super();
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener() {}
  append(...nodes: (FakeNode | string)[]) { this.children.push(...nodes); }
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c instanceof FakeElement ? c.textContent : "")).join("");
  }
  all(tag: string): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [...(c.tag === tag ? [c] : []), ...c.all(tag)] : []));
  }
}

/** Installs `document` and `Node` on globalThis; returns a function that restores them. */
export function installFakeDom(): () => void {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, Node: g.Node };
  const make = (tag: string) => new FakeElement(tag);
  g.document = { createElement: make, createElementNS: (_ns: string, tag: string) => make(tag) };
  g.Node = FakeNode;
  return () => {
    g.document = saved.document;
    g.Node = saved.Node;
  };
}
