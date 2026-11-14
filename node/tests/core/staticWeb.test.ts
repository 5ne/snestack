import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ApiRouter } from "../../src/core/api/router";
import { startApiServer, type RunningApiServer } from "../../src/core/api/server";
import { resolveDefaultWebDistDir } from "../../src/core/api/staticWeb";

describe("static Web UI serving (staticWeb + startApiServer)", () => {
  let tmpDir: string;
  let server: RunningApiServer | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-web-test-"));
    fs.mkdirSync(path.join(tmpDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "index.html"),
      '<!doctype html><html data-theme="auto"><body><div id="root">snestack-ui</div></body></html>',
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "assets", "app-abc123.js"),
      'console.log("snestack bundle");',
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "favicon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "utf8"
    );
  });

  afterEach(async () => {
    delete process.env.SNESTACK_WEB_DIST;
    if (server) {
      await server.close();
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildTestRouter(): ApiRouter {
    const router = new ApiRouter();
    router.register(
      {
        method: "GET",
        pattern: "/api/health",
        summary: "Health probe",
        handler: () => ({ status: "ok", version: "1.0.0" }),
      },
      "core"
    );
    router.register(
      {
        method: "GET",
        pattern: "/api/secret",
        summary: "Protected endpoint",
        handler: () => ({ secret: 42 }),
      },
      "core"
    );
    return router;
  }

  it("serves index.html at / and SPA client routes with no-cache headers", async () => {
    server = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      webDistDir: tmpDir,
      router: buildTestRouter(),
    });
    expect(server.webEnabled).toBe(true);
    expect(server.webDistDir).toBe(tmpDir);

    const rootRes = await fetch(`${server.url}/`);
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get("content-type")).toContain("text/html");
    expect(rootRes.headers.get("cache-control")).toBe("no-cache");
    expect(await rootRes.text()).toContain("snestack-ui");

    const spaRes = await fetch(`${server.url}/skills/financial/buffett-value`);
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get("content-type")).toContain("text/html");
    expect(await spaRes.text()).toContain("snestack-ui");
  });

  it("serves hashed /assets/* files with immutable cache-control and 404s missing assets", async () => {
    server = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      webDistDir: tmpDir,
      router: buildTestRouter(),
    });

    const jsRes = await fetch(`${server.url}/assets/app-abc123.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("text/javascript");
    expect(jsRes.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await jsRes.text()).toContain("snestack bundle");

    const missingAssetRes = await fetch(`${server.url}/assets/missing-chunk.js`);
    expect(missingAssetRes.status).toBe(404);
    const errJson = (await missingAssetRes.json()) as { code: string };
    expect(errJson.code).toBe("not_found");
  });

  it("blocks encoded path traversal attempts while keeping /api/* Bearer auth intact", async () => {
    server = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      apiToken: "test-secret-token",
      webDistDir: tmpDir,
      router: buildTestRouter(),
    });

    const traversal = await fetch(`${server.url}/..%2f..%2fpackage.json`);
    expect(traversal.status).toBe(404);

    // Web UI shell loads unauthenticated so the client can render the Bearer token gate
    const shellRes = await fetch(`${server.url}/`);
    expect(shellRes.status).toBe(200);

    // Protected /api/* route still enforces Bearer token
    const unauthApi = await fetch(`${server.url}/api/secret`);
    expect(unauthApi.status).toBe(401);

    const authApi = await fetch(`${server.url}/api/secret`, {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(authApi.status).toBe(200);
    expect(await authApi.json()).toEqual({ secret: 42 });
  });

  it("resolves SNESTACK_WEB_DIST when index.html exists and disables web UI when webDistDir is null", async () => {
    process.env.SNESTACK_WEB_DIST = tmpDir;
    expect(resolveDefaultWebDistDir()).toBe(tmpDir);

    server = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      webDistDir: null,
      router: buildTestRouter(),
    });
    expect(server.webEnabled).toBe(false);
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(404);
  });
});
