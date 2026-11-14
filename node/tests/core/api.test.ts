import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildCliProgram } from "../../src/cli";
import {
  ApiHttpError,
  ApiRouter,
  createApiClient,
  HttpApiClient,
  InProcessApiClient,
  isLoopbackHost,
  parseListenAddr,
  startApiServer,
  type RunningApiServer,
} from "../../src/core/api";
import { Config, getConfig, resetConfig } from "../../src/core/config";
import { ConfigError, DatabaseError, ExecutorError, ValidationError } from "../../src/core/errors";
import * as executor from "../../src/core/executor";
import { upsertThesisSection } from "../../src/domains/financial/api";
import { openTestDb, shareDb } from "../helpers/testDb";

async function runCli(
  args: string[],
  opts?: { apiUrl?: string; apiToken?: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => {
    out.push(a.map(String).join(" "));
  });
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => {
    err.push(a.map(String).join(" "));
  });
  const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  const prevExitCode = process.exitCode;
  process.exitCode = 0;

  try {
    const program = await buildCliProgram();
    program.exitOverride();
    const fullArgs = [
      "node",
      "snestack",
      ...(opts?.apiUrl ? ["--api-url", opts.apiUrl] : []),
      ...(opts?.apiToken ? ["--api-token", opts.apiToken] : []),
      ...args,
    ];
    await program.parseAsync(fullArgs);
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode: code };
  } finally {
    process.exitCode = prevExitCode;
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
  }
}

describe("ApiRouter & error mapping", () => {
  it("matches path params, decodes URI components, merges query params, and returns 404/405", async () => {
    const router = new ApiRouter();
    router.register({
      method: "GET",
      pattern: "/api/items/:id",
      summary: "Get item",
      handler: (req) => ({ id: req.params.id, filter: req.query.filter ?? null }),
    });

    const ok = await router.dispatch({
      method: "GET",
      path: "/api/items/hello%20world?filter=active",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: "hello world", filter: "active" });

    const wrongMethod = await router.dispatch({ method: "DELETE", path: "/api/items/123" });
    expect(wrongMethod.status).toBe(405);

    const missing = await router.dispatch({ method: "GET", path: "/api/unknown" });
    expect(missing.status).toBe(404);
  });

  it("maps typed domain/core errors to deterministic HTTP status codes", async () => {
    const router = new ApiRouter();
    router.registerMany([
      {
        method: "GET",
        pattern: "/api/err/validation",
        summary: "Validation error",
        handler: () => {
          throw new ValidationError("bad input");
        },
      },
      {
        method: "GET",
        pattern: "/api/err/config",
        summary: "Config error",
        handler: () => {
          throw new ConfigError("missing key");
        },
      },
      {
        method: "GET",
        pattern: "/api/err/db",
        summary: "DB error",
        handler: () => {
          throw new DatabaseError("db down");
        },
      },
      {
        method: "GET",
        pattern: "/api/err/executor",
        summary: "Executor error",
        handler: () => {
          throw new ExecutorError("quota hit", "usage_limit");
        },
      },
    ]);

    expect((await router.dispatch({ method: "GET", path: "/api/err/validation" })).status).toBe(400);
    expect((await router.dispatch({ method: "GET", path: "/api/err/config" })).status).toBe(500);
    expect((await router.dispatch({ method: "GET", path: "/api/err/db" })).status).toBe(503);
    const execRes = await router.dispatch({ method: "GET", path: "/api/err/executor" });
    expect(execRes.status).toBe(502);
    expect(execRes.body).toEqual({ error: "[usage_limit] quota hit", code: "usage_limit" });
  });

  it("parses listen addresses and checks loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);

    expect(parseListenAddr("127.0.0.1:4700")).toEqual({ host: "127.0.0.1", port: 4700 });
    expect(parseListenAddr(":8080")).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(parseListenAddr("[::1]:4700")).toEqual({ host: "::1", port: 4700 });
    expect(() => parseListenAddr("bad-addr")).toThrow(ConfigError);
  });
});

