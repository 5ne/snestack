import {
  type ApiErrorPayload,
  type ApiRequest,
  type ApiResponse,
  type ApiRoute,
  type HttpMethod,
  isApiResponse,
  mapErrorToHttp,
} from "./types";

interface CompiledRoute {
  route: ApiRoute;
  regex: RegExp;
  paramNames: string[];
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const clean = pattern.endsWith("/") && pattern.length > 1 ? pattern.slice(0, -1) : pattern;
  const segments = clean.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      paramNames.push(seg.slice(1));
      return "([^/]+)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return {
    regex: new RegExp(`^${segments.join("/")}/?$`),
    paramNames,
  };
}

export interface RouteDescriptor {
  method: HttpMethod;
  pattern: string;
  summary: string;
  scope: string;
}

export class ApiRouter {
  private readonly compiled: CompiledRoute[] = [];

  register(route: ApiRoute, defaultScope = "core"): void {
    const normalized: ApiRoute = {
      ...route,
      scope: route.scope ?? defaultScope,
    };
    const { regex, paramNames } = compilePattern(normalized.pattern);
    this.compiled.push({ route: normalized, regex, paramNames });
  }

  registerMany(routes: ApiRoute[], defaultScope = "core"): void {
    for (const r of routes) this.register(r, defaultScope);
  }

  listRoutes(): RouteDescriptor[] {
    return this.compiled.map(({ route }) => ({
      method: route.method,
      pattern: route.pattern,
      summary: route.summary,
      scope: route.scope ?? "core",
    }));
  }

  async dispatch(input: {
    method: HttpMethod;
    path: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
    headers?: Record<string, string | undefined>;
  }): Promise<ApiResponse<unknown | ApiErrorPayload>> {
    const method = input.method.toUpperCase() as HttpMethod;
    const [rawPathname, rawSearch] = input.path.split("?", 2);
    const pathname = rawPathname || "/";
    const query: Record<string, string | undefined> = { ...(input.query ?? {}) };
    if (rawSearch) {
      const sp = new URLSearchParams(rawSearch);
      sp.forEach((value, key) => {
        if (query[key] === undefined) query[key] = value;
      });
    }

    let pathMatchedOtherMethod = false;

    for (const entry of this.compiled) {
      const m = entry.regex.exec(pathname);
      if (!m) continue;
      if (entry.route.method !== method) {
        pathMatchedOtherMethod = true;
        continue;
      }

      const params: Record<string, string> = {};
      entry.paramNames.forEach((name, idx) => {
        try {
          params[name] = decodeURIComponent(m[idx + 1]);
        } catch {
          params[name] = m[idx + 1];
        }
      });

      const req: ApiRequest = {
        method,
        path: pathname,
        params,
        query,
        body: input.body,
        headers: input.headers ?? {},
      };

      try {
        const out = await entry.route.handler(req);
        if (isApiResponse(out)) return out;
        return { status: 200, body: out };
      } catch (err) {
        return mapErrorToHttp(err);
      }
    }

    if (pathMatchedOtherMethod) {
      return {
        status: 405,
        body: { error: `Method ${method} not allowed for ${pathname}`, code: "method_not_allowed" },
      };
    }

    return {
      status: 404,
      body: { error: `Route not found: ${method} ${pathname}`, code: "not_found" },
    };
  }
}
