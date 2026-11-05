import vm from "node:vm";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildId, renderSw } from "../scripts/make-sw.mjs";

// The tests render scripts/sw.src.js through the same stamping step prebuild uses, so they
// never depend on the gitignored public/sw.js having been generated.
const BUILD = "testbuild";

type Strategy = "bypass" | "cache-first" | "navigate" | "network-first";
interface FakeResponse {
  ok: boolean;
  type: string;
  status?: number;
  clone(): FakeResponse;
}
interface FakeEvent {
  request: { url: string; method: string; mode?: string; headers?: Headers };
  waitUntil(p: Promise<unknown>): void;
}
interface SwInternals {
  CACHE: string;
  PRECACHE: string[];
  strategyFor(request: FakeEvent["request"], origin: string): Strategy;
  cacheable(response: Partial<FakeResponse> | null | undefined): boolean;
  cacheFirst(event: FakeEvent): Promise<FakeResponse>;
  networkFirst(event: FakeEvent, fallbackToShell: boolean): Promise<FakeResponse>;
}

const origin = "https://app.example";
let source: string;
let sw: SwInternals;
// Mutable stubs the sandbox reaches through `fetch` and `self.caches`.
const stubs = {
  fetch: vi.fn<(r: unknown) => Promise<FakeResponse>>(),
  put: vi.fn<(r: unknown, res: unknown) => Promise<void>>(),
  match: vi.fn<(r: unknown) => Promise<FakeResponse | undefined>>(),
};

beforeAll(() => {
  source = renderSw(BUILD);
  const self = {
    listeners: {} as Record<string, unknown>,
    addEventListener(name: string, fn: unknown) {
      this.listeners[name] = fn;
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin },
    caches: {
      open: async () => ({ put: (r: unknown, res: unknown) => stubs.put(r, res) }),
      match: (r: unknown) => stubs.match(r),
    },
  };
  const ctx = vm.createContext({
    self,
    URL,
    console,
    fetch: (r: unknown) => stubs.fetch(r),
  });
  vm.runInContext(source, ctx, { filename: "sw.js" });
  sw = (self as unknown as { __sh: SwInternals }).__sh;
  expect(sw, "sw.js should expose its routing helpers on self.__sh").toBeTruthy();
  for (const name of ["install", "activate", "fetch"]) expect(self.listeners[name]).toBeTypeOf("function");
});

beforeEach(() => {
  stubs.fetch.mockReset();
  stubs.put.mockReset().mockResolvedValue(undefined);
  stubs.match.mockReset().mockResolvedValue(undefined);
});

const req = (url: string, extra: Partial<FakeEvent["request"]> = {}): FakeEvent["request"] => ({
  url,
  method: extra.method ?? "GET",
  mode: extra.mode ?? "cors",
  headers: extra.headers ?? new Headers(),
});

const response = (over: Partial<FakeResponse> = {}): FakeResponse => {
  const r: FakeResponse = { ok: true, type: "basic", status: 200, clone: () => r, ...over };
  return r;
};

const event = (request: FakeEvent["request"]) => {
  const pending: Promise<unknown>[] = [];
  return { request, waitUntil: (p: Promise<unknown>) => pending.push(p), pending };
};

describe("build stamping", () => {
  test("cache name carries the build id and no placeholder survives", () => {
    expect(sw.CACHE).toBe(`sh-${BUILD}`);
    expect(source).not.toContain("__BUILD_ID__");
    expect(renderSw("abc", "x __BUILD_ID__ y __BUILD_ID__")).toBe("x abc y abc");
    expect(() => renderSw("abc", "no placeholder")).toThrow();
  });

  test("buildId prefers the commit sha and is cache-name safe", () => {
    expect(buildId({ VERCEL_GIT_COMMIT_SHA: "ABCDEF1234567890" })).toBe("abcdef12");
    expect(buildId({})).toMatch(/^[a-z0-9]+$/);
  });
});

describe("sw.js source", () => {
  test("precaches the deck back and shell routes", () => {
    for (const url of ["/deck/back.webp", "/", "/journal/", "/chart/", "/manifest.webmanifest"])
      expect(sw.PRECACHE).toContain(url);
    expect(sw.PRECACHE.some((u) => u.startsWith("/icons/"))).toBe(true);
    for (const u of sw.PRECACHE) expect(u.startsWith("/")).toBe(true);
  });

  test("contains no API origin literal", () => {
    expect(source).not.toMatch(/localhost/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/NEXT_PUBLIC_API_URL/);
  });
});

