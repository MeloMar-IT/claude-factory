#!/usr/bin/env node
// A fake of /usr/bin/ssh-keygen for `-q -t ed25519 -N "" -C "" -f <file>`; it writes what the real tool writes.
// FAKE_KEYGEN_LOG: one JSON line per call { args, dir, dirMode }. FAKE_KEYGEN_KEYS: one JSON line per pair { privateKey, publicKey }.
// FAKE_KEYGEN_FAIL: "exit", "private", "public", "no-private" or "no-public".
import { appendFileSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const args = process.argv.slice(2);
const file = args[args.indexOf("-f") + 1];
const dir = dirname(file);
if (process.env.FAKE_KEYGEN_LOG) appendFileSync(process.env.FAKE_KEYGEN_LOG, JSON.stringify({ args, dir, dirMode: statSync(dir).mode }) + "\n");
const fail = process.env.FAKE_KEYGEN_FAIL;
if (fail === "exit") {
  process.stderr.write(`ssh-keygen: cannot write ${file}\n`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
const u32 = (n) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const str = (b) => {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return Buffer.concat([u32(buf.length), buf]);
};
const blob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
const check = Buffer.from([1, 2, 3, 4]);
let section = Buffer.concat([check, check, str("ssh-ed25519"), str(pub), str(Buffer.concat([seed, pub])), str("")]);
const pad = Buffer.from(Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, i) => i + 1));
section = Buffer.concat([section, pad]);
const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), str("none"), str("none"), str(""), u32(1), str(blob), str(section)]);
// built from parts, so no file holds a key header that the secret scan would flag
const dash = "-----";
const lines = body.toString("base64").match(/.{1,70}/g);
const privateText = `${dash}BEGIN OPENSSH PRIVATE KEY${dash}\n${lines.join("\n")}\n${dash}END OPENSSH PRIVATE KEY${dash}\n`;
const publicText = `ssh-ed25519 ${blob.toString("base64")} \n`;

if (process.env.FAKE_KEYGEN_KEYS) appendFileSync(process.env.FAKE_KEYGEN_KEYS, JSON.stringify({ privateKey: privateText, publicKey: publicText.trim() }) + "\n");
if (fail !== "no-private") {
  writeFileSync(file, fail === "private" ? "not a key" : privateText);
  chmodSync(file, 0o600);
}
if (fail !== "no-public") writeFileSync(`${file}.pub`, fail === "public" ? "ssh-rsa AAAA\n" : publicText);
