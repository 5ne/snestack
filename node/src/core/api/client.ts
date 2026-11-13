import { getConfig } from "../config";
import { createApiRouter } from "./app";
import type { ApiRouter } from "./router";
import {
  ApiHttpError,
  type ApiClient,
  type ApiErrorPayload,
  type ApiRequestOptions,
  type HttpMethod,
} from "./types";

function formatQueryString(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export class InProcessApiClient implements ApiClient {
  readonly mode = "in-process" as const;
  private routerPromise: Promise<ApiRouter> | null;

  constructor(router?: ApiRouter) {
    this.routerPromise = router ? Promise.resolve(router) : null;
  }

  private getRouter(): Promise<ApiRouter> {
    if (!this.routerPromise) {
      this.routerPromise = createApiRouter();
    }
    return this.routerPromise;
  }

  async request<T = unknown>(method: HttpMethod, path: string, opts?: ApiRequestOptions): Promise<T> {
    const router = await this.getRouter();
    const query: Record<string, string | undefined> = {};
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) query[k] = String(v);
      }
    }
    const res = await router.dispatch({
      method,
      path,
      query,
      body: opts?.body,
    });
    if (res.status >= 400) {
      const errBody = (res.body ?? {}) as Partial<ApiErrorPayload>;
      throw new ApiHttpError(
        errBody.error ?? `API error (${res.status})`,
        res.status,
        errBody.code ?? "api_error",
        errBody.details
      );
    }
    return res.body as T;
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  put<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }

  patch<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>("PATCH", path, { body, query });
  }

  delete<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }
}

export class HttpApiClient implements ApiClient {
  readonly mode = "http" as const;
  private readonly baseUrl: string;
  private readonly apiToken?: string;

  constructor(baseUrl: string, apiToken?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken?.trim() || undefined;
  }

  async request<T = unknown>(method: HttpMethod, path: string, opts?: ApiRequestOptions): Promise<T> {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${this.baseUrl}${normalizedPath}${formatQueryString(opts?.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    let bodyStr: string | undefined;
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(opts.body);
    }

    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr,
    });

    const rawText = await res.text();
    let parsed: unknown = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = { error: rawText };
      }
    }

    if (!res.ok) {
      const errBody = (parsed ?? {}) as Partial<ApiErrorPayload>;
      throw new ApiHttpError(
        errBody.error ?? `HTTP ${res.status} ${res.statusText}`,
        res.status,
        errBody.code ?? "http_error",
        errBody.details
      );
    }

    return parsed as T;
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  put<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }

  patch<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    return this.request<T>("PATCH", path, { body, query });
  }

  delete<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }
}

export interface CreateApiClientOptions {
  apiUrl?: string;
  apiToken?: string;
  router?: ApiRouter;
}

export function createApiClient(opts: CreateApiClientOptions = {}): ApiClient {
  const config = getConfig();
  const apiUrl = opts.apiUrl?.trim() || config.getApiUrl();
  if (apiUrl) {
    const token = opts.apiToken !== undefined ? opts.apiToken : config.getApiToken();
    return new HttpApiClient(apiUrl, token);
  }
  return new InProcessApiClient(opts.router);
}
