import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUser, hasAdmin } from "../src/auth/users.js";
import { CSP } from "../src/server/net.js";
import { startServer } from "../src/server/server.js";
import { TEST_PASSWORD } from "./helpers/session.js";

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }
interface Srv {
  port: number;
  home: string;
  url: string;
  close: () => void;
  /** A request to the loopback address with the given headers (Host included). */
  call: (method: string, path: string, headers?: Record<string, string>, body?: unknown, host?: string) => Promise<Reply>;
}

const PROXY = { "x-forwarded-proto": "https", "x-forwarded-for": "10.0.0.5" };
const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function raw(host: string, port: number, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Reply> {
  return new Promise((ok, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host, port, method, path, headers: { ...(payload ? { "content-type": "application/json" } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", fail);
    req.end(payload);
  });
}

async function boot(config: Record<string, unknown> | string | undefined, opts: { admin?: boolean; bind?: string } = {}): Promise<Srv> {
  const tmp = mkdtempSync(join(tmpdir(), "factory-net-"));
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  process.env.FACTORY_HOME = home;
  if (typeof config === "string") writeFileSync(join(home, "config.yaml"), config);
  else if (config) writeFileSync(join(home, "config.yaml"), JSON.stringify(config));
  if (opts.admin !== false) await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const s = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), port, watchers: false });
      const close = () => {
        s.close();
        rmSync(tmp, { recursive: true, force: true });
      };
      closers.push(close);
      const bind = opts.bind ?? "127.0.0.1";
      return {
        port, home, url: s.url, close,
        call: (method, path, headers = {}, body, host) => raw(bind, port, method, path, { host: host ?? `localhost:${port}`, ...headers }, body),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
    }
  }
}

const credentials = { email: "admin@example.com", password: TEST_PASSWORD };
const cookieOf = (r: Reply) => (r.headers["set-cookie"] as string[] | undefined)?.[0];

/** Signs in on the server (locally unless headers say otherwise) and returns the session headers. */
async function signIn(s: Srv, headers: Record<string, string> = {}, host?: string, origin?: string) {
  const r = await s.call("POST", "/api/session", { ...(origin ? { origin } : {}), ...headers }, credentials, host);
  expect(r.status, r.body).toBe(200);
  return { cookie: cookieOf(r)!.split(";")[0]!, csrf: JSON.parse(r.body).csrfToken as string };
}
const authed = (a: { cookie: string; csrf: string }, extra: Record<string, string> = {}) => ({ cookie: a.cookie, "x-csrf-token": a.csrf, ...extra });

const HTTPS_HOST = { allowed_hosts: ["foundry.test"] };

describe("security headers", () => {
  it("every response carries the CSP and nosniff, and none carries HSTS over local HTTP", async () => {
    const s = await boot(undefined);
    const replies = [await s.call("GET", "/"), await s.call("GET", "/api/session"), await s.call("GET", "/nope.js"), await s.call("GET", "/", {}, undefined, "evil.test")];
    expect(replies.map((r) => r.status)).toEqual([200, 200, 404, 403]);
    for (const r of replies) {
      expect(r.headers["content-security-policy"]).toBe(CSP);
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["strict-transport-security"]).toBeUndefined();
    }
  });
});