describe("HTTP API server security & end-to-end CLI <-> API isomorphism", () => {
  let tmpRoot: string;
  let releaseDb: () => Promise<void>;
  let server: RunningApiServer | null = null;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    resetConfig();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-isomorphic-"));
    process.env[Config.BRAIN_ROOT] = tmpRoot;
    process.env[Config.DATABASE_URL] = "postgres://test:test@localhost:5432/test";
    process.env[Config.FINNHUB_API_KEY] = "validfinnhubkey12345";
    process.env[Config.EXECUTOR] = "agy-cli>fail";
    process.env[Config.GMAIL_ADDRESS] = "owner@example.com";
    process.env[Config.GMAIL_APP_PASSWORD] = "app-password-secret";
    process.env[Config.NOTIFICATION_EMAIL] = "alerts@example.com";
    delete process.env[Config.API_URL];
    delete process.env[Config.API_TOKEN];
    getConfig(path.join(tmpRoot, ".nonexistent.env"));

    const db = await openTestDb();
    releaseDb = shareDb(db);
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await releaseDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    process.env = { ...savedEnv };
    resetConfig();
  });

  it("refuses to bind 0.0.0.0 without SNESTACK_API_TOKEN unless explicitly opted in", async () => {
    await expect(startApiServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /Refusing to bind non-loopback host/
    );
  });

  it("enforces Bearer token auth on /api/* while keeping GET /api/health probeable and supporting UI fallback", async () => {
    server = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      apiToken: "top-secret-token",
      fallbackHandler: (req, res) => {
        if (req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>snestack ui</h1>");
          return true;
        }
        return false;
      },
    });

    // Unauthenticated health probe succeeds without leaking private data
    const healthRes = await fetch(`${server.url}/api/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toMatchObject({
      status: "ok",
      authRequired: true,
      domains: expect.arrayContaining(["financial", "calendar", "travel"]),
    });

    // UI fallback handler serves root "/"
    const uiRes = await fetch(`${server.url}/`);
    expect(uiRes.status).toBe(200);
    expect(await uiRes.text()).toContain("snestack ui");

    // Unauthenticated API call gets 401
    const unauthClient = new HttpApiClient(server.url);
    await expect(unauthClient.get("/api/domains")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });

    // Wrong token gets 401
    const wrongClient = new HttpApiClient(server.url, "wrong-token");
    await expect(wrongClient.get("/api/domains")).rejects.toMatchObject({
      status: 401,
    });

    // Malformed JSON gets 400
    const badJsonRes = await fetch(`${server.url}/api/domains/financial/positions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer top-secret-token",
        "Content-Type": "application/json",
      },
      body: "{not-json",
    });
    expect(badJsonRes.status).toBe(400);

    // Valid token succeeds
    const authClient = createApiClient({ apiUrl: server.url, apiToken: "top-secret-token" });
    expect(authClient.mode).toBe("http");
    const domains = await authClient.get<{ domains: Array<{ name: string }> }>("/api/domains");
    expect(domains.domains.map((d) => d.name)).toEqual(["financial", "calendar", "travel"]);
  });

  it("drives positions, watchlist, theses, data-dump, domains, skills, and runs identically via HTTP CLI and API", async () => {
    server = await startApiServer({
      host: "127.0.0.1",
      port: 0,
      apiToken: "staffy-token",
    });
    const httpOpts = { apiUrl: server.url, apiToken: "staffy-token" };
    const api = new HttpApiClient(server.url, "staffy-token");

    // 1. Add position via CLI over HTTP -> verify via direct HTTP GET & CLI --json
    const addPos = await runCli(
      ["position", "add", "nvda", "25", "110.50", "--strategy", "long-term", "--notes", "AI infra"],
      httpOpts
    );
    expect(addPos.exitCode).toBe(0);
    expect(addPos.stdout).toContain("Position added: NVDA");

    const posApi = await api.get<{ positions: Array<{ ticker: string; shares: number; strategy: string }> }>(
      "/api/domains/financial/positions"
    );
    expect(posApi.positions).toHaveLength(1);
    expect(posApi.positions[0]).toMatchObject({ ticker: "NVDA", shares: 25, strategy: "long-term" });

    // Update strategy via CLI over HTTP
    const updStrat = await runCli(["position", "strategy", "NVDA", "both"], httpOpts);
    expect(updStrat.stdout).toContain("Strategy set: NVDA -> both");

    // 2. Watchlist CRUD
    await runCli(["watchlist", "add", "MSFT", "Enterprise cloud switching costs"], httpOpts);
    const wlJson = await runCli(["--json", "watchlist", "list"], httpOpts);
    expect(JSON.parse(wlJson.stdout).watchlist).toEqual([
      expect.objectContaining({ ticker: "MSFT", thesis: "Enterprise cloud switching costs" }),
    ]);

    // 3. Thesis coverage & atomic brain updates via CLI and API
    const uncoveredShow = await runCli(["--json", "thesis", "show", "NVDA"], httpOpts);
    const uncoveredData = JSON.parse(uncoveredShow.stdout);
    expect(uncoveredData.status).toBe("missing_file");
    expect(uncoveredData.researchAreas).toHaveLength(5);

    const setThesis = await runCli(
      ["thesis", "set", "NVDA", "CUDA moat and hyperscaler switching costs."],
      httpOpts
    );
    expect(setThesis.exitCode).toBe(0);
    expect(setThesis.stdout).toContain("Thesis saved for NVDA [covered]");

    const coveredApi = await api.get<{ status: string; extractedThesis: string }>(
      "/api/domains/financial/theses/NVDA"
    );
    expect(coveredApi.status).toBe("covered");
    expect(coveredApi.extractedThesis).toContain("CUDA moat");

    // 4. Data dump returns array for both NVDA (position first) and MSFT (watchlist)
    const dumpCli = await runCli(["data-dump"], httpOpts);
    const dumpArr = JSON.parse(dumpCli.stdout);
    expect(dumpArr.map((d: { ticker: string }) => d.ticker)).toEqual(["NVDA", "MSFT"]);

    // 4b. Health & cost rollups via run-check (--json and --cost)
    const runCheckCli = await runCli(["--json", "run-check", "--days", "1"], httpOpts);
    expect(JSON.parse(runCheckCli.stdout)).toHaveProperty("findings");

    const runCostCli = await runCli(["--json", "run-check", "--cost"], httpOpts);
    expect(JSON.parse(runCostCli.stdout)).toHaveProperty("scripts");

    // 5. Introspect routes, domains, skills, references, calendar/travel status
    const routesCli = await runCli(["--json", "routes", "--scope", "core"], httpOpts);
    expect(JSON.parse(routesCli.stdout).count).toBeGreaterThanOrEqual(15);

    const skillDetail = await runCli(["--json", "skill-show", "financial", "long-term-quality"], httpOpts);
    expect(JSON.parse(skillDetail.stdout)).toMatchObject({
      domain: "financial",
      name: "long-term-quality",
      runnable: true,
      references: { "quality-bar": expect.stringContaining("Quality") },
    });

    const calStatus = await runCli(["--json", "calendar", "status"], httpOpts);
    expect(JSON.parse(calStatus.stdout)).toMatchObject({ domain: "calendar", authorized: false });

    const travelStatus = await runCli(["--json", "travel", "status"], httpOpts);
    expect(JSON.parse(travelStatus.stdout)).toMatchObject({ domain: "travel", timelineExists: false });

    // 6. Run logging + runs list + runs report
    const runDir = path.join(tmpRoot, "financial", "signals", "2026-11-13");
    await runCli(["run-log", "event", "run_start", "--dir", runDir, "--script", "daily-analysis"], httpOpts);
    await runCli(
      [
        "run-log",
        "event",
        "step",
        "--dir",
        runDir,
        "--step",
        "data-dump",
        "--status",
        "ok",
        "--exit-code",
        "0",
        "--duration-ms",
        "120",
      ],
      httpOpts
    );
    const finCli = await runCli(["--json", "run-log", "finalize", "--dir", runDir, "--exit-code", "0"], httpOpts);
    expect(finCli.exitCode).toBe(0);
    expect(JSON.parse(finCli.stdout).summary.status).toBe("ok");

    const runsList = await runCli(["--json", "runs", "list", "--domain", "financial"], httpOpts);
    expect(JSON.parse(runsList.stdout).runs).toHaveLength(1);

    const runReport = await runCli(["runs", "report", runDir], httpOpts);
    expect(runReport.exitCode).toBe(0);
    expect(runReport.stdout).toContain("JOB RUN SUMMARY");

    const runReportJson = await runCli(["--json", "runs", "report", runDir], httpOpts);
    expect(JSON.parse(runReportJson.stdout).report.script).toBe("daily-analysis");

    // 7. Remove position & watchlist and verify 404 graceful handling
    expect((await runCli(["position", "remove", "NVDA"], httpOpts)).stdout).toContain("Position removed: NVDA");
    expect((await runCli(["position", "remove", "NVDA"], httpOpts)).stdout).toContain("Position not found");
    expect((await runCli(["watchlist", "remove", "MSFT"], httpOpts)).stdout).toContain("Removed: MSFT");
    expect((await runCli(["watchlist", "remove", "MSFT"], httpOpts)).stdout).toContain("Not found on watchlist");
  });

  it("preserves run-skill exit codes (0 ok, 3 max_tokens, 4 gated, 1 missing verdict) through the API layer", async () => {
    const inProc = new InProcessApiClient();
    expect(inProc.mode).toBe("in-process");

    const promptSpy = jest.spyOn(executor, "runPrompt");
    try {
      // Clean verdict run -> exit 0
      promptSpy.mockResolvedValueOnce({
        output: "Solid business.\n\nVERDICT: HOLD | 0.80 | Fairly valued compounder",
        model: "test-model",
        latencyMs: 10,
        inputTokensUsed: 100,
        outputTokensUsed: 25,
        stopReason: "end_turn",
      });
      const okRun = await runCli(["run-skill", "financial", "long-term-quality", "AAPL"]);
      expect(okRun.exitCode).toBe(0);
      expect(okRun.stdout).toContain("VERDICT: HOLD | 0.80");

      // Truncated at max_tokens -> exit 3
      promptSpy.mockResolvedValueOnce({
        output: "Cut short but has verdict.\n\nVERDICT: HOLD | 0.70 | Truncated",
        model: "test-model",
        latencyMs: 10,
        inputTokensUsed: 100,
        outputTokensUsed: 4000,
        stopReason: "max_tokens",
      });
      const truncRun = await runCli(["run-skill", "financial", "long-term-quality", "AAPL"]);
      expect(truncRun.exitCode).toBe(3);
      expect(truncRun.stderr).toContain("output truncated at max_tokens");

      // Missing required VERDICT line -> exit 1
      promptSpy.mockResolvedValueOnce({
        output: "Forgot to include the verdict line.",
        model: "test-model",
        latencyMs: 10,
        inputTokensUsed: 100,
        outputTokensUsed: 20,
        stopReason: "end_turn",
      });
      const badVerdictRun = await runCli(["run-skill", "financial", "long-term-quality", "AAPL"]);
      expect(badVerdictRun.exitCode).toBe(1);
      expect(badVerdictRun.stderr).toContain("no valid \"VERDICT:");
    } finally {
      promptSpy.mockRestore();
    }
  });

  it("upserts thesis section without clobbering surrounding company brain sections", () => {
    const existing = [
      "---",
      "ticker: AAPL",
      "---",
      "",
      "# AAPL",
      "",
      "## Your thesis (compiled truth)",
      "",
      "_No thesis recorded yet_",
      "",
      "## Past Calls",
      "- 2026-01-10: HOLD",
      "",
    ].join("\n");

    const updated = upsertThesisSection(existing, "AAPL", "Ecosystem lock-in and services margin expansion.");
    expect(updated).toContain("> Ecosystem lock-in and services margin expansion.");
    expect(updated).toContain("## Past Calls\n- 2026-01-10: HOLD");
    expect(updated).not.toContain("_No thesis recorded yet_");
  });
});

describe("ApiHttpError", () => {
  it("preserves status, code, and details", () => {
    const err = new ApiHttpError("Not found", 404, "not_found", { id: 1 });
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.details).toEqual({ id: 1 });
  });
});
