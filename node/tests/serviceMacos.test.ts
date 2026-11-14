import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const nodeDir = path.resolve(__dirname, "..");
const serviceScript = path.join(nodeDir, "scripts", "service-macos.sh");

describe("scripts/service-macos.sh", () => {
  it("generates a valid LaunchAgent plist with loopback address, PATH preservation, and no embedded secrets", () => {
    const xml = execFileSync(serviceScript, ["print-plist", "--addr", "127.0.0.1:4700"], {
      cwd: nodeDir,
      env: {
        ...process.env,
        HOME: "/tmp/example-home",
        SNESTACK_NODE_BIN: "/opt/nvm/v22.0.0/bin/node",
        SNESTACK_SERVICE_LOG_DIR: "/tmp/example-logs",
        SNESTACK_API_TOKEN: "should-not-appear-in-plist",
      },
      encoding: "utf8",
    });

    expect(xml).toContain("<string>com.snestack.server</string>");
    expect(xml).toContain("<string>/opt/nvm/v22.0.0/bin/node</string>");
    expect(xml).toContain(`<string>${path.join(nodeDir, "dist", "cli.js")}</string>`);
    expect(xml).toContain("<string>127.0.0.1:4700</string>");
    expect(xml).toContain("/opt/nvm/v22.0.0/bin:/tmp/example-home/.local/bin:/opt/homebrew/bin");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).not.toContain("should-not-appear-in-plist");

    if (process.platform === "darwin") {
      // Validate against macOS's native PropertyList parser
      execFileSync("plutil", ["-lint", "-"], { input: xml });
    }
  });

  it("contains no hardcoded user home paths in the tracked script", () => {
    const src = fs.readFileSync(serviceScript, "utf8");
    expect(src).not.toMatch(/\/Users\/[A-Za-z0-9_-]+/);
    expect(src).not.toMatch(/\/Library\/CloudStorage\//);
  });
});
