import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, describe, expect, test } from "vitest";

const SW_PATH = path.resolve(__dirname, "../public/sw.js");

type Strategy = "bypass" | "cache-first" | "navigate" | "network-first";
interface SwInternals {
  CACHE: string;
  PRECACHE: string[];
  strategyFor(request: { url: string; method: string; mode?: string }, origin: string): Strategy;
  cacheable(response: { ok: boolean; type: string } | null | undefined): boolean;
}

let source: string;
let sw: SwInternals;

beforeAll(() => {
  source = fs.readFileSync(SW_PATH, "utf8");
  // Evaluate the worker with a stub `self`; the handlers register but never fire here.
  const self = {
    listeners: {} as Record<string, unknown>,
    addEventListener(name: string, fn: unknown) {
      this.listeners[name] = fn;
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
    location: { origin: "https://app.example" },
  };
  const ctx = vm.createContext({ self, URL, console });
  vm.runInContext(source, ctx, { filename: "sw.js" });
  sw = (self as unknown as { __sh: SwInternals }).__sh;
  expect(sw, "sw.js should expose its routing helpers on self.__sh").toBeTruthy();
  for (const name of ["install", "activate", "fetch"]) expect(self.listeners[name]).toBeTypeOf("function");
});

describe("sw.js source", () => {
  test("uses the sh-v1 cache and precaches the deck back and shell routes", () => {
    expect(sw.CACHE).toBe("sh-v1");
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
  const origin = "https://app.example";
  const req = (url: string, extra: Partial<{ method: string; mode: string }> = {}) => ({
    url,
    method: extra.method ?? "GET",
    mode: extra.mode ?? "cors",
  });

  test("ignores non-GET requests", () => {
    expect(sw.strategyFor(req(`${origin}/deck/back.webp`, { method: "POST" }), origin)).toBe("bypass");
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
