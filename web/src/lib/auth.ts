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

/** Decode the `sub` claim of a JWT without verifying it. Returns null if malformed. */
export function decodeUserId(token: string | null): string | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const sub = (JSON.parse(json) as { sub?: unknown } | null)?.sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}
