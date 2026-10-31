import { execSync } from "child_process";
import * as path from "path";

const CLI = path.resolve(__dirname, "../src/cli.ts");
// SNESTACK_DATABASE_URL is blanked so these never reach a real database, whatever node/.env holds
// (dotenv does not override variables already set in the environment).
const run = (args: string) =>
  execSync(
    `npx ts-node --project tsconfig.json ${CLI} ${args}`,
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, SNESTACK_DATABASE_URL: "" },
    }
  );

describe("CLI smoke tests", () => {
  it.each(["watchlist list", "position list", "signals"])(
    "`%s` fails fast naming SNESTACK_DATABASE_URL when no database is configured",
    (cmd) => {
      let stderr = "";
      try {
        run(cmd);
      } catch (e) {
        stderr = String((e as { stderr?: unknown }).stderr);
      }
      expect(stderr).toMatch(/SNESTACK_DATABASE_URL/);
    }
  );

  it("--help prints usage", async () => {
    const out = run("--help");
    expect(out).toMatch(/Usage/i);
  });

  it("no longer lists the retired db-migrate command", async () => {
    expect(run("--help")).not.toMatch(/db-migrate/);
  });
});
