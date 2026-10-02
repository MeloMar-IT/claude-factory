import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { KEYCHAIN_SERVICE, KeyError } from "../src/credentials/keychain.js";
import {
  CredentialError, addCredential, checkKeychain, credentialsPath, listCredentials, readSecret, removeCredential, removeCredentialsLocked, rotateKey,
} from "../src/credentials/store.js";
import { fakeKey, fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";

let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
const A = randomUUID();
const B = randomUUID();
const ok = () => true;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "creds-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const add = (userId: string, name: string, secret: string, type = "token") => addCredential({ userId, type, name, secret }, { ownerOk: ok });
const fileJson = () => JSON.parse(readFileSync(credentialsPath(), "utf8")) as { keyId: string | null; retiredKeyIds: string[]; credentials: Record<string, string>[] };
const keyItems = () => Object.entries(kc.items());
const write = (f: unknown) => writeFileSync(credentialsPath(), JSON.stringify(f));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as CredentialError | KeyError).code;
  }
  return "none";
};

describe("encrypted at rest", () => {
  it("writes an unreadable 0600 file and keeps the key only in the Keychain", () => {
    const token = fakeToken();
    const pub = add(A, "gh", token);
    expect(Object.keys(pub).sort()).toEqual(["created", "fingerprint", "id", "lastUsed", "name", "type"]);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const text = readFileSync(credentialsPath(), "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(Buffer.from(token).toString("base64"));
    const f = fileJson();
    expect(Buffer.from(f.credentials[0]!.iv!, "base64")).toHaveLength(12);
    expect(Buffer.from(f.credentials[0]!.tag!, "base64")).toHaveLength(16);
    const items = keyItems();
    expect(items).toHaveLength(1);
    expect(items[0]![0]).toBe(`${KEYCHAIN_SERVICE}\u0000${f.keyId}`);
    expect(items[0]![1]).toMatch(/^[0-9a-f]{64}$/);
    const key = items[0]![1];
    for (const n of readdirSync(home)) if (statSync(join(home, n)).isFile()) expect(readFileSync(join(home, n), "utf8")).not.toContain(key);
    for (const call of kc.calls()) expect(call.join(" ")).not.toContain(key);
    expect(kc.calls().find((c) => c[0] === "add-generic-password")!.at(-1)).toBe("-w");
  });

  it("uses AES-256-GCM with the documented format", () => {
    const token = fakeToken();
    add(A, "gh", token);
    const f = fileJson();
    const c = f.credentials[0]!;
    const key = Buffer.from(keyItems()[0]![1], "hex");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(c.iv!, "base64"));
    d.setAAD(Buffer.from(JSON.stringify(["claude-factory-credential-v1", c.id, c.userId, c.type, c.name, c.created, c.fingerprint])));
    d.setAuthTag(Buffer.from(c.tag!, "base64"));
    expect(Buffer.concat([d.update(Buffer.from(c.data!, "base64")), d.final()]).toString()).toBe(token);
  });

  it("gives the same secret a new iv and data, and the same fingerprint", () => {
    const token = fakeToken();
    const a = add(A, "one", token);
    const b = add(A, "two", token);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toBe(createHash("sha256").update(token).digest("hex").slice(0, 16));
    const [x, y] = fileJson().credentials;
    expect(x!.iv).not.toBe(y!.iv);
    expect(x!.data).not.toBe(y!.data);
  });

  it("lists only the user's own credentials without a Keychain call", () => {
    add(A, "one", fakeToken("Aa1"));
    add(B, "two", fakeToken("Bb2"));
    kc.clearLog();
    expect(listCredentials(A).map((c) => c.name)).toEqual(["one"]);
    expect(kc.calls()).toEqual([]);
  });

  it("reads a secret, sets lastUsed and refuses other users", () => {
    const token = fakeToken();
    const pub = add(A, "gh", token);
    expect(readSecret(A, pub.id)).toBe(token);
    expect(listCredentials(A)[0]!.lastUsed).not.toBeNull();
    expect(readSecret(A, pub.id)).toBe(token);
    expect(code(() => readSecret(B, pub.id))).toBe("not-found");
    expect(code(() => readSecret(A, randomUUID()))).toBe("not-found");
  });
});

