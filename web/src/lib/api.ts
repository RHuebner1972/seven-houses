import { ApiError } from "./errors";
import type {
  DailyResult,
  Me,
  Place,
  Profile,
  ProfileInput,
  ProfileWithChart,
  Reading,
  ReadingRequest,
  ReadingSummary,
  Spread,
} from "./types";

export function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
}

type AuthMode = "none" | "required" | "optional";

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: AuthMode;
  stream?: boolean;
  signal?: AbortSignal;
}

async function errorFrom(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const j = await res.json();
    if (j?.error) {
      code = j.error.code ?? code;
      message = j.error.message ?? message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, code, message);
}

export function createApi(
  getToken: () => string | null,
  onUnauthorized: () => Promise<string>,
  baseUrl: string = apiBase(),
) {
  async function send(path: string, o: RequestOptions, token: string | null): Promise<Response> {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    if (o.stream) headers["Accept"] = "text/event-stream";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: o.method ?? "GET",
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: o.signal,
      });
    } catch (e) {
      if ((e as { name?: string } | null)?.name === "AbortError") throw e;
      throw new ApiError(0, "network", (e as Error | null)?.message ?? "Network error");
    }
  }

  async function request(path: string, o: RequestOptions = {}): Promise<Response> {
    const mode = o.auth ?? "required";
    const token = mode === "none" ? null : getToken();
    let res = await send(path, o, token);
    if (res.status === 401 && mode === "required") {
      await res.body?.cancel().catch(() => undefined);
      const fresh = await onUnauthorized();
      res = await send(path, o, fresh);
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  async function json<T>(path: string, o: RequestOptions = {}): Promise<T> {
    const res = await request(path, o);
    return (await res.json()) as T;
  }

  async function empty(path: string, o: RequestOptions = {}): Promise<void> {
    const res = await request(path, o);
    await res.body?.cancel().catch(() => undefined);
  }

  const isSse = (res: Response) =>
    (res.headers.get("content-type") ?? "").startsWith("text/event-stream");

  async function stream(path: string, body: unknown, signal?: AbortSignal) {
    const res = await request(path, { method: "POST", body, stream: true, signal });
    if (!isSse(res) || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError(res.status, "bad_response", "Expected an event stream");
    }
    return res.body;
  }

  return {
    anonymous: () =>
      json<{ token: string; user_id: string }>("/auth/anonymous", { method: "POST", auth: "none" }),
    refresh: () => json<{ token: string }>("/auth/refresh", { method: "POST" }),
    me: () => json<Me>("/me"),
    google: (idToken: string) =>
      json<{ token: string; user_id: string }>("/auth/google", {
        method: "POST",
        body: { id_token: idToken },
      }),
    magicRequest: (email: string) =>
      empty("/auth/magic/request", { method: "POST", body: { email } }),
    magicVerify: (token: string) =>
      json<{ token: string; user_id: string }>("/auth/magic/verify", {
        method: "POST",
        body: { token },
        auth: "optional",
      }),
    deleteAccount: () => empty("/account", { method: "DELETE" }),
    geocode: (q: string) => json<Place[]>(`/geocode?q=${encodeURIComponent(q)}`),
    createProfile: (body: ProfileInput) =>
      json<ProfileWithChart>("/profiles", { method: "POST", body }),
    profiles: async (): Promise<Profile[]> =>
      (await json<{ profiles: Profile[] }>("/profiles")).profiles,
    profile: (id: string) => json<ProfileWithChart>(`/profiles/${encodeURIComponent(id)}`),
    deleteProfile: (id: string) => empty(`/profiles/${encodeURIComponent(id)}`, { method: "DELETE" }),
    spreads: () => json<Spread[]>("/spreads", { auth: "none" }),
    readings: (limit = 20) => json<ReadingSummary[]>(`/readings?limit=${limit}`),
    reading: (id: string) => json<Reading>(`/readings/${encodeURIComponent(id)}`),
    startReading: (body: ReadingRequest, signal?: AbortSignal) => stream("/readings", body, signal),
    retryReading: (id: string, signal?: AbortSignal) =>
      stream(`/readings/${encodeURIComponent(id)}/retry`, undefined, signal),
    daily: async (tz: string, signal?: AbortSignal): Promise<DailyResult> => {
      const res = await request("/daily", { method: "POST", body: { tz }, stream: true, signal });
      if (isSse(res) && res.body) return { kind: "stream", body: res.body };
      const j = (await res.json()) as { reading: Reading };
      return { kind: "reading", reading: j.reading };
    },
  };
}

export type Api = ReturnType<typeof createApi>;
