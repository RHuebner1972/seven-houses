/**
 * Google Identity Services loader. The script is appended once and every caller
 * shares the same promise; tests stub `window.google` and never hit the network.
 */

export const GIS_SRC = "https://accounts.google.com/gsi/client";

export type GisId = typeof google.accounts.id;

export class GisNotConfiguredError extends Error {
  constructor() {
    super("NEXT_PUBLIC_GOOGLE_CLIENT_ID is not set");
    this.name = "GisNotConfiguredError";
  }
}

/** The OAuth client id baked into the static build, or null when sign-in is not configured. */
export function googleClientId(): string | null {
  // Literal read so Next inlines it at build time.
  const id = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  return id && id.trim() ? id.trim() : null;
}

let loading: Promise<GisId> | null = null;

function present(): GisId | null {
  return typeof window !== "undefined" ? (window.google?.accounts?.id ?? null) : null;
}

export function loadGis(): Promise<GisId> {
  if (!googleClientId()) return Promise.reject(new GisNotConfiguredError());
  if (typeof window === "undefined") return Promise.reject(new Error("GIS needs a browser"));
  const ready = present();
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<GisId>((resolve, reject) => {
    const settle = () => {
      const id = present();
      if (id) resolve(id);
      else {
        loading = null;
        reject(new Error("Google sign-in script loaded without google.accounts.id"));
      }
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", settle, { once: true });
    script.addEventListener(
      "error",
      () => {
        loading = null;
        script.remove();
        reject(new Error("Google sign-in script failed to load"));
      },
      { once: true },
    );
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return loading;
}

/** Test seam: forget an in-flight or failed load. */
export function resetGisForTests(): void {
  loading = null;
}
