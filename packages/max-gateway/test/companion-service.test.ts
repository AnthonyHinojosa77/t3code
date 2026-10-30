import { describe, expect, it } from "vite-plus/test";
import { servicePaths, servicePlist, serviceRunner } from "../scripts/companion-service.ts";

describe("companion service files", () => {
  it("derives the existing installation layout from the supplied home", () => {
    const paths = servicePaths("/tmp/companion-home");
    expect(paths.app).toBe("/tmp/companion-home/.t3/max-companion/app");
    expect(paths.previous).toBe("/tmp/companion-home/.t3/max-companion/app.prev");
    expect(paths.env).toBe("/tmp/companion-home/.t3/max-gateway.env");
    expect(paths.plist).toBe(
      "/tmp/companion-home/Library/LaunchAgents/com.t3mc.max-companion.plist",
    );
  });
  it("respects the companion override without moving the env file or LaunchAgent", () => {
    const paths = servicePaths("/tmp/home", "/tmp/custom");
    expect(paths.runner).toBe("/tmp/custom/run.sh");
    expect(paths.env).toBe("/tmp/home/.t3/max-gateway.env");
    expect(paths.plist).toContain("/tmp/home/Library/LaunchAgents/");
  });
  it("escapes XML paths and preserves the service identity and restart policy", () => {
    const paths = servicePaths('/tmp/A & <B> "C"');
    const plist = servicePlist(paths);
    expect(plist).toContain("A &amp; &lt;B&gt; &quot;C&quot;");
    expect(plist).toContain("<string>com.t3mc.max-companion</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(plist.match(/logs\/companion.log/g)).toHaveLength(2);
  });
  it("quotes shell paths and executes only the bundled artifact", () => {
    const paths = servicePaths("/tmp/Owner's home");
    const runner = serviceRunner(paths, "/tmp/node bin/node");
    expect(runner).toContain("Owner'\\''s home");
    expect(runner).toContain("exec '/tmp/node bin/node'");
    expect(runner).toContain("app/companion.mjs'");
    expect(runner).toContain('export T3_BIN="${T3_BIN:-$HOME/.t3/bin/t3}"');
    expect(runner).not.toContain("miniCompanion.ts");
  });
});
