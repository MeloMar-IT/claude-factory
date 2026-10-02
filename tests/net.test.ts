import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type ServerConfig } from "../src/config.js";
import { access, hostAllowed, isLoopback, listenCovers, listenProblem, localUrl, sameOrigin } from "../src/server/net.js";

const PORT = 4777;

describe("isLoopback", () => {
  it.each(["127.0.0.1", "127.5.5.5", "::1", "::ffff:127.0.0.1"])("%s is local", (a) => expect(isLoopback(a)).toBe(true));
  it.each(["0.0.0.0", "::", "192.168.1.5", "::ffff:10.0.0.1", undefined, "", "0:0:0:0:0:0:0:1", "::ffff:7f00:1"])("%s is not", (a) =>
    expect(isLoopback(a as string | undefined)).toBe(false));
});

describe("hostAllowed", () => {
  it.each(["localhost:4777", "127.0.0.1:4777", "[::1]:4777"])("%s passes with no settings", (h) => expect(hostAllowed(h, [], PORT)).toBe(true));
  it.each(["localhost:4778", "localhost", "127.0.0.2:4777", ""])("%s fails with no settings", (h) => expect(hostAllowed(h, [], PORT)).toBe(false));
  it("matches a name without port on the server port or no port", () => {
    expect(hostAllowed("mymac.local", ["mymac.local"], PORT)).toBe(true);
    expect(hostAllowed("mymac.local:4777", ["mymac.local"], PORT)).toBe(true);
    expect(hostAllowed("mymac.local:8443", ["mymac.local"], PORT)).toBe(false);
    expect(hostAllowed("evil.mymac.local", ["mymac.local"], PORT)).toBe(false);
  });
  it("matches an entry with a port only exactly", () => {
    expect(hostAllowed("mymac.local:8443", ["mymac.local:8443"], PORT)).toBe(true);
    expect(hostAllowed("mymac.local", ["mymac.local:8443"], PORT)).toBe(false);
    expect(hostAllowed("mymac.local:4777", ["mymac.local:8443"], PORT)).toBe(false);
  });
  it("handles addresses", () => {
    expect(hostAllowed("192.168.1.20:4777", ["192.168.1.20"], PORT)).toBe(true);
    expect(hostAllowed("[fe80::1]:4777", ["[fe80::1]"], PORT)).toBe(true);
  });
});

describe("sameOrigin", () => {
  it("https without port", () => {
    for (const o of ["https://foundry.test", "https://foundry.test:443", "HTTPS://Foundry.Test"]) expect(sameOrigin(o, "https", "foundry.test"), o).toBe(true);
    for (const o of ["http://foundry.test", "https://foundry.test:8443"]) expect(sameOrigin(o, "https", "foundry.test"), o).toBe(false);
  });
  it("https with port", () => {
    expect(sameOrigin("https://foundry.test:8443", "https", "foundry.test:8443")).toBe(true);
    expect(sameOrigin("https://foundry.test", "https", "foundry.test:8443")).toBe(false);
  });
  it("http", () => {
    expect(sameOrigin("http://mymac.local", "http", "mymac.local")).toBe(true);
    expect(sameOrigin("http://mymac.local:80", "http", "mymac.local")).toBe(true);
    expect(sameOrigin("http://localhost:4777", "http", "localhost:4777")).toBe(true);
    for (const o of ["http://127.0.0.1:4777", "http://localhost:4778", "http://localhost", "https://localhost:4777"]) expect(sameOrigin(o, "http", "localhost:4777"), o).toBe(false);
  });
  it.each([undefined, "null", "foundry.test", "https://foundry.test/x", "https://u@foundry.test", "ftp://foundry.test", "https://"])("%s is refused", (o) =>
    expect(sameOrigin(o, "https", "foundry.test")).toBe(false));
});

const cfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({ listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false, ...over });
const req = (peer: string, host: string, headers: Record<string, string> = {}, method = "GET") => ({ peer, method, headers: { host, ...headers } });

