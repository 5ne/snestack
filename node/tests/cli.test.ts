import { execSync } from "child_process";
import * as path from "path";

const CLI = path.resolve(__dirname, "../src/cli.ts");
const run = (args: string) =>
  execSync(
    `NODE_OPTIONS=--experimental-sqlite npx ts-node --project tsconfig.json ${CLI} ${args}`,
    { cwd: path.resolve(__dirname, ".."), encoding: "utf8", stdio: "pipe" }
  );

describe("CLI smoke tests", () => {
  it("watchlist list runs without error", () => {
    const out = run("watchlist list");
    expect(out).toMatch(/Watchlist/i);
  });

  it("position list runs without error", () => {
    const out = run("position list");
    expect(out).toMatch(/Position|No positions/i);
  });

  it("signals runs without error", () => {
    const out = run("signals");
    expect(out).toMatch(/Signal|No signals/i);
  });

  it("--help prints usage", () => {
    const out = run("--help");
    expect(out).toMatch(/Usage/i);
  });
});
