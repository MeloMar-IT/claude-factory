import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyError } from "../src/credentials/keychain.js";
import { REDACTED, CANNOT_READ, emptyRedactor, liveRedactor, makeRedactor, redactStream, redactText, requireRedaction, secretRedactor } from "../src/credentials/redact.js";
import { StoreError } from "../src/auth/store.js";
import { addCredential, credentialsPath, removeCredential, rotateKey } from "../src/credentials/store.js";
import { runProcess } from "../src/steps/process.js";
import { fakeKey, fakeKeychain, fakeToken, pemWithLastLine, type FakeKeychain } from "./helpers/keychain.js";

let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
const U = randomUUID();
const store = (name: string, secret: string, type = "token") => addCredential({ userId: U, type, name, secret }, { ownerOk: () => true });

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "redact-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const streamAll = (r: ReturnType<typeof makeRedactor>, parts: string[]) => {
  let out = "";
  const s = redactStream((t) => (out += t), () => r);
  for (const p of parts) s.write(p);
  s.end();
  return out;
};

describe("makeRedactor", () => {
  it("is the identity when empty", () => {
    const r = makeRedactor([]);
    expect(r.empty).toBe(true);
    expect(r.redact("abc")).toBe("abc");
    expect(streamAll(r, ["a", "b\n"])).toBe("ab\n");
  });

  it("replaces every occurrence, JSON-escaped and URL-encoded too", () => {
    const t = fakeToken();
    expect(makeRedactor([t]).redact(`${t} and ${t}`)).toBe(`${REDACTED} and ${REDACTED}`);
    const odd = 'ab"cd\\efgh';
    expect(makeRedactor([odd]).redact(JSON.stringify({ k: odd }))).toBe(`{"k":"${REDACTED}"}`);
    const url = "ab/cd+efghij";
    expect(makeRedactor([url]).redact(`x=${encodeURIComponent(url)}&y=${url}`)).toBe(`x=${REDACTED}&y=${REDACTED}`);
  });

  it("replaces the body lines of a key and keeps the BEGIN and END lines", () => {
    const key = fakeKey();
    const r = makeRedactor([key]);
    const lines = key.trim().split("\n");
    const out = r.redact(key);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(lines[1]);
    expect(r.redact(key.replace(/\n/g, "\r\n"))).not.toContain(lines[1]);
    expect(r.redact(lines.map((l) => "    " + l).join("\n"))).not.toContain(lines[1]);
    expect(r.redact(JSON.stringify(key))).not.toContain(lines[1]);
  });

  it("hides a short last line only as a line of its own or in escaped form", () => {
    for (const n of [2, 4, 6]) {
      const pem = pemWithLastLine(n);
      const last = pem.trim().split("\n").slice(-2, -1)[0]!;
      const r = makeRedactor([pem]);
      expect(r.redact(pem)).not.toContain(last + "\n-----END");
      expect(r.redact(pem.replace(/\n/g, "\r\n"))).not.toContain(last + "\r\n");
      expect(r.redact(pem.split("\n").map((l) => "  " + l).join("\n"))).not.toContain("  " + last + "\n");
      expect(r.redact(JSON.stringify(pem))).not.toContain(last + "\\n");
      expect(r.redact(JSON.stringify(pem.replace(/\n/g, "\r\n")))).not.toContain(last + "\\r");
      expect(r.redact(`a ${last} b`)).toBe(`a ${last} b`);
    }
  });

  it("leaves no tail when one secret starts another", () => {
    const a = fakeToken("Aa1");
    const r = makeRedactor([a, a + "tail1234"]);
    expect(r.redact(`x ${a}tail1234 y`)).toBe(`x ${REDACTED} y`);
  });
});

describe("stream", () => {
  it("equals redact(whole) at every split position", () => {
    const t = fakeToken();
    const r = makeRedactor([t]);
    const whole = `a ${t} b\n`;
    for (let i = 0; i <= whole.length; i++) expect(streamAll(r, [whole.slice(0, i), whole.slice(i)])).toBe(r.redact(whole));
  });

  it("holds an unfinished line until a newline or the end", () => {
    const r = makeRedactor([fakeToken()]);
    const out: string[] = [];
    const s = redactStream((t) => out.push(t), () => r);
    s.write("no newline yet");
    expect(out).toEqual([]);
    s.write(" ok\nrest");
    expect(out.join("")).toBe("no newline yet ok\n");
    s.end();
    expect(out.join("")).toBe("no newline yet ok\nrest");
  });

  it("emits a very long line and still replaces a token across the cut", () => {
    const t = fakeToken();
    const r = makeRedactor([t]);
    const filler = "x".repeat(69_990);
    const out: string[] = [];
    const s = redactStream((x) => out.push(x), () => r);
    s.write(filler + t.slice(0, 20));
    s.write(t.slice(20) + "y".repeat(2000));
    expect(out.join("").length).toBeGreaterThan(50_000);
    s.end();
    const all = out.join("");
    expect(all).not.toContain(t);
    expect(all).toContain(REDACTED);
  });

  it("redacts a token whose first half came before it was saved and the rest after", () => {
    const t = fakeToken();
    let r = emptyRedactor;
    let out = "";
    const s = redactStream((x) => (out += x), () => r);
    s.write("a " + t.slice(0, 20));
    r = makeRedactor([t]);
    s.write(t.slice(20) + " b\n");
    s.end();
    expect(out).toBe(`a ${REDACTED} b\n`);
  });

  it("redacts after a secret appears mid-stream", () => {
    const t = fakeToken();
    let r = emptyRedactor;
    let out = "";
    const s = redactStream((x) => (out += x), () => r);
    s.write("first\n");
    r = makeRedactor([t]);
    s.write(`${t}\n`);
    s.end();
    expect(out).toBe(`first\n${REDACTED}\n`);
  });
});

