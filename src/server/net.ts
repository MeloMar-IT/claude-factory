import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ServerConfig } from "../config.js";

/** The one Content-Security-Policy of every response. The UI has no inline script or style, and talks only to itself. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export const HSTS = "max-age=31536000";

/** True for the loopback forms Node reports. Anything unknown is not local. */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Splits a Host header or host entry into name and port. Undefined when it is not well formed. */
function splitHost(value: string): { name: string; port?: string } | undefined {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return undefined;
    const rest = value.slice(end + 1);
    if (rest === "") return { name: value.slice(0, end + 1) };
    return rest.startsWith(":") && rest.length > 1 ? { name: value.slice(0, end + 1), port: rest.slice(1) } : undefined;
  }
  const i = value.lastIndexOf(":");
  if (i < 0) return value ? { name: value } : undefined;
  return i > 0 && i < value.length - 1 ? { name: value.slice(0, i), port: value.slice(i + 1) } : undefined;
}

const localHosts = (port: number) => new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

/** The Host header is one of the Mac's own names (with the server port) or an allowed host name. */
export function hostAllowed(host: string | undefined, allowed: string[], port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  if (localHosts(port).has(h)) return true;
  const want = splitHost(h);
  if (!want) return false;
  return allowed.some((entry) => {
    const e = splitHost(entry.toLowerCase());
    if (!e || e.name !== want.name) return false;
    return e.port === undefined ? want.port === undefined || want.port === String(port) : e.port === want.port;
  });
}

/** True when the Host header is one of the Mac's own names (with the server port). */
const isLocalHost = (host: string | undefined, port: number) => !!host && localHosts(port).has(host.toLowerCase());

const defaultPort = (scheme: string) => (scheme === "https" ? "443" : "80");

function authority(scheme: string, value: string): string | undefined {
  const s = splitHost(value.toLowerCase());
  if (!s) return undefined;
  return s.port === undefined || s.port === defaultPort(scheme) ? s.name : `${s.name}:${s.port}`;
}

/** The Origin header is exactly the request's own origin: scheme, name and port. */
export function sameOrigin(origin: string | undefined, scheme: "http" | "https", host: string | undefined): boolean {
  if (!origin || !host) return false;
  const m = /^(https?):\/\/([^/@?#\s]+)$/i.exec(origin);
  if (!m || m[1]!.toLowerCase() !== scheme) return false;
  const a = authority(scheme, m[2]!);
  return a !== undefined && a === authority(scheme, host);
}

export interface Access {
  /** The request came straight from this Mac, not through a proxy. */
  local: boolean;
  /** The connection was HTTPS up to a trusted proxy on this Mac. */
  https: boolean;
  /** Why the request is refused (a 403 text), if it is. */
  refusal?: string;
}

export interface AccessInput {
  peer: string | undefined;
  method: string;
  headers: IncomingHttpHeaders;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(",") : v);

/** Decides who may talk to the server. Forwarded headers count only from a peer on this Mac (the proxy). */
export function access(req: AccessInput, cfg: ServerConfig, port: number): Access {
  const host = req.headers.host;
  if (!hostAllowed(host, cfg.allowed_hosts, port)) return { local: false, https: false, refusal: "forbidden host" };
  const loop = isLoopback(req.peer);
  const proto = first(req.headers["x-forwarded-proto"]);
  const forwarded = req.headers["x-forwarded-for"] !== undefined || proto !== undefined;
  const https = loop && proto !== undefined && proto.trim().toLowerCase() === "https";
  const local = loop && !forwarded && isLocalHost(host, port);
  if (!local && !https && !cfg.allow_insecure_http) return { local, https, refusal: "HTTPS required" };
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && !sameOrigin(origin, https ? "https" : "http", host)) {
    return { local, https, refusal: "forbidden origin" };
  }
  return { local, https };
}

/** The access of a request, from the live settings. */
export const requestAccess = (req: IncomingMessage, cfg: ServerConfig, port: number): Access =>
  access({ peer: req.socket.remoteAddress, method: req.method ?? "GET", headers: req.headers }, cfg, port);

/** Why the server must not listen on this address, or undefined. Only non-local addresses need an admin account. */
export function listenProblem(listen: string, adminExists: () => boolean): string | undefined {
  if (isLoopback(listen)) return undefined;
  try {
    if (adminExists()) return undefined;
  } catch {
    return `cannot listen on ${listen}: the accounts cannot be read`;
  }
  return `cannot listen on ${listen} without an account — create the first admin with "scf user create --admin", then start again`;
}

const unmap = (a: string) => (a.toLowerCase().startsWith("::ffff:") ? a.slice(7) : a.toLowerCase());

/** True when a server listening on `listen` also answers on `localAddress` (the address a request arrived on). */
export function listenCovers(listen: string, localAddress: string | undefined): boolean {
  if (!localAddress) return true;
  if (listen === "::") return true;
  const a = unmap(localAddress);
  if (listen === "0.0.0.0") return !a.includes(":");
  if (listen === "::1") return a === "::1";
  return isLoopback(a) && !a.includes(":") && listen === "127.0.0.1";
}

/** The URL the Mac itself uses for links it makes (notifications, service). */
export const localUrl = (listen: string, port: number) => (listen === "::1" ? `http://[::1]:${port}` : `http://localhost:${port}`);