describe("validation", () => {
  const bad = (input: Partial<Parameters<typeof addCredential>[0]>) => {
    const secret = fakeToken();
    let err: CredentialError | undefined;
    try {
      addCredential({ userId: A, type: "token", name: "n", secret, ...input }, { ownerOk: ok });
    } catch (e) {
      err = e as CredentialError;
    }
    expect(existsSync(credentialsPath())).toBe(false);
    expect(err?.message ?? "").not.toContain(String(input.secret ?? secret));
    return err?.code;
  };

  it("rejects bad input and writes nothing", () => {
    expect(bad({ type: "password" })).toBe("bad-type");
    expect(bad({ name: "" })).toBe("bad-name");
    expect(bad({ name: "x".repeat(101) })).toBe("bad-name");
    expect(bad({ name: "a\u0007b" })).toBe("bad-name");
    expect(bad({ secret: "short77" })).toBe("bad-secret");
    expect(bad({ secret: "abcdefgh\nabcdefgh" })).toBe("bad-secret");
    expect(bad({ secret: "abcdefghé" })).toBe("bad-secret");
    expect(bad({ secret: "a".repeat(4097) })).toBe("bad-secret");
    expect(bad({ type: "ssh-key", secret: "not a key at all, just text" })).toBe("bad-secret");
    expect(bad({ type: "ssh-key", secret: "-----BEGIN PUBLIC KEY-----\nAAAAAAAAAA\n-----END PUBLIC KEY-----\n" })).toBe("bad-secret");
  });

  it("refuses a duplicate name for one user only", () => {
    add(A, "gh", fakeToken("Aa1"));
    expect(code(() => add(A, "gh", fakeToken("Bb2")))).toBe("duplicate");
    expect(() => add(B, "gh", fakeToken("Cc3"))).not.toThrow();
  });

  it("normalises a token and a key", () => {
    const t = add(A, "t", `  ${fakeToken()}  `);
    expect(readSecret(A, t.id)).toBe(fakeToken());
    const key = fakeKey();
    const k = add(A, "k", key.trimEnd().replace(/\n/g, "\r\n"), "ssh-key");
    expect(readSecret(A, k.id)).toBe(key);
  });

  it("refuses an unknown owner", () => {
    expect(code(() => addCredential({ userId: A, type: "token", name: "n", secret: fakeToken() }, { ownerOk: () => false }))).toBe("no-owner");
  });
});

describe("tampering", () => {
  const tamper = (edit: (c: Record<string, string>) => void, expected: string) => {
    const pub = add(A, "gh", fakeToken());
    const f = fileJson();
    edit(f.credentials[0]!);
    write(f);
    expect(code(() => readSecret(A, f.credentials[0]!.id!))).toBe(expected);
  };
  const flip = (b64: string) => {
    const b = Buffer.from(b64, "base64");
    b[0] = b[0]! ^ 1;
    return b.toString("base64");
  };

  it("fails on every changed byte or bound field", () => {
    tamper((c) => (c.data = flip(c.data!)), "wrong-key");
  });
  it("fails on a changed tag", () => tamper((c) => (c.tag = flip(c.tag!)), "wrong-key"));
  it("fails on a changed iv", () => tamper((c) => (c.iv = flip(c.iv!)), "wrong-key"));
  it("fails on a changed name", () => tamper((c) => (c.name = "other"), "wrong-key"));
  it("fails on a changed type", () => tamper((c) => (c.type = "ssh-key"), "wrong-key"));
  it("fails on a changed created", () => tamper((c) => (c.created = new Date(0).toISOString()), "wrong-key"));
  it("fails on a changed fingerprint", () => tamper((c) => (c.fingerprint = "0".repeat(16)), "wrong-key"));
  it("fails on a changed owner", () => {
    const pub = add(A, "gh", fakeToken());
    const f = fileJson();
    f.credentials[0]!.userId = B;
    write(f);
    expect(code(() => readSecret(B, pub.id))).toBe("wrong-key");
  });
  it("still decrypts after a changed lastUsed", () => {
    const pub = add(A, "gh", fakeToken());
    const f = fileJson();
    f.credentials[0]!.lastUsed = new Date(0).toISOString();
    write(f);
    expect(readSecret(A, pub.id)).toBe(fakeToken());
  });
  it("fails when two ciphertexts are swapped", () => {
    add(A, "one", fakeToken("Aa1"));
    add(A, "two", fakeToken("Bb2"));
    const f = fileJson();
    const [x, y] = f.credentials as [Record<string, string>, Record<string, string>];
    for (const k of ["iv", "tag", "data"]) [x[k], y[k]] = [y[k]!, x[k]!];
    write(f);
    expect(code(() => readSecret(A, x.id!))).toBe("wrong-key");
  });
});