describe("live set", () => {
  it("is empty without a file and makes no Keychain call", () => {
    expect(secretRedactor().empty).toBe(true);
    expect(kc.calls()).toEqual([]);
  });

  it("follows add, delete and rotate, with one Keychain call per change", () => {
    const t1 = fakeToken("Aa1");
    const t2 = fakeToken("Bb2");
    const one = store("one", t1);
    expect(secretRedactor().redact(t1)).toBe(REDACTED);
    kc.clearLog();
    secretRedactor();
    expect(kc.calls()).toEqual([]);
    store("two", t2);
    expect(secretRedactor().redact(t2)).toBe(REDACTED);
    rotateKey();
    expect(secretRedactor().redact(t1 + t2)).toBe(REDACTED + REDACTED);
    removeCredential(U, one.id);
    expect(secretRedactor().redact(t1)).toBe(t1);
    expect(secretRedactor().redact(t2)).toBe(REDACTED);
  });

  it("throws on an invalid file, and liveRedactor then hides everything (new secrets are unknown)", () => {
    const t = fakeToken();
    store("one", t);
    secretRedactor();
    writeFileSync(credentialsPath(), "not json");
    expect(() => secretRedactor()).toThrow(StoreError);
    expect(liveRedactor().redact("harmless text")).toBe(CANNOT_READ);
    expect(liveRedactor().redact(t)).not.toContain(t);
  });

  it("fails closed when a changed store cannot be read after a good read", () => {
    store("one", fakeToken("Aa1"));
    secretRedactor();
    const added = fakeToken("Bb2");
    store("two", added);
    kc.fail("find");
    expect(liveRedactor().redact(`x ${added}`)).toBe(CANNOT_READ);
  });

  it("fails closed when the Keychain cannot be read and nothing was read before", () => {
    store("one", fakeToken());
    kc.fail("find");
    // a fresh cache, as in a new process
    return import("../src/credentials/redact.js").then((m) => {
      m.resetRedactCache();
      expect(() => m.secretRedactor()).toThrow(KeyError);
      expect(redactText("x")).toBe(CANNOT_READ);
      expect(() => requireRedaction()).toThrow(/^the stored credentials cannot be read/);
    });
  });
});

describe("runProcess", () => {
  const log = () => join(home, "p.log");
  const node = (code: string) => ["-e", code];

  it("redacts stdout, stderr, lines and the log file across split writes", async () => {
    const t = fakeToken();
    const lines: string[] = [];
    const script = `const t=${JSON.stringify(t)};const h=t.length/2;process.stdout.write("a "+t.slice(0,h));process.stderr.write("b "+t.slice(0,h));setTimeout(()=>{process.stdout.write(t.slice(h)+"\\n");process.stderr.write(t.slice(h)+"\\n")},100)`;
    const r = await runProcess(process.execPath, node(script), { cwd: home, logFile: log(), redactor: makeRedactor([t]), onLine: (l) => lines.push(l) });
    for (const text of [r.stdout, r.stderr, lines.join("\n"), readFileSync(log(), "utf8")]) {
      expect(text).not.toContain(t);
      expect(text).toContain(REDACTED);
    }
  });

  it("redacts a token whose halves come on stdout and stderr", async () => {
    const t = fakeToken();
    const script = `const t=${JSON.stringify(t)};const h=t.length/2;process.stdout.write("a "+t.slice(0,h));setTimeout(()=>process.stderr.write(t.slice(h)+"\\n"),100)`;
    const r = await runProcess(process.execPath, node(script), { cwd: home, logFile: log(), redactor: makeRedactor([t]) });
    expect(readFileSync(log(), "utf8")).not.toContain(t);
    expect(readFileSync(log(), "utf8")).toContain(REDACTED);
    expect(r.stdout).not.toContain(t);
    expect(r.stderr).not.toContain(t);
  });

  it("handles a multi-byte character cut by the chunk boundary", async () => {
    const t = fakeToken();
    const script = `const b=Buffer.from("é"+${JSON.stringify(t)}+"é\\n");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),100)`;
    const r = await runProcess(process.execPath, node(script), { cwd: home, logFile: log(), redactor: makeRedactor([t]) });
    expect(r.stdout).toBe(`é${REDACTED}é\n`);
  });

  it("redacts a secret that is saved while the process runs", async () => {
    const t = fakeToken();
    const go = join(home, "go");
    const script = `console.log("ready");const fs=require("fs");const i=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(i);console.log(${JSON.stringify(t)})}},20)`;
    const lines: string[] = [];
    const p = runProcess(process.execPath, node(script), {
      cwd: home,
      logFile: log(),
      onLine: (l) => {
        lines.push(l);
        if (l === "ready") {
          store("late", t);
          writeFileSync(go, "");
        }
      },
    });
    const r = await p;
    expect(r.stdout).not.toContain(t);
    expect(r.stdout).toContain(REDACTED);
    expect(readFileSync(log(), "utf8")).not.toContain(t);
  });

  it("refuses to start when the stored credentials cannot be read", async () => {
    store("one", fakeToken());
    const marker = join(home, "marker");
    const { resetRedactCache } = await import("../src/credentials/redact.js");
    resetRedactCache();
    kc.fail("find");
    await expect(runProcess(process.execPath, node(`require("fs").writeFileSync(${JSON.stringify(marker)},"x")`), { cwd: home, logFile: log() })).rejects.toThrow(/stored credentials cannot be read/);
    expect(existsSync(marker)).toBe(false);
  });
});
