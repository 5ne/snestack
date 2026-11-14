import type { Command } from "commander";
import {
  ConfigError,
  DatabaseError,
  EmailServiceError,
  ExecutorError,
  SnestackError,
  ValidationError,
} from "../errors";
import type { Finding, RunExpectation } from "../runCheck";
import type { RunStatsTarget } from "../runStats";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequest {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string | undefined>;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

export interface ApiErrorPayload {
  error: string;
  code: string;
  details?: unknown;
}

export class ApiHttpError extends SnestackError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = "api_error",
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export interface ApiRoute {
  method: HttpMethod;
  /** Route pattern beginning with `/api/`, e.g. `/api/domains/:domain/skills`. */
  pattern: string;
  /** One-line description surfaced in `GET /api/routes` and `snestack routes`. */
  summary: string;
  /** Scope owner: `"core"` or the registered domain name. */
  scope?: string;
  handler: (req: ApiRequest) => Promise<ApiResponse | unknown> | ApiResponse | unknown;
}

export interface ApiRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * Transport-agnostic API client used by both the CLI and programmatic callers.
 * Backed either by HTTP (`fetch` against `snestack serve`) when `SNESTACK_API_URL`
 * / `--api-url` is configured, or in-process dispatch against the exact same
 * `ApiRouter` when unset.
 */
export interface ApiClient {
  readonly mode: "http" | "in-process";
  request<T = unknown>(method: HttpMethod, path: string, opts?: ApiRequestOptions): Promise<T>;
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  delete<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
}

export interface CliContext {
  getClient(): ApiClient;
  isJson(): boolean;
  /** Print structured JSON when `--json` is passed, or run `formatHuman` otherwise. */
  output(data: unknown, formatHuman: () => void): void;
}

export interface DomainHealthHooks {
  /** Scheduled-run expectations owned by this domain (used by `/api/runs/check`). */
  getExpectations?: (brainRoot: string) => RunExpectation[];
  /** Run directories owned by this domain (used by `/api/runs/stats` and `/api/runs`). */
  getStatsTargets?: (brainRoot: string) => RunStatsTarget[];
  /** Extra stale dry-run directories owned by this domain. */
  getExtraDryRunRoots?: (brainRoot: string) => string[];
  /** Domain-specific health checks (e.g. cache staleness, thesis coverage). */
  checkHealth?: (opts: { now: Date; brainRoot: string }) => Promise<Finding[]>;
}

/**
 * Optional isomorphic extension exported by `domains/<domain>/api.ts` and
 * registered via `"apiModule"` in `config/domains.json`. Keeps `core/` 100%
 * domain-agnostic while giving every domain first-class HTTP routes, CLI
 * commands, and `run-check` hooks.
 */
export interface DomainApiModule {
  routes: ApiRoute[];
  registerCli?: (program: Command, ctx: CliContext) => void;
  healthHooks?: DomainHealthHooks;
}

export function isApiResponse(val: unknown): val is ApiResponse {
  return (
    typeof val === "object" &&
    val !== null &&
    "status" in val &&
    typeof (val as ApiResponse).status === "number" &&
    "body" in val
  );
}

/** Map any domain/core exception into a deterministic HTTP status + JSON error payload. */
export function mapErrorToHttp(err: unknown): ApiResponse<ApiErrorPayload> {
  if (err instanceof ApiHttpError) {
    return {
      status: err.status,
      body: {
        error: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message, code: "validation_error" } };
  }
  if (err instanceof ConfigError) {
    return { status: 500, body: { error: err.message, code: "config_error" } };
  }
  if (err instanceof DatabaseError) {
    return { status: 503, body: { error: err.message, code: "database_error" } };
  }
  if (err instanceof ExecutorError) {
    return { status: 502, body: { error: `[${err.code}] ${err.message}`, code: err.code } };
  }
  if (err instanceof EmailServiceError) {
    return { status: 502, body: { error: err.message, code: "email_error" } };
  }
  if (err instanceof Error) {
    if (/^Unknown domain\b/i.test(err.message) || /^Skill not found:/i.test(err.message)) {
      return { status: 404, body: { error: err.message, code: "not_found" } };
    }
    return { status: 500, body: { error: err.message, code: "internal_error" } };
  }
  return { status: 500, body: { error: String(err), code: "internal_error" } };
}