describe("access", () => {
  const proxied = { "x-forwarded-proto": "https", "x-forwarded-for": "10.0.0.5" };
  const listed = cfg({ allowed_hosts: ["foundry.test"] });

  it("a direct local request is local", () => {
    expect(access(req("127.0.0.1", "localhost:4777"), cfg(), PORT)).toEqual({ local: true, https: false });
    expect(access(req("::ffff:127.0.0.1", "127.0.0.1:4777"), cfg(), PORT)).toEqual({ local: true, https: false });
  });
  it("proxied HTTPS", () => {
    expect(access(req("127.0.0.1", "foundry.test", proxied), listed, PORT)).toEqual({ local: false, https: true });
    expect(access(req("127.0.0.1", "foundry.test", proxied), cfg(), PORT).refusal).toBe("forbidden host");
  });
  it("proxied plain HTTP", () => {
    const r = req("127.0.0.1", "foundry.test", { "x-forwarded-proto": "http" });
    expect(access(r, listed, PORT).refusal).toBe("HTTPS required");
    expect(access(r, { ...listed, allow_insecure_http: true }, PORT)).toEqual({ local: false, https: false });
  });
  it("a remote peer", () => {
    const r = req("192.168.1.50", "mymac.local:4777");
    const c = cfg({ allowed_hosts: ["mymac.local"] });
    expect(access(r, c, PORT).refusal).toBe("HTTPS required");
    expect(access(r, { ...c, allow_insecure_http: true }, PORT)).toEqual({ local: false, https: false });
  });
  it("a remote peer cannot fake the forwarded protocol", () => {
    const c = cfg({ allowed_hosts: ["mymac.local"], allow_insecure_http: true });
    const r = req("192.168.1.50", "mymac.local:4777", { "x-forwarded-proto": "https", origin: "https://mymac.local:4777" }, "POST");
    expect(access(r, c, PORT)).toMatchObject({ https: false, refusal: "forbidden origin" });
  });
  it("a local peer with forwarded headers is not local", () => {
    const a = access(req("127.0.0.1", "localhost:4777", { "x-forwarded-for": "10.0.0.5" }), cfg(), PORT);
    expect(a).toMatchObject({ local: false, refusal: "HTTPS required" });
  });
  it("a loopback peer on a listed name without forwarded headers needs HTTPS", () => {
    expect(access(req("127.0.0.1", "foundry.test"), listed, PORT).refusal).toBe("HTTPS required");
  });
  it("reads x-forwarded-proto strictly", () => {
    expect(access(req("127.0.0.1", "foundry.test", { "x-forwarded-proto": "https, http" }), listed, PORT).https).toBe(false);
    expect(access(req("127.0.0.1", "foundry.test", { "x-forwarded-proto": " HTTPS " }), listed, PORT).https).toBe(true);
  });
  it("checks the exact origin of a change", () => {
    const post = (origin: string) => access(req("127.0.0.1", "foundry.test", { ...proxied, origin }, "POST"), listed, PORT);
    expect(post("https://foundry.test").refusal).toBeUndefined();
    expect(post("http://foundry.test").refusal).toBe("forbidden origin");
    expect(post("http://evil.example").refusal).toBe("forbidden origin");
    expect(access(req("127.0.0.1", "foundry.test", { ...proxied, origin: "http://evil.example" }), listed, PORT).refusal).toBeUndefined();
  });
  it("an origin of another listed host is refused", () => {
    const c = cfg({ allowed_hosts: ["a.test", "b.test"] });
    const r = req("127.0.0.1", "a.test", { ...proxied, origin: "https://b.test" }, "POST");
    expect(access(r, c, PORT).refusal).toBe("forbidden origin");
  });
});

describe("listenProblem", () => {
  const boom = () => {
    throw new Error("must not be called");
  };
  it("local addresses need no admin and never look", () => {
    expect(listenProblem("127.0.0.1", boom)).toBeUndefined();
    expect(listenProblem("::1", boom)).toBeUndefined();
  });
  it("non-local with an admin is fine", () => {
    expect(listenProblem("0.0.0.0", () => true)).toBeUndefined();
    expect(listenProblem("::", () => true)).toBeUndefined();
  });
  it("non-local without an admin names the fix", () => {
    expect(listenProblem("0.0.0.0", () => false)).toContain("scf user create --admin");
  });
  it("says so when the accounts cannot be read", () => {
    expect(listenProblem("::", boom)).toContain("cannot be read");
  });
});

