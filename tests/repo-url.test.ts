import { describe, expect, it } from "vitest";
import { RepoError, githubKey, parseRepoUrl, tryParseRepoUrl } from "../src/auth/repo-url.js";

const ok: [string, { url: string; scheme: string; host: string; key: string; github?: string }][] = [
  ["acme/app", { url: "https://github.com/acme/app", scheme: "https", host: "github.com", key: "github.com/acme/app", github: "acme/app" }],
  [" acme/app ", { url: "https://github.com/acme/app", scheme: "https", host: "github.com", key: "github.com/acme/app", github: "acme/app" }],
  ["HTTPS://GitHub.com/Acme/App.git/", { url: "https://github.com/Acme/App.git", scheme: "https", host: "github.com", key: "github.com/acme/app", github: "Acme/App" }],
  ["git@github.com:acme/app.git", { url: "git@github.com:acme/app.git", scheme: "ssh", host: "github.com", key: "github.com/acme/app", github: "acme/app" }],
  ["ssh://deploy@host/team/app", { url: "ssh://deploy@host/team/app", scheme: "ssh", host: "host", key: "host/team/app" }],
  ["ssh://host:2222/team/app.git", { url: "ssh://host:2222/team/app.git", scheme: "ssh", host: "host", key: "host/team/app" }],
  ["https://git.example.com:8443/a/b/c.git", { url: "https://git.example.com:8443/a/b/c.git", scheme: "https", host: "git.example.com", key: "git.example.com/a/b/c" }],
  ["ssh://git@host/~ann/app.git", { url: "ssh://git@host/~ann/app.git", scheme: "ssh", host: "host", key: "host/~ann/app" }],
  ["acme/.git", { url: "https://github.com/acme/.git", scheme: "https", host: "github.com", key: "github.com/acme/.git", github: "acme/.git" }],
];

const refused = [
  "/tmp/x", "./x", "../x", "~/x", "C:\\x",
  "file:///tmp/x", "ext::sh -c x", "fd::3", "http://github.com/a/b", "git://host/a",
  "https://ann@github.com/a/b", "https://ann:pw@host/a", "ssh://git:pw@host/a", "ann@host:team/app",
  "https://host/a\u0001b", "acme/app\n",
  "ssh://-oProxyCommand=x/a", "https://host/a/../b", "https://host//a", "https://host/a%2e/b", "https://host/a?x=1", "https://host/a#f", "https://host/", "https://[::1]/a", "host:path",
  "ssh://@host/a", "ssh://host:/a", "https://host:/a", "ssh://git@host:/a", "ssh://host:0/a", "ssh://host:99999/a",
  "https://github.com/acme", "https://github.com/a/b/c", "owner/repo", "https://github.com/Owner/Repo",
  "nope", "a/..", "a/.", "a/b/c", "/x", "", "-a/b", "a b/c",
  "https://host/" + "a".repeat(500),
];

describe("parseRepoUrl", () => {
  it.each(ok)("accepts %s", (input, want) => {
    expect(parseRepoUrl(input)).toEqual(want);
  });

  it("gives one key for every way to write one GitHub repository", () => {
    const keys = ["https://github.com/Acme/App.git", "git@github.com:acme/app", "ssh://git@github.com:22/ACME/app.git"].map((u) => parseRepoUrl(u).key);
    expect(new Set(keys)).toEqual(new Set(["github.com/acme/app"]));
  });

  it.each(refused)("refuses %j with bad-url", (input) => {
    try {
      parseRepoUrl(input);
      throw new Error("was accepted");
    } catch (e) {
      expect(e).toBeInstanceOf(RepoError);
      expect((e as RepoError).code).toBe("bad-url");
      expect((e as RepoError).message.length).toBeGreaterThan(10);
    }
  });

  it("refuses what is not text", () => {
    expect(tryParseRepoUrl(5)).toBeUndefined();
    expect(tryParseRepoUrl(undefined)).toBeUndefined();
  });

  it("tryParseRepoUrl never throws", () => {
    for (const bad of refused) expect(tryParseRepoUrl(bad)).toBeUndefined();
  });

  it("parses every accepted url to itself", () => {
    for (const [input] of ok) {
      const p = parseRepoUrl(input);
      expect(parseRepoUrl(p.url)).toEqual(p);
    }
  });

  it("ignores .git in any case and repeated, and is stable when parsed again", () => {
    expect(parseRepoUrl("https://github.com/acme/app.GIT").key).toBe("github.com/acme/app");
    for (const u of ["https://host/a/app.git.git", "https://host/a/app.GIT.git", "git@github.com:acme/app.git.git", "https://host/a/.GIT"]) {
      const p = parseRepoUrl(u);
      expect(parseRepoUrl(p.url)).toEqual(p);
    }
    // the address keeps what was submitted; only the key ignores ".git"
    expect(parseRepoUrl("https://host/a/app.git.git")).toMatchObject({ url: "https://host/a/app.git.git", key: "host/a/app" });
    expect(parseRepoUrl("git@host:team/app.git").url).toBe("git@host:team/app.git");
    expect(parseRepoUrl("git@host:/abs/app").url).toBe("git@host:/abs/app");
    expect(parseRepoUrl("git@host:team/app").key).toBe(parseRepoUrl("ssh://git@host/team/app.git").key);
  });

  it("githubKey ignores case and a final .git", () => {
    expect(githubKey("ACME/App.git")).toBe("github.com/acme/app");
    expect(githubKey("acme/.git")).toBe("github.com/acme/.git");
  });
});
