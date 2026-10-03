import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/admin.js" as string);
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("serverFrom", () => {
  it("defaults the address", () => expect(ui.serverFrom({ listen: "" }).listen).toBe("127.0.0.1"));
  it("splits host names on commas and spaces", () => {
    expect(ui.serverFrom({ hosts: " a.test, b.test:8443  c.test " }).allowed_hosts).toEqual(["a.test", "b.test:8443", "c.test"]);
    expect(ui.serverFrom({ hosts: "" }).allowed_hosts).toEqual([]);
  });
  it("makes insecure a boolean", () => {
    expect(ui.serverFrom({ insecure: undefined }).allow_insecure_http).toBe(false);
    expect(ui.serverFrom({ insecure: true }).allow_insecure_http).toBe(true);
  });
});

/** Renders Settings against a stubbed API; returns the page and the PUT bodies. */
async function render(server: Record<string, unknown>, listening = "127.0.0.1", putStatus = 200) {
  const config = { ...ConfigSchema.parse({}), server: { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false, ...server } };
  const puts: any[] = [];
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      puts.push(JSON.parse(init.body!));
      return { ok: putStatus === 200, status: putStatus, statusText: "x", json: async () => (putStatus === 200 ? config : { error: "invalid config: nope" }) };
    }
    const body = url.endsWith("/api/info") ? { configPath: "/x/config.yaml", spentToday: 0, listening } : config;
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };
  const main = new FakeElement("main");
  await ui.renderSettings(main);
  const cards = main.all("div").filter((d) => d.attrs.class === "card");
  const card = cards.find((c) => c.all("h3")[0]?.textContent === "Network")!;
  return { main, card, puts };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Settings → Network", () => {
  it("shows the settings and the plain-HTTP warning", async () => {
    const { card } = await render({ listen: "::1", allowed_hosts: ["a.test", "b.test"], allow_insecure_http: true });
    expect(card).toBeDefined();
    expect(card.all("select")[0]!.value).toBe("::1");
    expect(card.all("input").find((i) => i.attrs.placeholder === "mymac.local")!.value).toBe("a.test, b.test");
    expect((card.all("input").find((i) => i.attrs.type === "checkbox") as any).checked).toBe(true);
    expect(card.textContent).toContain("passwords and session cookies cross the network unencrypted");
  });

  it("says when a restart is needed", async () => {
    const differ = await render({ listen: "0.0.0.0" }, "127.0.0.1");
    expect(differ.card.textContent).toContain("Now listening on 127.0.0.1 — restart the server to use 0.0.0.0");
    const same = await render({ listen: "127.0.0.1" }, "127.0.0.1");
    expect(same.card.textContent).not.toContain("Now listening on");
  });

  it("saves the three controls and keeps the other settings", async () => {
    const { main, card, puts } = await render({});
    card.all("select")[0]!.value = "0.0.0.0";
    card.all("input").find((i) => i.attrs.placeholder === "mymac.local")!.value = "mymac.local";
    (card.all("input").find((i) => i.attrs.type === "checkbox") as any).checked = true;
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].server).toEqual({ listen: "0.0.0.0", allowed_hosts: ["mymac.local"], allow_insecure_http: true });
    expect(puts[0].concurrency).toBe(2);
    expect(puts[0].protected_branches).toContain("main");
  });

  it("shows the message of a failed save", async () => {
    const { main, puts } = await render({}, "127.0.0.1", 400);
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts).toHaveLength(1);
    expect(main.textContent).toContain("invalid config: nope");
  });
});

describe("Settings → Safety", () => {
  const hotfixBox = (main: FakeElement) => main.all("label").find((l) => l.textContent.includes("Hotfixes"))!.all("input")[0] as any;

  it("shows the hotfix switch unchecked and saves it when switched on", async () => {
    const { main, puts } = await render({});
    expect(!!hotfixBox(main).checked).toBe(false);
    hotfixBox(main).checked = true;
    main.all("button").find((b) => b.textContent === "Save")!.click();
    await flush();
    expect(puts[0].hotfix_to_main).toBe(true);
  });
});
