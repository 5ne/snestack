import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Config } from "../config";
import { defaultNodeDir } from "../domainRegistry";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Locate the built Vite `dist/` directory for the Web UI if present.
 * Checks `SNESTACK_WEB_DIST`, then `<repo>/web/dist`, then `<nodeDir>/dist/web`.
 */
export function resolveDefaultWebDistDir(nodeDir?: string): string | null {
  const envDir = Config.get("SNESTACK_WEB_DIST");
  const baseNodeDir = nodeDir ?? defaultNodeDir();
  const candidates = [
    ...(envDir ? [path.resolve(envDir)] : []),
    path.resolve(baseNodeDir, "../web/dist"),
    path.resolve(baseNodeDir, "dist/web"),
  ];
  for (const candidate of candidates) {
    const indexHtml = path.join(candidate, "index.html");
    if (fs.existsSync(indexHtml) && fs.statSync(indexHtml).isFile()) {
      return candidate;
    }
  }
  return null;
}

function sendFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  cacheControl: string
): void {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const stat = fs.statSync(filePath);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": stat.size.toString(),
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  };
  res.writeHead(200, headers);
  if ((req.method ?? "GET").toUpperCase() === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });
  stream.pipe(res);
}

/**
 * Build a static asset + SPA `index.html` fallback handler for `startApiServer`.
 * Serves hashed Vite assets with immutable caching and falls back to `index.html`
 * only for extensionless client-side navigation routes (never for missing `.js`/`.css` assets).
 */
export function createStaticWebHandler(
  distDir: string
): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  const rootDir = path.resolve(distDir);
  const indexHtmlPath = path.join(rootDir, "index.html");

  return (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return false;
    }

    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, "http://localhost");
    if (rawUrl.toLowerCase().includes("%2f") || rawUrl.toLowerCase().includes("%5c")) {
      return false;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      return false;
    }
    if (decodedPath.includes("\0")) {
      return false;
    }

    const normalizedRel = decodedPath.replace(/^\/+/, "");
    const candidatePath = path.resolve(rootDir, normalizedRel || "index.html");
    if (candidatePath !== rootDir && !candidatePath.startsWith(rootDir + path.sep)) {
      return false;
    }

    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      const isImmutableAsset = normalizedRel.startsWith("assets/");
      sendFile(
        req,
        res,
        candidatePath,
        isImmutableAsset ? "public, max-age=31536000, immutable" : "no-cache"
      );
      return true;
    }

    // SPA fallback: only serve index.html for extensionless navigation paths
    const lastSegment = path.posix.basename(decodedPath);
    if (!lastSegment.includes(".") && fs.existsSync(indexHtmlPath) && fs.statSync(indexHtmlPath).isFile()) {
      sendFile(req, res, indexHtmlPath, "no-cache");
      return true;
    }

    return false;
  };
}
