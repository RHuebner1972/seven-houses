export interface TokenStore {
  get(): string | null;
  set(t: string): void;
  clear(): void;
}

export const TOKEN_KEY = "sh.token";

export function memoryTokenStore(): TokenStore {
  let t: string | null = null;
  return {
    get: () => t,
    set: (v) => {
      t = v;
    },
    clear: () => {
      t = null;
    },
  };
}

function createLocalStorageTokenStore(): TokenStore {
  // SSR / static prerender: never touch localStorage, fall back to memory.
  if (typeof window === "undefined") return memoryTokenStore();
  return {
    get: () => {
      try {
        return window.localStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    },
    set: (t) => {
      try {
        window.localStorage.setItem(TOKEN_KEY, t);
      } catch {
        /* storage unavailable */
      }
    },
    clear: () => {
      try {
        window.localStorage.removeItem(TOKEN_KEY);
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export const localStorageTokenStore: TokenStore = createLocalStorageTokenStore();

/** Unverified JWT claims as the API mints them (`sub`, `anon`, `iat`, `exp`); fields the token lacks are null. */
export interface TokenClaims {
  sub: string;
  anon: boolean | null;
  /** issued-at, unix seconds */
  iat: number | null;
  /** expiry, unix seconds */
  exp: number | null;
}

/** Tokens older than this are swapped for a fresh one on boot and when the tab becomes visible. */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Decode a JWT payload without verifying it (the API verifies; the client only needs to read).
 * Returns null for anything that is not a JWT carrying a string `sub`.
 */
export function decodeClaims(token: string | null): TokenClaims | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const p = JSON.parse(json) as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || typeof p.sub !== "string") return null;
    return {
      sub: p.sub,
      anon: typeof p.anon === "boolean" ? p.anon : null,
      iat: typeof p.iat === "number" && Number.isFinite(p.iat) ? p.iat : null,
      exp: typeof p.exp === "number" && Number.isFinite(p.exp) ? p.exp : null,
    };
  } catch {
    return null;
  }
}

/** Decode the `sub` claim of a JWT without verifying it. Returns null if malformed. */
export function decodeUserId(token: string | null): string | null {
  return decodeClaims(token)?.sub ?? null;
}

/** True when the token is still valid but older than {@link REFRESH_AFTER_MS}. */
export function needsRefresh(token: string | null, now: number = Date.now()): boolean {
  const c = decodeClaims(token);
  if (!c || c.iat === null || c.exp === null) return false;
  return c.exp * 1000 > now && now - c.iat * 1000 > REFRESH_AFTER_MS;
}
