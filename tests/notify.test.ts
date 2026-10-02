import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { clickThrough, composeNotice, desktopCommands, inQuietHours, sendDesktop, sendSlack, summaryNotice, type NoticeItem } from "../src/notify.js";

const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00Z`);
const pages = { turn: "http://localhost:1/#/your-turn", runs: "http://localhost:1/#/runs" };
const item = (n: number, url?: string): NoticeItem => ({ what: `item ${n}`, text: `text ${n}`, url });

describe("inQuietHours", () => {
  it("handles a window inside one day", () => {
    const q = { from: "13:00", to: "15:00" };
    expect(inQuietHours(q, at("12:59"), "UTC")).toBe(false);
    expect(inQuietHours(q, at("13:00"), "UTC")).toBe(true);
    expect(inQuietHours(q, at("14:59"), "UTC")).toBe(true);
    expect(inQuietHours(q, at("15:00"), "UTC")).toBe(false);
  });
  it("handles a window over midnight", () => {
    const q = { from: "23:00", to: "07:00" };
    expect(inQuietHours(q, at("23:30"), "UTC")).toBe(true);
    expect(inQuietHours(q, at("06:59"), "UTC")).toBe(true);
    expect(inQuietHours(q, at("07:00"), "UTC")).toBe(false);
    expect(inQuietHours(q, at("12:00"), "UTC")).toBe(false);
  });
  it("is never quiet for from === to or no window", () => {
    expect(inQuietHours({ from: "08:00", to: "08:00" }, at("08:00"), "UTC")).toBe(false);
    expect(inQuietHours(undefined, at("08:00"), "UTC")).toBe(false);
  });
});

describe("composeNotice", () => {
  it("gives nothing for nothing", () => {
    expect(composeNotice([], [], pages)).toBeUndefined();
  });
  it("keeps the text and url of one item, or falls back to the page", () => {
    expect(composeNotice([item(1, "https://x/1")], [], pages)).toEqual({ title: "Foundry · your turn", message: "text 1", url: "https://x/1" });
    expect(composeNotice([item(1)], [], pages)?.url).toBe(pages.turn);
  });
  it("groups three items", () => {
    const n = composeNotice([item(1, "https://x/1"), item(2), item(3)], [], pages)!;
    expect(n).toEqual({ title: "Foundry · 3 things need you", message: "item 1; item 2; item 3", url: pages.turn });
  });
  it("says how many more", () => {
    const n = composeNotice([1, 2, 3, 4, 5].map((i) => item(i)), [], pages)!;
    expect(n.message).toBe("item 1; item 2; item 3 and 2 more");
  });
  it("cuts long names and keeps the message short", () => {
    const long = (c: string): NoticeItem => ({ what: c.repeat(200), text: "t" });
    const n = composeNotice([long("a"), long("b"), long("c")], [item(9)], pages)!;
    expect(n.message.length).toBeLessThanOrEqual(300);
    expect(n.message.endsWith("Also: 1 run succeeded.")).toBe(true);
    expect(n.message).toContain(`${"a".repeat(59)}…`);
  });
  it("tells about successes", () => {
    expect(composeNotice([], [item(1, "https://x/r1")], pages)).toEqual({ title: "Foundry · run succeeded", message: "text 1", url: "https://x/r1" });
    expect(composeNotice([], [item(1), item(2)], pages)).toEqual({ title: "Foundry · 2 runs succeeded", message: "item 1; item 2", url: pages.runs });
  });
  it("adds successes to what needs you", () => {
    const n = composeNotice([item(1, "https://x/1")], [item(2), item(3)], pages)!;
    expect(n).toEqual({ title: "Foundry · 1 thing needs you", message: "item 1 Also: 2 runs succeeded.", url: "https://x/1" });
  });
});

describe("summaryNotice", () => {
  const url = "http://localhost:1/#/your-turn";
  const base = { stories: 0, otherRuns: 0, waiting: 0, building: 0 };
  it("has the full text", () => {
    expect(summaryNotice({ stories: 3, otherRuns: 2, waiting: 1, building: 2, releaseAt: "17:00" }, url)).toEqual({
      title: "Foundry · daily summary",
      message: "Done since yesterday: 3 stories, 2 other runs. Waiting for you: 1. Expected today: 2 stories being built, release pull request around 17:00.",
      url,
    });
  });
  it("handles stories only and runs only", () => {
    expect(summaryNotice({ ...base, stories: 1 }, url)?.message).toBe("Done since yesterday: 1 story. Waiting for you: nothing. Expected today: nothing yet.");
    expect(summaryNotice({ ...base, otherRuns: 2 }, url)?.message).toContain("Done since yesterday: 2 runs.");
  });
  it("says nothing and nothing yet", () => {
    expect(summaryNotice({ ...base, waiting: 2 }, url)?.message).toBe("Done since yesterday: nothing. Waiting for you: 2. Expected today: nothing yet.");
  });
  it("names a release alone", () => {
    expect(summaryNotice({ ...base, releaseAt: "17:00" }, url)?.message).toContain("Expected today: release pull request around 17:00.");
  });
  it("gives undefined when all is empty", () => {
    expect(summaryNotice(base, url)).toBeUndefined();
  });
});

describe("desktopCommands", () => {
  it("opens only http(s) links", () => {
    const open = (url: string) => desktopCommands({ title: "t", message: "m", url })[0]!.args;
    expect(open("https://a/b")).toEqual(["-title", "t", "-message", "m", "-open", "https://a/b"]);
    expect(open("file:///etc/passwd")).not.toContain("-open");
    expect(open("javascript:alert(1)")).not.toContain("-open");
  });
  it("escapes a leading character", () => {
    for (const c of ["[", "(", "<", "-"]) expect(desktopCommands({ title: "t", message: `${c}x` })[0]!.args[3]).toBe(`\\${c}x`);
  });
  it("quotes for osascript", () => {
    const [, o] = desktopCommands({ title: 'a"b', message: "c\\d" });
    expect(o).toEqual({ cmd: "osascript", args: ["-e", 'display notification "c\\\\d" with title "a\\"b"'] });
  });
});

describe("sendDesktop", () => {
  const n = { title: "t", message: "m" };
  it("goes on when the first program fails", async () => {
    const calls: string[] = [];
    await sendDesktop(n, async (cmd) => (calls.push(cmd), cmd === "terminal-notifier" ? "failed" : "ok"));
    expect(calls).toEqual(["terminal-notifier", "osascript"]);
  });
  it("stops when the first one works", async () => {
    const calls: string[] = [];
    await sendDesktop(n, async (cmd) => (calls.push(cmd), "ok"));
    expect(calls).toEqual(["terminal-notifier"]);
  });
});

describe("with programs on the PATH", () => {
  let dir: string;
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  it("falls back to osascript when terminal-notifier exits 1", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-bin-"));
    const out = join(dir, "args");
    script("terminal-notifier", "exit 1");
    script("osascript", `printf '%s' "$2" > ${out}`);
    process.env.PATH = `${dir}:${savedPath}`;
    await sendDesktop({ title: "T", message: "M" });
    expect(readFileSync(out, "utf8")).toBe('display notification "M" with title "T"');
  });

  it("finds terminal-notifier", () => {
    dir = mkdtempSync(join(tmpdir(), "factory-bin-"));
    process.env.PATH = dir;
    expect(clickThrough()).toBe(false);
    script("terminal-notifier", "exit 0");
    expect(clickThrough()).toBe(true);
  });
});

describe("sendSlack", () => {
  it("escapes the text and adds the link", async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => (bodies.push(JSON.parse(b).text), res.end("ok")));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const hook = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    try {
      await sendSlack(hook, { title: "A & B", message: "<x> y", url: "https://x/y" });
      await sendSlack(hook, { title: "t", message: "m", url: "javascript:alert(1)" });
    } finally {
      server.close();
    }
    const bad = createServer((_req, res) => res.writeHead(500).end("no"));
    await new Promise<void>((r) => bad.listen(0, "127.0.0.1", r));
    try {
      expect(await sendSlack(`http://127.0.0.1:${(bad.address() as { port: number }).port}/h`, { title: "t", message: "m" })).toBe(false);
      expect(await sendSlack("http://127.0.0.1:1/h", { title: "t", message: "m" })).toBe(false);
    } finally {
      bad.close();
    }
    expect(bodies[0]).toBe("*A &amp; B*\n&lt;x&gt; y\n<https://x/y|Open>");
    expect(bodies[1]).toBe("*t*\nm");
  });
});

describe("notify settings", () => {
  it("has defaults", () => {
    const n = ConfigSchema.parse({}).notify;
    expect(n).toMatchObject({ successes: false, throttle_minutes: 5 });
    expect(n.quiet_hours).toBeUndefined();
    expect(n.daily_summary_at).toBeUndefined();
  });
  it("accepts an old notify block", () => {
    expect(ConfigSchema.parse({ notify: { macos: true, on: ["failed"] } }).notify.on).toEqual(["failed"]);
  });
  it("rejects bad times", () => {
    expect(ConfigSchema.safeParse({ notify: { daily_summary_at: "25:00" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ notify: { quiet_hours: { from: "22:00" } } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ notify: { throttle_minutes: 0 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ notify: { quiet_hours: { from: "22:00", to: "07:00" } } }).success).toBe(true);
  });
});