describe("through an HTTPS proxy", () => {
  const host = "foundry.test";
  it("serves with HSTS and a Secure cookie, and checks the origin", async () => {
    const s = await boot({ server: HTTPS_HOST });
    const page = await s.call("GET", "/", PROXY, undefined, host);
    expect(page.status).toBe(200);
    expect(page.headers["strict-transport-security"]).toBe("max-age=31536000");

    const bad = await s.call("POST", "/api/session", { ...PROXY, origin: "http://foundry.test" }, credentials, host);
    expect(bad.status).toBe(403);
    expect(bad.body).toBe("forbidden origin");
    expect(cookieOf(bad)).toBeUndefined();

    const ok = await s.call("POST", "/api/session", { ...PROXY, origin: "https://foundry.test" }, credentials, host);
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toMatch(/; Max-Age=604800; Secure$/);

    const a = { cookie: cookieOf(ok)!.split(";")[0]!, csrf: JSON.parse(ok.body).csrfToken };
    const out = await s.call("DELETE", "/api/session", authed(a, { ...PROXY, origin: "https://foundry.test" }), undefined, host);
    expect(out.status).toBe(200);
    expect(cookieOf(out)).toMatch(/; Max-Age=0; Secure/);
  });

  it("refuses plain HTTP behind the proxy, an unlisted host, and a listed host without proxy headers", async () => {
    const s = await boot({ server: HTTPS_HOST });
    const http = await s.call("POST", "/api/session", { ...PROXY, "x-forwarded-proto": "http" }, credentials, host);
    expect([http.status, http.body, cookieOf(http)]).toEqual([403, "HTTPS required", undefined]);
    const other = await s.call("GET", "/", PROXY, undefined, "other.test");
    expect([other.status, other.body]).toEqual([403, "forbidden host"]);
    const bare = await s.call("GET", "/", {}, undefined, host);
    expect([bare.status, bare.body]).toEqual([403, "HTTPS required"]);
  });

  it("allow_insecure_http lets plain HTTP in, without Secure or HSTS", async () => {
    const s = await boot({ server: { ...HTTPS_HOST, allow_insecure_http: true } });
    const h = { ...PROXY, "x-forwarded-proto": "http", origin: "http://foundry.test" };
    const r = await s.call("POST", "/api/session", h, credentials, host);
    expect(r.status).toBe(200);
    expect(cookieOf(r)).toMatch(/; Max-Age=604800$/);
    expect(r.headers["strict-transport-security"]).toBeUndefined();
  });

  it("setup works only on the Mac itself", async () => {
    const s = await boot({ server: HTTPS_HOST }, { admin: false });
    const body = { name: "Boss", email: "boss@example.com", password: TEST_PASSWORD };
    const remote = await s.call("POST", "/api/setup", { ...PROXY, origin: "https://foundry.test" }, body, host);
    expect(remote.status).toBe(403);
    expect(JSON.parse(remote.body).error).toContain("on the Mac itself");
    expect(hasAdmin()).toBe(false);
    const local = await s.call("POST", "/api/setup", {}, body);
    expect(local.status).toBe(201);
    expect(hasAdmin()).toBe(true);
  });
});

describe("a malformed URL", () => {
  it("is answered with 400 and the server stays up", async () => {
    const s = await boot({ server: HTTPS_HOST });
    for (const path of ["/%", "/%zz", "/api/%"]) {
      const r = await s.call("GET", path, PROXY, undefined, "foundry.test");
      expect([r.status, r.headers["content-security-policy"]], path).toEqual([400, CSP]);
    }
    expect((await s.call("GET", "/", PROXY, undefined, "foundry.test")).status).toBe(200);
  });
});

describe("live changes", () => {
  it("a host added in Settings works without a restart", async () => {
    const s = await boot(undefined);
    const a = await signIn(s);
    expect((await s.call("GET", "/", PROXY, undefined, "foundry.test")).status).toBe(403);
    const cfg = JSON.parse((await s.call("GET", "/api/config", authed(a))).body);
    const put = await s.call("PUT", "/api/config", authed(a), { ...cfg, server: { ...cfg.server, allowed_hosts: ["foundry.test"] } });
    expect(put.status, put.body).toBe(200);
    expect((await s.call("GET", "/", PROXY, undefined, "foundry.test")).status).toBe(200);
  });

  it("allow_insecure_http switches on and off at once", async () => {
    const s = await boot({ server: HTTPS_HOST });
    const a = await signIn(s);
    const plain = () => s.call("GET", "/", { ...PROXY, "x-forwarded-proto": "http" }, undefined, "foundry.test");
    expect((await plain()).status).toBe(403);
    const cfg = JSON.parse((await s.call("GET", "/api/config", authed(a))).body);
    const set = (v: boolean) => s.call("PUT", "/api/config", authed(a), { ...cfg, server: { ...cfg.server, allow_insecure_http: v } });
    expect((await set(true)).status).toBe(200);
    expect((await plain()).status).toBe(200);
    expect((await set(false)).status).toBe(200);
    expect((await plain()).status).toBe(403);
  });
});

