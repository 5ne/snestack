import * as crypto from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import { Config, getConfig } from "../config";
import { ConfigError } from "../errors";
import { createApiRouter } from "./app";
import type { ApiRouter } from "./router";
import type { HttpMethod } from "./types";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB

export interface ApiServerOptions {
  host?: string;
  port?: number;
  apiToken?: string;
  /** Explicit opt-in required to bind non-loopback interfaces without SNESTACK_API_TOKEN. */
  allowUnauthenticatedRemote?: boolean;
  /** Optional fallback handler for non-`/api/` paths (e.g. static Web UI assets). */
  fallbackHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> | boolean;
  router?: ApiRouter;
}

export interface RunningApiServer {
  server: http.Server;
  router: ApiRouter;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]" || h === "::ffff:127.0.0.1";
}

export function parseListenAddr(addr: string): { host: string; port: number } {
  const trimmed = addr.trim();
  if (trimmed.startsWith(":")) {
    const port = parseInt(trimmed.slice(1), 10);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new ConfigError(`Invalid listen address "${addr}"`);
    }
    return { host: "0.0.0.0", port };
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    throw new ConfigError(`Invalid listen address "${addr}" — expected host:port or :port`);
  }
  const rawHost = trimmed.slice(0, lastColon);
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost || "0.0.0.0";
  const port = parseInt(trimmed.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`Invalid port in listen address "${addr}"`);
  }
  return { host, port };
}

function verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

class PayloadTooLargeError extends Error {}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError("Request body exceeds 5 MiB limit"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...(extraHeaders ?? {}),
  });
  res.end(payload);
}

export async function startApiServer(opts: ApiServerOptions = {}): Promise<RunningApiServer> {
  const config = getConfig();
  const envPort = Config.get(Config.API_PORT) ?? process.env.PORT;
  const host = opts.host ?? Config.get(Config.API_HOST) ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
  const port = opts.port ?? (envPort !== undefined ? parseInt(envPort, 10) : 4700);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`Invalid API port: ${String(envPort ?? opts.port)}`);
  }

  const apiToken = opts.apiToken !== undefined ? opts.apiToken : config.getApiToken();
  if (!isLoopbackHost(host) && !apiToken && !opts.allowUnauthenticatedRemote) {
    throw new ConfigError(
      `Refusing to bind non-loopback host "${host}" without ${Config.API_TOKEN} configured ` +
        `(set ${Config.API_TOKEN} or bind 127.0.0.1 for local-only access)`
    );
  }

  const router = opts.router ?? (await createApiRouter());

  const server = http.createServer(async (req, res) => {
    try {
      const method = (req.method ?? "GET").toUpperCase();
      const rawUrl = req.url ?? "/";
      const parsedUrl = new URL(rawUrl, "http://localhost");
      const pathname = parsedUrl.pathname;

      if (method === "OPTIONS") {
        res.writeHead(204, {
          Allow: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        });
        res.end();
        return;
      }

      if (!pathname.startsWith("/api/") && pathname !== "/api") {
        if (opts.fallbackHandler) {
          const handled = await opts.fallbackHandler(req, res);
          if (handled) return;
        }
        sendJson(res, 404, { error: `Not found: ${pathname}`, code: "not_found" });
        return;
      }

      const isPublicHealthProbe = method === "GET" && pathname === "/api/health";
      if (apiToken && !isPublicHealthProbe) {
        const authHeader = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
        if (!verifyBearerToken(authHeader, apiToken)) {
          sendJson(
            res,
            401,
            { error: "Unauthorized: valid Bearer token required", code: "unauthorized" },
            { "WWW-Authenticate": 'Bearer realm="snestack"' }
          );
          return;
        }
      }

      let parsedBody: unknown = undefined;
      if (method !== "GET" && method !== "HEAD") {
        let rawBody = "";
        try {
          rawBody = await readRequestBody(req);
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: err.message, code: "payload_too_large" });
            return;
          }
          throw err;
        }
        if (rawBody.trim().length > 0) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON request body", code: "invalid_json" });
            return;
          }
        }
      }

      const query: Record<string, string | undefined> = {};
      parsedUrl.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      }
      headers["x-snestack-auth-required"] = apiToken ? "1" : "0";

      const response = await router.dispatch({
        method: method as HttpMethod,
        path: pathname,
        query,
        body: parsedBody,
        headers,
      });

      sendJson(res, response.status, response.body, response.headers);
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: err instanceof Error ? err.message : String(err),
          code: "internal_error",
        });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundPort = addr.port;
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;

  return {
    server,
    router,
    host,
    port: boundPort,
    url: `http://${urlHost}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