describe("strategyFor", () => {
  test("ignores non-GET requests", () => {
    expect(sw.strategyFor(req(`${origin}/deck/back.webp`, { method: "POST" }), origin)).toBe("bypass");
  });

  test("ignores Range requests (Cache.put rejects 206 responses)", () => {
    const headers = new Headers({ Range: "bytes=0-1023" });
    expect(sw.strategyFor(req(`${origin}/deck/back.webp`, { headers }), origin)).toBe("bypass");
  });

  test("ignores cross-origin requests (the API lives elsewhere)", () => {
    expect(sw.strategyFor(req("https://api.example/readings"), origin)).toBe("bypass");
    expect(sw.strategyFor(req("https://api.example/", { mode: "navigate" }), origin)).toBe("bypass");
  });

  test("ignores same-origin /api paths", () => {
    expect(sw.strategyFor(req(`${origin}/api/me`), origin)).toBe("bypass");
    expect(sw.strategyFor(req(`${origin}/api`), origin)).toBe("bypass");
    expect(sw.strategyFor(req(`${origin}/apiary/`), origin)).not.toBe("bypass");
  });

  test("deck images and Next static chunks are cache-first", () => {
    expect(sw.strategyFor(req(`${origin}/deck/major-00-fool.webp`), origin)).toBe("cache-first");
    expect(sw.strategyFor(req(`${origin}/_next/static/chunks/app.js`), origin)).toBe("cache-first");
  });

  test("navigations are network-first with shell fallback", () => {
    expect(sw.strategyFor(req(`${origin}/journal/`, { mode: "navigate" }), origin)).toBe("navigate");
  });

  test("other same-origin GETs are network-first", () => {
    expect(sw.strategyFor(req(`${origin}/manifest.webmanifest`), origin)).toBe("network-first");
    expect(sw.strategyFor(req(`${origin}/icons/icon-192.png`), origin)).toBe("network-first");
  });
});

describe("cacheable", () => {
  test("only ok, non-opaque responses are stored", () => {
    expect(sw.cacheable({ ok: true, type: "basic" })).toBe(true);
    expect(sw.cacheable({ ok: false, type: "basic" })).toBe(false);
    expect(sw.cacheable({ ok: true, type: "opaque" })).toBe(false);
    expect(sw.cacheable(null)).toBe(false);
  });
});

describe("cache writes never block the response", () => {
  test("network-first returns the response even when cache.put rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = response();
    stubs.fetch.mockResolvedValue(res);
    stubs.put.mockRejectedValue(new Error("QuotaExceededError"));
    const ev = event(req(`${origin}/icons/icon-192.png`));
    await expect(sw.networkFirst(ev, false)).resolves.toBe(res);
    expect(ev.pending).toHaveLength(1);
    await expect(ev.pending[0]).resolves.toBeUndefined(); // rejection swallowed, logged
    expect(stubs.put).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("sw cache put failed", `${origin}/icons/icon-192.png`, expect.any(Error));
    warn.mockRestore();
  });

  test("cache-first returns the network response even when cache.put rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = response();
    stubs.fetch.mockResolvedValue(res);
    stubs.put.mockRejectedValue(new TypeError("partial response"));
    const ev = event(req(`${origin}/deck/back.webp`));
    await expect(sw.cacheFirst(ev)).resolves.toBe(res);
    await expect(ev.pending[0]).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  test("cache-first serves a hit without touching the network", async () => {
    const hit = response();
    stubs.match.mockResolvedValue(hit);
    const ev = event(req(`${origin}/deck/back.webp`));
    await expect(sw.cacheFirst(ev)).resolves.toBe(hit);
    expect(stubs.fetch).not.toHaveBeenCalled();
  });

  test("non-ok responses are returned but not written", async () => {
    const res = response({ ok: false, status: 404 });
    stubs.fetch.mockResolvedValue(res);
    const ev = event(req(`${origin}/missing.png`));
    await expect(sw.networkFirst(ev, false)).resolves.toBe(res);
    expect(ev.pending).toHaveLength(0);
    expect(stubs.put).not.toHaveBeenCalled();
  });

  test("navigation falls back to the cached shell when offline", async () => {
    const shell = response();
    stubs.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    stubs.match.mockImplementation(async (r) => (r === "/" ? shell : undefined));
    const ev = event(req(`${origin}/journal/`, { mode: "navigate" }));
    await expect(sw.networkFirst(ev, true)).resolves.toBe(shell);
  });
});