describe("the lock-out guard", () => {
  it("keeps the host of the proxied browser", async () => {
    const s = await boot({ server: HTTPS_HOST });
    const h = { ...PROXY, origin: "https://foundry.test" };
    const a = await signIn(s, h, "foundry.test", "https://foundry.test");
    const cfg = JSON.parse((await s.call("GET", "/api/config", authed(a, PROXY), undefined, "foundry.test")).body);
    const file = join(s.home, "config.yaml");
    const before = readFileSync(file, "utf8");
    const bad = await s.call("PUT", "/api/config", authed(a, h), { ...cfg, server: { ...cfg.server, allowed_hosts: [] } }, "foundry.test");
    expect(bad.status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(before);
    const good = await s.call("PUT", "/api/config", authed(a, h), { ...cfg, server: { ...cfg.server, allowed_hosts: ["foundry.test", "x.test"] } }, "foundry.test");
    expect(good.status, good.body).toBe(200);
  });

  it("checks the listen address against where the browser is connected", async () => {
    const s = await boot(undefined);
    const a = await signIn(s);
    const cfg = JSON.parse((await s.call("GET", "/api/config", authed(a))).body);
    const put = (listen: string) => s.call("PUT", "/api/config", authed(a), { ...cfg, server: { ...cfg.server, listen } });
    const file = join(s.home, "config.yaml");
    const none = () => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
    const before = none();
    expect((await put("::1")).status).toBe(400);
    expect(none()).toBe(before);
    expect((await put("192.168.1.20")).status).toBe(400);
    expect((await put("0.0.0.0")).status).toBe(200);
    expect(readFileSync(file, "utf8")).toContain("0.0.0.0");
    expect(JSON.parse((await s.call("GET", "/api/info", authed(a))).body).listening).toBe("127.0.0.1");
  });
});

describe("refusing to listen", () => {
  it("does not start on 0.0.0.0 without an admin, and starts nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "factory-net-"));
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    process.env.FACTORY_HOME = home;
    writeFileSync(join(home, "config.yaml"), "server:\n  listen: 0.0.0.0\n");
    const queue = join(home, "queue.json");
    const job = JSON.stringify({ jobs: [{ id: "j1", status: "queued" }] });
    writeFileSync(queue, job);
    const logs: string[] = [];
    const port = 20000 + Math.floor(Math.random() * 20000);
    await expect(startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, log: (m) => logs.push(m) })).rejects.toThrow(/scf user create --admin/);
    expect(logs.join("\n")).toContain("scf user create --admin");
    await expect(raw("127.0.0.1", port, "GET", "/", { host: `localhost:${port}` })).rejects.toThrow();
    expect(readFileSync(queue, "utf8")).toBe(job);
    rmSync(tmp, { recursive: true, force: true });
  });

  const hasV6 = Object.values(networkInterfaces()).flat().some((i) => i?.address === "::1");
  it.skipIf(!hasV6)("starts on ::1 without an admin", async () => {
    const s = await boot({ server: { listen: "::1" } }, { admin: false, bind: "::1" });
    expect(s.url).toBe(`http://[::1]:${s.port}`);
    const page = await raw("::1", s.port, "GET", "/", { host: `[::1]:${s.port}` });
    expect(page.status).toBe(200);
  });
});

describe("/api/info", () => {
  it("says where the server listens", async () => {
    const s = await boot(undefined);
    const a = await signIn(s);
    expect(JSON.parse((await s.call("GET", "/api/info", authed(a))).body).listening).toBe("127.0.0.1");
  });
});
