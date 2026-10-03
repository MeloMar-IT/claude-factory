export type RepoErrorCode = "bad-name" | "bad-url" | "bad-auth" | "duplicate" | "taken" | "limit" | "not-found" | "no-owner" | "bad-settings" | "bad-owner" | "blocked" | "no-credential";

/** A problem with what the caller asked for. The message is safe to show and never holds a token. */
export class RepoError extends Error {
  constructor(
    public code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_URL = 500;
const FORMS = 'use "https://host/path", "ssh://[user@]host[:port]/path", "git@host:path" or "owner/name"';

/** The placeholder flows use for "no repository chosen yet", in any case. */
const isPlaceholder = (name: string) => name.toLowerCase() === "owner/repo";

/** True for a GitHub name as it was always written: "owner/name". */
export const validGithubName = (name: string) => NAME_RE.test(name) && !name.endsWith("/.") && !name.endsWith("/..") && !isPlaceholder(name);

/** The path without a final ".git" (a repository that is called ".git" keeps its name). */
const stripGit = (path: string) => {
  let p = path;
  // in any case and repeated, so that stripping a stored path again changes nothing
  while (p.length > 4 && /\.git$/i.test(p) && !/\/\.git$/i.test(p)) p = p.slice(0, -4);
  return p;
};

/** The identity of a GitHub repository: the same for any case, a final ".git" and the https or ssh form. */
export const githubKey = (name: string) => `github.com/${stripGit(name).toLowerCase()}`;

export interface ParsedRepoUrl {
  /** The URL as it is stored. It parses to itself. */
  url: string;
  scheme: "https" | "ssh";
  host: string;
  /** Equal for every way of writing the same repository. */
  key: string;
  /** "owner/name" when the host is github.com. */
  github?: string;
}

const bad = (message: string) => new RepoError("bad-url", message);
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * `url` keeps what was submitted (transport, user, path with its case and ".git"); only the host is lowercased, a default
 * port and a final "/" are dropped. `key` is the identity: no case, no ".git", no scheme, user or port.
 */
function build(scheme: "https" | "ssh", user: string, hostIn: string, portIn: string, pathIn: string, scp = false): ParsedRepoUrl {
  const host = hostIn.toLowerCase();
  if (!HOST_RE.test(host) || host.length > 253) throw bad("the host name is not valid");
  let port = "";
  if (portIn) {
    const n = Number(portIn);
    if (!/^[0-9]{1,5}$/.test(portIn) || n < 1 || n > 65535) throw bad("the port is not valid");
    if (n !== (scheme === "https" ? 443 : 22)) port = `:${n}`;
  }
  // "git@host:/abs/path" is an absolute path, "git@host:rel/path" is relative to the home of the user
  const lead = scp && pathIn.startsWith("/") ? "/" : "";
  const rest = lead ? pathIn.slice(1) : pathIn;
  const path = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  const segments = path.split("/");
  if (!path || segments.some((s) => !s || s === "." || s === ".." || !SEGMENT_RE.test(s))) {
    throw bad('the path must be "name/name…" without empty parts, "." or "..", and without "%", "?" or "#"');
  }
  const name = stripGit(path);
  let github: string | undefined;
  if (host === "github.com") {
    if (!validGithubName(name)) throw bad('a GitHub repository is written as "owner/name" (letters, digits, "-", "_" and "."); "owner/repo" is only a placeholder');
    github = name;
  }
  const url = scp ? `${user}@${host}:${lead}${path}` : `${scheme}://${user ? `${user}@` : ""}${host}${port}/${path}`;
  return { url, scheme, host, key: `${host}/${name.toLowerCase()}`, ...(github ? { github } : {}) };
}

/** Reads a repository address in any of the allowed forms, or throws a RepoError with code "bad-url". */
export function parseRepoUrl(input: unknown): ParsedRepoUrl {
  if (typeof input !== "string") throw bad(`the repository must be text: ${FORMS}`);
  if (CONTROL.test(input)) throw bad("the repository must not hold control characters");
  const text = input.trim();
  if (!text) throw bad(`the repository is empty: ${FORMS}`);
  if (text.length > MAX_URL) throw bad(`the repository must be at most ${MAX_URL} characters`);

  const withScheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s.exec(text);
  if (withScheme) {
    const scheme = withScheme[1]!.toLowerCase();
    if (scheme !== "https" && scheme !== "ssh") throw bad(`the "${scheme}" transport is not allowed: ${FORMS}`);
    const rest = withScheme[2]!;
    if (/[?#%]/.test(rest)) throw bad('the address must not hold "?", "#" or "%"');
    const slash = rest.indexOf("/");
    if (slash < 0) throw bad("the address has no path");
    const authority = rest.slice(0, slash);
    const at = authority.lastIndexOf("@");
    const userPart = at >= 0 ? authority.slice(0, at) : "";
    const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
    if (at >= 0 && (scheme === "https" || userPart.includes(":"))) throw bad("the address must not hold a user name or password; give the user name and the token separately");
    if (at >= 0 && !USER_RE.test(userPart)) throw bad("the user name in the address is not valid");
    const colon = hostPort.indexOf(":");
    const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
    const port = colon >= 0 ? hostPort.slice(colon + 1) : "";
    if (colon >= 0 && !port) throw bad("the port is empty");
    return build(scheme, userPart, host, port, rest.slice(slash + 1));
  }

  const scp = /^git@([^\s:/@]+):(.+)$/s.exec(text);
  if (scp) {
    if (/[?#%]/.test(scp[2]!)) throw bad('the address must not hold "?", "#" or "%"');
    return build("ssh", "git", scp[1]!, "", scp[2]!, true);
  }

  if (text.includes("@") && /^[^\s/@:]+@[^\s:/]+:/.test(text)) throw bad('the short ssh form is only "git@host:path"');
  if (!validGithubName(text)) throw bad(`not a repository address: ${FORMS}`);
  return build("https", "", "github.com", "", text);
}

/** Like parseRepoUrl, but gives undefined instead of throwing. */
export function tryParseRepoUrl(input: unknown): ParsedRepoUrl | undefined {
  try {
    return parseRepoUrl(input);
  } catch {
    return undefined;
  }
}
