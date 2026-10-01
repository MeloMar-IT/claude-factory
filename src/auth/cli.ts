import { createInterface } from "node:readline";
import { checkEmail, checkName, checkPassword, createUser, findUserByEmail, listUsers, setPassword, setStatus, type User } from "./users.js";

/** Everything the commands need from the terminal; tests pass a fake. */
export interface UserIo {
  isTTY: boolean;
  /** Asks with echo on. */
  ask(prompt: string): Promise<string>;
  /** Asks with echo off. */
  askHidden(prompt: string): Promise<string>;
  /** The first line of stdin; undefined when there is none. */
  readStdinLine(): Promise<string | undefined>;
  out(line: string): void;
}

export const USER_USAGE = `usage: scf user create [--admin] [--name n] [--email e]   Create an account (the first one: --admin)
       scf user list                                      List accounts
       scf user password <e-mail>                         Set a new password
       scf user block <e-mail> | scf user unblock <e-mail>
The password is asked twice on a terminal, or read from the first line of stdin.`;

const ALLOWED: Record<string, string[]> = { create: ["admin", "name", "email"], list: [], password: [], block: [], unblock: [] };

export function terminalIo(stdin: NodeJS.ReadStream = process.stdin, stderr: NodeJS.WriteStream = process.stderr): UserIo {
  const cancelled = () => new Error("cancelled");
  return {
    isTTY: Boolean(stdin.isTTY),
    ask: (prompt) =>
      new Promise((resolve, reject) => {
        const rl = createInterface({ input: stdin, output: stderr, terminal: true });
        let answered = false;
        rl.on("SIGINT", () => {
          rl.close();
          reject(cancelled());
        });
        rl.on("close", () => {
          if (!answered) reject(cancelled());
        });
        rl.question(prompt, (a) => {
          answered = true;
          rl.close();
          resolve(a);
        });
      }),
    askHidden: (prompt) =>
      new Promise((resolve, reject) => {
        // raw mode first, so nothing typed before the prompt shows is echoed
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        stderr.write(prompt);
        let chars: string[] = [];
        const finish = (fn: () => void) => {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stderr.write("\n");
          fn();
        };
        const onData = (chunk: string) => {
          for (const ch of chunk) {
            if (ch === "\r" || ch === "\n") return finish(() => resolve(chars.join("")));
            if (ch === "\x03" || (ch === "\x04" && chars.length === 0)) return finish(() => reject(cancelled()));
            if (ch === "\x7f" || ch === "\b") chars = chars.slice(0, -1);
            else if (ch >= " ") chars.push(ch);
          }
        };
        stdin.on("data", onData);
      }),
    readStdinLine: () =>
      new Promise((resolve) => {
        let text = "";
        stdin.setEncoding("utf8");
        const done = () => {
          stdin.off("data", onData);
          stdin.off("end", onEnd);
          stdin.pause();
          const nl = text.indexOf("\n");
          const line = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, "");
          resolve(text === "" ? undefined : line);
        };
        const onData = (c: string) => {
          text += c;
          if (text.includes("\n") || text.length > 4096) done();
        };
        const onEnd = () => done();
        stdin.on("data", onData);
        stdin.on("end", onEnd);
        stdin.resume();
      }),
    out: (line) => void process.stdout.write(line + "\n"),
  };
}

const syntax = (why: string) => new Error(`${why}\n${USER_USAGE}`);

async function newPassword(io: UserIo): Promise<string> {
  if (!io.isTTY) {
    const line = await io.readStdinLine();
    if (!line) throw new Error("no password on stdin: give it as the first line");
    checkPassword(line);
    return line;
  }
  const first = await io.askHidden("Password: ");
  checkPassword(first);
  const second = await io.askHidden("Repeat password: ");
  if (first !== second) throw new Error("the two passwords are not the same");
  return first;
}

function accountByEmail(email: string): User {
  const u = findUserByEmail(email);
  if (!u) throw new Error(`no account with the e-mail ${email.trim().toLowerCase()}`);
  return u;
}

/** `scf user …`. `values` holds the options that were given; the syntax is checked before any read or prompt. */
export async function userCommand(args: { positionals: string[]; values: Record<string, unknown> }, io: UserIo): Promise<number> {
  const [sub, ...operands] = args.positionals;
  const allowed = sub && Object.hasOwn(ALLOWED, sub) ? ALLOWED[sub] : undefined;
  if (!sub || !allowed) throw new Error(USER_USAGE);
  for (const [k, v] of Object.entries(args.values)) {
    if (v !== undefined && !allowed.includes(k)) throw syntax(`scf user ${sub}: unexpected option --${k}`);
  }
  const need = sub === "create" || sub === "list" ? 0 : 1;
  if (operands.length !== need) throw syntax(`scf user ${sub}: ${need ? "expects one e-mail address" : "takes no operands"}`);

  switch (sub) {
    case "create": {
      const role = args.values.admin === true ? "admin" : "user";
      let name = args.values.name as string | undefined;
      let email = args.values.email as string | undefined;
      if (name === undefined || email === undefined) {
        if (!io.isTTY) throw syntax(`scf user create: ${name === undefined ? "--name" : "--email"} is needed when the input is not a terminal`);
        name ??= await io.ask("Name: ");
        email ??= await io.ask("E-mail: ");
      }
      checkName(name);
      checkEmail(email);
      const password = await newPassword(io);
      const u = await createUser({ name, email, password, role });
      io.out(`created ${u.role} ${u.email}`);
      return 0;
    }
    case "list": {
      const users = listUsers();
      if (!users.length) io.out("no accounts");
      for (const u of users) io.out(`${u.email}  ${u.name}  ${u.role}  ${u.status}`);
      return 0;
    }
    case "password": {
      const u = accountByEmail(operands[0]!);
      const password = await newPassword(io);
      await setPassword(u.id, password);
      io.out(`password changed for ${u.email}`);
      return 0;
    }
    case "block":
    case "unblock": {
      const u = accountByEmail(operands[0]!);
      const status = sub === "block" ? "blocked" : "active";
      await setStatus(u.id, status);
      io.out(`${status === "blocked" ? "blocked" : "unblocked"} ${u.email}`);
      return 0;
    }
    default:
      throw new Error(USER_USAGE);
  }
}
