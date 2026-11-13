// Thin client for the snestack HTTP JSON API. The CLI calls the exact same
// routes via ApiClient; see `snestack routes` or `GET /api/routes`.

const TOKEN_KEY = "snestack.token";

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token && token.trim()) localStorage.setItem(TOKEN_KEY, token.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage errors
  }
}

export class ApiError extends Error {
  constructor(status, message, code = "", details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildUrl(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function api(method, path, { query, body, token } = {}) {
  const activeToken = token !== undefined ? token : getToken();
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (activeToken) headers["Authorization"] = `Bearer ${activeToken}`;

  const resp = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    if (resp.status === 401) {
      window.dispatchEvent(new CustomEvent("snestack:unauthorized"));
    }
    throw new ApiError(
      resp.status,
      data.error || resp.statusText || `HTTP ${resp.status}`,
      data.code || "",
      data.details
    );
  }
  return data;
}