describe("delete and wipe", () => {
  it("removes one credential, replaces the key and keeps the others readable", () => {
    const one = add(A, "one", fakeToken("Aa1"));
    const two = add(A, "two", fakeToken("Bb2"));
    const before = readFileSync(credentialsPath(), "utf8");
    const oldKeyId = fileJson().keyId;
    const oldKey = keyItems()[0]![1];
    const r = removeCredential(A, one.id);
    expect(r).toMatchObject({ removed: 1, oldKeysLeft: 0 });
    expect(r.keyId).not.toBe(oldKeyId);
    expect(keyItems()).toHaveLength(1);
    expect(keyItems()[0]![1]).not.toBe(oldKey);
    expect(listCredentials(A).map((c) => c.id)).toEqual([two.id]);
    expect(readSecret(A, two.id)).toBe(fakeToken("Bb2"));
    // a copy made before the delete cannot be read with the key that is left
    writeFileSync(credentialsPath(), before);
    expect(code(() => readSecret(A, two.id))).toBe("missing");
  });

  it("drops the key with the last credential", () => {
    const one = add(A, "one", fakeToken());
    expect(removeCredential(A, one.id).keyId).toBeNull();
    expect(keyItems()).toEqual([]);
    expect(fileJson().keyId).toBeNull();
  });

  it("does nothing for another user's credential", () => {
    const one = add(A, "one", fakeToken());
    const before = readFileSync(credentialsPath(), "utf8");
    kc.clearLog();
    expect(removeCredential(B, one.id).removed).toBe(0);
    expect(readFileSync(credentialsPath(), "utf8")).toBe(before);
    expect(kc.calls()).toEqual([]);
  });

  it("needs the lock, and creates no file when there is nothing", () => {
    expect(() => removeCredentialsLocked(A)).toThrow();
    expect(withAuthLock(() => removeCredentialsLocked(A).removed)).toBe(0);
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("leaves file and Keychain unchanged when the Keychain fails", () => {
    const one = add(A, "one", fakeToken("Aa1"));
    const two = add(A, "two", fakeToken("Bb2"));
    for (const op of ["find", "add"] as const) {
      const before = readFileSync(credentialsPath(), "utf8");
      const items = kc.items();
      kc.fail(op);
      expect(() => removeCredential(A, one.id)).toThrow(KeyError);
      kc.fail();
      expect(readFileSync(credentialsPath(), "utf8")).toBe(before);
      expect(kc.items()).toEqual(items);
    }
    expect(readSecret(A, two.id)).toBe(fakeToken("Bb2"));
  });

  it("removes only the entry when the key was removed by hand", () => {
    const one = add(A, "one", fakeToken("Aa1"));
    add(A, "two", fakeToken("Bb2"));
    const keyId = fileJson().keyId;
    writeFileSync(kc.file, "{}");
    expect(removeCredential(A, one.id)).toMatchObject({ removed: 1, keyId });
    expect(keyItems()).toEqual([]);
  });

  it("keeps an old key that cannot be removed, and removes it on the next write", () => {
    const one = add(A, "one", fakeToken("Aa1"));
    const two = add(A, "two", fakeToken("Bb2"));
    const oldKeyId = fileJson().keyId!;
    kc.fail("delete");
    const r = removeCredential(A, one.id);
    kc.fail();
    expect(r.oldKeysLeft).toBe(1);
    expect(fileJson().retiredKeyIds).toEqual([oldKeyId]);
    expect(readSecret(A, two.id)).toBe(fakeToken("Bb2"));
    add(A, "three", fakeToken("Cc3"));
    expect(fileJson().retiredKeyIds).toEqual([]);
    expect(keyItems()).toHaveLength(1);
  });

  it("records the old key as retired in the same write, even if the later write fails", () => {
    const one = add(A, "one", fakeToken("Aa1"));
    add(A, "two", fakeToken("Bb2"));
    const oldKeyId = fileJson().keyId!;
    // the first write goes through; deleting the old item fails, so the id must already be in the file
    kc.fail("delete");
    removeCredential(A, one.id);
    kc.fail();
    expect(fileJson().retiredKeyIds).toEqual([oldKeyId]);
  });

  it("cleans old keys when a delete is retried for a credential that is already gone", () => {
    const one = add(A, "one", fakeToken("Aa1"));
    add(A, "two", fakeToken("Bb2"));
    kc.fail("delete");
    removeCredential(A, one.id);
    kc.fail();
    const r = removeCredential(A, one.id);
    expect(r).toMatchObject({ removed: 0, oldKeysLeft: 0 });
    expect(fileJson().retiredKeyIds).toEqual([]);
    expect(keyItems()).toHaveLength(1);
  });

  it("cleans a retired id whose item is already gone", () => {
    add(A, "one", fakeToken());
    const f = fileJson();
    f.retiredKeyIds = [randomUUID()];
    write(f);
    add(A, "two", fakeToken("Bb2"));
    expect(fileJson().retiredKeyIds).toEqual([]);
  });
});

describe("keychain problems", () => {
  it("reports a missing item, a failing find and a failing first add", () => {
    const one = add(A, "one", fakeToken());
    const f = readFileSync(credentialsPath(), "utf8");
    kc.fail("find");
    expect(code(() => readSecret(A, one.id))).toBe("failed");
    kc.fail();
    writeFileSync(kc.file, "{}");
    expect(code(() => readSecret(A, one.id))).toBe("missing");
    expect(readFileSync(credentialsPath(), "utf8")).toBe(f);
    rmSync(credentialsPath());
    kc.fail("add");
    expect(() => add(A, "two", fakeToken())).toThrow(KeyError);
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("is unsupported off macOS without a replacement tool", () => {
    delete process.env.SCF_SECURITY_BIN;
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    kc.clearLog();
    try {
      expect(code(() => add(A, "one", fakeToken()))).toBe("unsupported");
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
    expect(kc.calls()).toEqual([]);
  });

  it("checks the Keychain and leaves no item", () => {
    checkKeychain();
    expect(keyItems()).toEqual([]);
    kc.fail("add");
    expect(() => checkKeychain()).toThrow(KeyError);
  });
});

describe("invalid file", () => {
  it("is refused without changing it or showing its values", () => {
    add(A, "one", fakeToken());
    const good = fileJson();
    const cases: unknown[] = [
      "not json",
      { ...good, version: 2 },
      { ...good, extra: 1 },
      { version: 1, keyId: good.keyId, credentials: good.credentials },
      { ...good, keyId: null },
      { ...good, credentials: [good.credentials[0], good.credentials[0]] },
      { ...good, credentials: [{ ...good.credentials[0], iv: Buffer.alloc(5).toString("base64") }] },
    ];
    for (const c of cases) {
      if (typeof c === "string") writeFileSync(credentialsPath(), c);
      else write(c);
      const before = readFileSync(credentialsPath(), "utf8");
      for (const fn of [() => listCredentials(A), () => add(A, "two", fakeToken("Bb2"))]) {
        try {
          fn();
          throw new Error("no error");
        } catch (e) {
          expect(e).toBeInstanceOf(StoreError);
          expect((e as Error).message).not.toContain(good.credentials[0]!.data!);
        }
      }
      expect(readFileSync(credentialsPath(), "utf8")).toBe(before);
    }
  });

  it("refuses a write while the lock is held elsewhere", () => {
    mkdirSync(join(home, "auth.lock"));
    writeFileSync(join(home, "auth.lock", "pid"), "1");
    try {
      add(A, "one", fakeToken());
      throw new Error("no error");
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
    }
  });
});

describe("key rotation", () => {
  it("re-encrypts every credential under a new key", () => {
    const ids = [add(A, "one", fakeToken("Aa1")), add(A, "two", fakeToken("Bb2")), add(B, "three", fakeToken("Cc3"))];
    const before = fileJson();
    const r = rotateKey();
    expect(r).toMatchObject({ rotated: true, count: 3, oldKeysLeft: 0 });
    const after = fileJson();
    expect(after.keyId).not.toBe(before.keyId);
    expect(keyItems()).toHaveLength(1);
    after.credentials.forEach((c, i) => {
      expect(c.iv).not.toBe(before.credentials[i]!.iv);
      expect(c.data).not.toBe(before.credentials[i]!.data);
      expect({ ...c, iv: 0, data: 0, tag: 0 }).toEqual({ ...before.credentials[i], iv: 0, data: 0, tag: 0 });
    });
    expect(readSecret(A, ids[0]!.id)).toBe(fakeToken("Aa1"));
    expect(readSecret(B, ids[2]!.id)).toBe(fakeToken("Cc3"));
  });

  it("does nothing without a file", () => {
    expect(rotateKey().rotated).toBe(false);
    expect(kc.calls()).toEqual([]);
  });

  it("fails cleanly when the old key is missing or the file cannot be written", () => {
    add(A, "one", fakeToken());
    const before = readFileSync(credentialsPath(), "utf8");
    const oldItems = kc.items();
    writeFileSync(kc.file, "{}");
    expect(() => rotateKey()).toThrow(KeyError);
    expect(kc.items()).toEqual({});
    writeFileSync(kc.file, JSON.stringify(oldItems));
    mkdirSync(credentialsPath() + ".tmp");
    expect(() => rotateKey()).toThrow(StoreError);
    expect(readFileSync(credentialsPath(), "utf8")).toBe(before);
    expect(kc.items()).toEqual(oldItems);
  });

  it("keeps an old key that cannot be removed, and clears it on the next rotation", () => {
    add(A, "one", fakeToken());
    kc.fail("delete");
    expect(rotateKey().oldKeysLeft).toBe(1);
    expect(fileJson().retiredKeyIds).toHaveLength(1);
    kc.fail();
    expect(rotateKey().oldKeysLeft).toBe(0);
    expect(fileJson().retiredKeyIds).toEqual([]);
    expect(keyItems()).toHaveLength(1);
  });
});
