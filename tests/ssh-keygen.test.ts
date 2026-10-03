import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOCKED, CANNOT_READ, emptyRedactor, makeRedactor, redactKeeping } from "../src/credentials/redact.js";
import { PUBLIC_KEY_RE, KeygenError, generateKeyPair } from "../src/credentials/ssh-keygen.js";
import { checkSecret } from "../src/credentials/store.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

const BEGIN = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
let kg: FakeKeygen;
let tmp: string;
let savedTmp: string | undefined;

beforeEach(() => {
  kg = fakeKeygen();
  savedTmp = process.env.TMPDIR;
  tmp = mkdtempSync(join(tmpdir(), "keygen-tmp-"));
  process.env.TMPDIR = tmp;
});
afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  kg.remove();
  rmSync(tmp, { recursive: true, force: true });
});

const failure = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe("generateKeyPair", () => {
  it("returns a pair, with the exact arguments, in a private folder that is removed", () => {
    const pair = generateKeyPair();
    expect(pair.publicKey).toMatch(PUBLIC_KEY_RE);
    expect(pair.privateKey).toBe(checkSecret("ssh-key", pair.privateKey));
    expect(pair.privateKey.startsWith(BEGIN)).toBe(true);
    expect(kg.pairs()).toEqual([{ privateKey: pair.privateKey, publicKey: pair.publicKey }]);
    const [call] = kg.calls();
    expect(call!.args).toEqual(["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(call!.dir, "key")]);
    expect(call!.dirMode & 0o777).toBe(0o700);
    expect(existsSync(call!.dir)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it.each(["exit", "private", "public", "no-private", "no-public"] as const)("a bad tool (%s) is a failure and leaves nothing", (mode) => {
    kg.fail(mode);
    const e = failure(() => generateKeyPair());
    expect(e).toBeInstanceOf(KeygenError);
    expect((e as KeygenError).code).toBe("failed");
    expect((e as KeygenError).message).not.toMatch(/PRIVATE KEY|ssh-(ed25519|rsa)|\//);
    expect(existsSync(kg.calls()[0]!.dir)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("reports a missing tool", () => {
    process.env.SCF_SSH_KEYGEN_BIN = join(tmp, "nope");
    const e = failure(() => generateKeyPair());
    expect(e).toBeInstanceOf(KeygenError);
    expect((e as KeygenError).code).toBe("missing");
  });

  it("reports a temporary folder that is missing", () => {
    process.env.TMPDIR = join(tmp, "gone");
    const e = failure(() => generateKeyPair());
    expect(e).toBeInstanceOf(KeygenError);
    expect((e as KeygenError).code).toBe("failed");
  });

  it.skipIf(!existsSync("/usr/bin/ssh-keygen"))("works with the real tool", () => {
    delete process.env.SCF_SSH_KEYGEN_BIN;
    const pair = generateKeyPair();
    expect(pair.publicKey).toMatch(PUBLIC_KEY_RE);
    expect(pair.privateKey).toBe(checkSecret("ssh-key", pair.privateKey));
    expect(pair.privateKey.startsWith(BEGIN)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("the public key in API answers", () => {
  const { publicKey, privateKey } = (() => {
    const k = fakeKeygen();
    try {
      return generateKeyPair();
    } finally {
      k.remove();
    }
  })();
  const r = makeRedactor(["ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5AAAAI", publicKey.slice(40, 52)]);
  const answer = (extra: object = {}) => JSON.stringify([{ url: "git@host:a/ssh-ed25519.git", publicKey, ...extra }]);

  it("is lost to plain redaction, which is why the exemption exists", () => {
    expect(r.redact(JSON.stringify({ publicKey }))).not.toContain(publicKey);
  });

  it("is kept whole while the rest of the answer is hidden", () => {
    const out = redactKeeping(r, answer(), [publicKey]);
    expect(out).toContain(`"publicKey":"${publicKey}"`);
    expect(out).toContain('"url":"git@host:a/[redacted].git"');
  });

  it("changes nothing when nothing is kept or when no secret is elsewhere", () => {
    const text = answer();
    expect(redactKeeping(r, text, [])).toBe(r.redact(text));
    const only = JSON.stringify({ publicKey });
    expect(redactKeeping(r, only, [publicKey])).toBe(only);
    const quiet = makeRedactor(["zzzzzzzzzzzz"]);
    expect(redactKeeping(quiet, only, [publicKey])).toBe(quiet.redact(only));
  });

  it("keeps only a whole public key line", () => {
    const token = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIshort";
    for (const bad of [token, "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ", `${publicKey} comment`]) {
      const text = JSON.stringify({ k: bad });
      expect(redactKeeping(r, text, [bad]), bad).toBe(r.redact(text));
    }
  });

  it("redacts the key inside a longer string and as an object key", () => {
    const note = JSON.stringify({ note: `key: ${publicKey}` });
    expect(redactKeeping(r, note, [publicKey])).toBe(r.redact(note));
    const asKey = JSON.stringify({ [publicKey]: 1 });
    expect(redactKeeping(r, asKey, [publicKey])).toBe(r.redact(asKey));
  });

  it("still replaces a secret that reaches outside the key", () => {
    const text = JSON.stringify({ publicKey, added: "x" });
    const reaching = publicKey.slice(-6) + '","added';
    const out = redactKeeping(makeRedactor([reaching]), text, [publicKey]);
    expect(out).not.toContain(reaching);
    expect(out).toContain("[redacted]");
    const before = '"publicKey":"' + publicKey.slice(0, 20);
    expect(redactKeeping(makeRedactor([before]), text, [publicKey])).not.toContain(before);
  });

  it("hides a private key that comes with the public one", () => {
    const text = JSON.stringify({ publicKey, leak: privateKey });
    const out = redactKeeping(makeRedactor([privateKey]), text, [publicKey]);
    expect(out).toContain(publicKey);
    expect(out).not.toContain("PRIVATE KEY");
    for (const line of privateKey.split("\n").filter((l) => l.length > 20 && !l.includes("-----"))) expect(out).not.toContain(line);
  });

  it("leaves empty and blocked redactors as they are", () => {
    const text = answer();
    expect(redactKeeping(emptyRedactor, text, [publicKey])).toBe(text);
    expect(redactKeeping(BLOCKED, text, [publicKey])).toBe(CANNOT_READ);
  });

  describe("overlapping secrets", () => {
    const text = JSON.stringify({ publicKey, added: "x" });
    const tail = publicKey.slice(50) + '","added';

    it("replaces a secret that overlaps one inside the key", () => {
      const o = makeRedactor([publicKey.slice(40, 60), tail]);
      expect(redactKeeping(o, text, [publicKey])).not.toContain(tail);
      // the control: one pass hides only the first
      expect(o.redact(text)).toContain(tail.slice(10));
    });

    it("follows a chain of overlaps", () => {
      const last = publicKey.slice(65) + '","added';
      const o = makeRedactor([publicKey.slice(40, 60), publicKey.slice(45, 70), last]);
      expect(redactKeeping(o, text, [publicKey])).not.toContain(last);
    });

    it("keeps the key when overlapping secrets both lie inside it", () => {
      const o = makeRedactor([publicKey.slice(40, 60), publicKey.slice(50, 70)]);
      expect(redactKeeping(o, text, [publicKey])).toBe(text);
    });

    it("leaves the redactor as it was", () => {
      const o = makeRedactor([publicKey.slice(40, 60), tail]);
      const redacted = o.redact(text);
      const found = o.find(text);
      redactKeeping(o, text, [publicKey]);
      expect(o.redact(text)).toBe(redacted);
      expect(o.find(text)).toEqual(found);
    });
  });
});