describe("listenCovers", () => {
  it.each([["::", "192.168.1.20", true], ["::", "::1", true], ["::", "::ffff:127.0.0.1", true],
    ["0.0.0.0", "127.0.0.1", true], ["0.0.0.0", "192.168.1.20", true], ["0.0.0.0", "::ffff:192.168.1.20", true], ["0.0.0.0", "::1", false],
    ["127.0.0.1", "127.0.0.1", true], ["127.0.0.1", "::ffff:127.0.0.1", true], ["127.0.0.1", "192.168.1.20", false], ["127.0.0.1", "::1", false],
    ["::1", "::1", true], ["::1", "127.0.0.1", false]] as const)("%s covers %s: %s", (l, a, want) => expect(listenCovers(l, a)).toBe(want));
  it("an unknown local address counts as covered", () => expect(listenCovers("::1", undefined)).toBe(true));
});

describe("localUrl", () => {
  it.each(["127.0.0.1", "0.0.0.0", "::"])("%s", (l) => expect(localUrl(l, PORT)).toBe("http://localhost:4777"));
  it("::1", () => expect(localUrl("::1", PORT)).toBe("http://[::1]:4777"));
});

describe("server settings schema", () => {
  const parse = (server: unknown) => ConfigSchema.safeParse({ server });
  it("has defaults", () => expect(ConfigSchema.parse({}).server).toEqual({ listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false }));
  it.each(["127.0.0.1", "::1", "0.0.0.0", "::"])("accepts listen %s", (listen) => expect(parse({ listen }).success).toBe(true));
  it.each(["localhost", "example.com", "", "127.0.0.2", "192.168.1.20", "0:0:0:0:0:0:0:1", "::ffff:7f00:1"])("rejects listen %j", (listen) =>
    expect(parse({ listen }).success).toBe(false));
  it.each(["mymac.local", "a.test:8443", "192.168.1.20", "[fe80::1]:4777"])("accepts host %s", (h) => expect(parse({ allowed_hosts: [h] }).success).toBe(true));
  it("lower-cases hosts", () => expect(ConfigSchema.parse({ server: { allowed_hosts: ["MyMac.Local"] } }).server.allowed_hosts).toEqual(["mymac.local"]));
  it.each(["http://x", "a b", "x/y", "*.x", "a..b", "-a.test", "a.test.", "[:::]", "::1", "a.test:0", "a.test:65536", `${"a".repeat(64)}.test`,
    Array.from({ length: 5 }, () => "a".repeat(62)).join(".")])("rejects host %s", (h) => expect(parse({ allowed_hosts: [h] }).success).toBe(false));
  it("rejects an unknown key", () => expect(parse({ nope: 1 }).success).toBe(false));
});

describe("the UI under the Content-Security-Policy", () => {
  const html = readFileSync("ui/index.html", "utf8");
  it("index.html has only external scripts, no inline style and no event attributes", () => {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toContain("src=");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("importmap");
  });
  const files = readdirSync("ui").filter((f) => f.endsWith(".js"));
  it.each(files)("%s has no inline-code patterns", (f) => {
    const src = readFileSync(`ui/${f}`, "utf8");
    for (const bad of ["innerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", 'setAttribute("style"']) expect(src, bad).not.toContain(bad);
    expect(src).not.toMatch(/style:\s*["'`]/);
  });
  it("app.js and library.js import yaml by its path", () => {
    for (const f of ["app.js", "library.js"]) {
      const src = readFileSync(`ui/${f}`, "utf8");
      expect(src).not.toMatch(/from\s+["']yaml["']/);
      expect(src).toContain('from "/vendor/yaml/index.js"');
    }
  });
});
