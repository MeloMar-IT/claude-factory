import { describe, expect, it } from "vitest";
import { servicePlist } from "../src/service.js";

describe("launchd service", () => {
  it("runs factory serve with the current PATH and logs to a file", () => {
    const xml = servicePlist({ cliPath: "/x/dist/cli.js", port: 4777, repo: "/Users/me/code & stuff", logFile: "/tmp/f.log" });
    expect(xml).toContain("<string>/x/dist/cli.js</string>\n    <string>serve</string>");
    expect(xml).toContain("<string>/Users/me/code &amp; stuff</string>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>PATH</key>");
  });
});
