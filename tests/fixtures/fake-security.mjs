#!/usr/bin/env node
// A fake of /usr/bin/security for the three calls the credential store makes.
// FAKE_KEYCHAIN_FILE: where the items live. FAKE_KEYCHAIN_LOG: one JSON line per call (arguments only).
// FAKE_KEYCHAIN_FAIL: "find", "add" or "delete" makes that call fail.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = process.env.FAKE_KEYCHAIN_FILE;
if (process.env.FAKE_KEYCHAIN_LOG) appendFileSync(process.env.FAKE_KEYCHAIN_LOG, JSON.stringify(args) + "\n");
const items = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const arg = (flag) => args[args.indexOf(flag) + 1];
const name = `${arg("-s")}\u0000${arg("-a")}`;
const op = { "find-generic-password": "find", "add-generic-password": "add", "delete-generic-password": "delete" }[args[0]];
if (!op) process.exit(2);
if (process.env.FAKE_KEYCHAIN_FAIL === op) {
  process.stderr.write("security: fake failure\n");
  process.exit(1);
}
if (op === "find") {
  const v = items()[name];
  if (v === undefined) process.exit(44);
  process.stdout.write(v + "\n");
} else if (op === "delete") {
  const all = items();
  if (!(name in all)) process.exit(44);
  delete all[name];
  writeFileSync(file, JSON.stringify(all));
} else {
  // `-w` last: the password comes from stdin, twice
  if (args.at(-1) !== "-w") process.exit(3);
  const lines = readFileSync(0, "utf8").split("\n");
  if (!lines[0] || lines[0] !== lines[1]) process.exit(4);
  const all = items();
  all[name] = lines[0];
  writeFileSync(file, JSON.stringify(all));
}
