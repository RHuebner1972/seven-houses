import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createApi } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { parseSse } from "@/lib/sse";
import { collect } from "./helpers/stream";

const BASE = "http://api.test";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ME = { user_id: "u", email: null, anon: true, balance: 3 };
const sse = (body: string) =>
  new HttpResponse(body, { headers: { "Content-Type": "text/event-stream" } });

function make(token: string | null = "t1", fresh = "t2") {
  const onUnauthorized = vi.fn(async () => fresh);
  const api = createApi(() => token, onUnauthorized, BASE);
  return { api, onUnauthorized };
}

describe("errors", () => {
  test("maps error envelope to ApiError", async () => {
    server.use(
      http.post(`${BASE}/readings`, () =>
        HttpResponse.json({ error: { code: "insufficient_credits", message: "x" } }, { status: 402 }),
      ),
    );
    const { api } = make();
    await expect(api.startReading({ spread_type: "three_card" })).rejects.toMatchObject({
      status: 402,
      code: "insufficient_credits",
    });
  });

  test("network failure becomes ApiError(0, network)", async () => {
    server.use(http.get(`${BASE}/me`, () => HttpResponse.error()));
    const { api } = make();
    const err = await api.me().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network" });
  });
});

describe("401 handling", () => {
  test("retries once after 401 with a fresh token", async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get(`${BASE}/me`, ({ request }) => {
        const auth = request.headers.get("authorization");
        seen.push(auth);
        return auth === "Bearer t2"
          ? HttpResponse.json(ME)
          : HttpResponse.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 });
      }),
    );
    const { api, onUnauthorized } = make();
    await expect(api.me()).resolves.toEqual(ME);
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("throws when the retry is also 401 (no third attempt)", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/me`, () => {
        calls++;
        return HttpResponse.json({ error: { code: "unauthorized", message: "no" } }, { status: 401 });
      }),
    );
    const { api, onUnauthorized } = make();
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(calls).toBe(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("does not retry non-401 errors", async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE}/me`, () => {
        calls++;
        return HttpResponse.json({ error: { code: "not_found", message: "n" } }, { status: 404 });
      }),
    );
    const { api, onUnauthorized } = make();
    await expect(api.me()).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("public endpoints", () => {
  test("anonymous and spreads send no Authorization header", async () => {
    const auths: (string | null)[] = [];
    server.use(
      http.post(`${BASE}/auth/anonymous`, ({ request }) => {
        auths.push(request.headers.get("authorization"));
        return HttpResponse.json({ token: "x", user_id: "u" }, { status: 201 });
      }),
      http.get(`${BASE}/spreads`, ({ request }) => {
        auths.push(request.headers.get("authorization"));
        return HttpResponse.json([]);
      }),
    );
    const { api } = make();
    await expect(api.anonymous()).resolves.toEqual({ token: "x", user_id: "u" });
    await expect(api.spreads()).resolves.toEqual([]);
    expect(auths).toEqual([null, null]);
  });

  test("magicVerify sends bearer only when a token exists", async () => {
    const auths: (string | null)[] = [];
    server.use(
      http.post(`${BASE}/auth/magic/verify`, async ({ request }) => {
        auths.push(request.headers.get("authorization"));
        expect(await request.json()).toEqual({ token: "m" });
        return HttpResponse.json({ token: "x", user_id: "u" });
      }),
    );
    await make("t1").api.magicVerify("m");
    await make(null).api.magicVerify("m");
    expect(auths).toEqual(["Bearer t1", null]);
  });
});

describe("endpoints", () => {
  test("profiles unwraps list; readings passes limit", async () => {
    let url = "";
    server.use(
      http.get(`${BASE}/profiles`, () => HttpResponse.json({ profiles: [{ id: "p" }] })),
      http.get(`${BASE}/readings`, ({ request }) => {
        url = request.url;
        return HttpResponse.json([]);
      }),
    );
    const { api } = make();
    await expect(api.profiles()).resolves.toEqual([{ id: "p" }]);
    await api.readings();
    expect(new URL(url).searchParams.get("limit")).toBe("20");
    await api.readings(5);
    expect(new URL(url).searchParams.get("limit")).toBe("5");
  });

  test("geocode, createProfile, deleteProfile, deleteAccount, google, magicRequest, refresh", async () => {
    const log: string[] = [];
    server.use(
      http.get(`${BASE}/geocode`, ({ request }) => {
        log.push(`geocode ${new URL(request.url).searchParams.get("q")}`);
        return HttpResponse.json([]);
      }),
      http.post(`${BASE}/profiles`, async ({ request }) => {
        log.push(`create ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ profile: {}, chart: {} }, { status: 201 });
      }),
      http.delete(`${BASE}/profiles/p1`, () => {
        log.push("delprofile");
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${BASE}/account`, () => {
        log.push("delaccount");
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BASE}/auth/google`, async ({ request }) => {
        log.push(`google ${JSON.stringify(await request.json())}`);
        return HttpResponse.json({ token: "g", user_id: "u" });
      }),
      http.post(`${BASE}/auth/magic/request`, async ({ request }) => {
        log.push(`magic ${JSON.stringify(await request.json())}`);
        return new HttpResponse(null, { status: 202 });
      }),
      http.post(`${BASE}/auth/refresh`, () => HttpResponse.json({ token: "r" })),
    );
    const { api } = make();
    await api.geocode("Hull, MA");
    const body = {
      name: "A", birth_date: "1990-01-01", birth_time: null, tz: "UTC",
      lat: 1, lon: 2, place_label: "x",
    };
    await api.createProfile(body);
    await api.deleteProfile("p1");
    await api.deleteAccount();
    await api.google("idt");
    await api.magicRequest("a@b.c");
    await expect(api.refresh()).resolves.toEqual({ token: "r" });
    expect(log).toEqual([
      "geocode Hull, MA",
      `create ${JSON.stringify(body)}`,
      "delprofile",
      "delaccount",
      'google {"id_token":"idt"}',
      'magic {"email":"a@b.c"}',
    ]);
  });

  test("profile and reading by id", async () => {
    server.use(
      http.get(`${BASE}/profiles/p1`, () => HttpResponse.json({ profile: { id: "p1" }, chart: {} })),
      http.get(`${BASE}/readings/r1`, () => HttpResponse.json({ id: "r1" })),
    );
    const { api } = make();
    await expect(api.profile("p1")).resolves.toEqual({ profile: { id: "p1" }, chart: {} });
    await expect(api.reading("r1")).resolves.toEqual({ id: "r1" });
  });
});

describe("streaming", () => {
  test("startReading returns the stream and sends Accept: text/event-stream", async () => {
    let accept: string | null = null;
    let sent: unknown;
    server.use(
      http.post(`${BASE}/readings`, async ({ request }) => {
        accept = request.headers.get("accept");
        sent = await request.json();
        return sse('event: done\ndata: {"reading_id":"r"}\n\n');
      }),
    );
    const { api } = make();
    const body = await api.startReading({ spread_type: "three_card", question: "q" });
    expect(accept).toBe("text/event-stream");
    expect(sent).toEqual({ spread_type: "three_card", question: "q" });
    const events = await collect(parseSse(body));
    expect(events).toEqual([{ event: "done", data: { reading_id: "r" } }]);
  });

  test("retryReading posts to /readings/{id}/retry", async () => {
    server.use(http.post(`${BASE}/readings/r1/retry`, () => sse('event: done\ndata: {"reading_id":"r1"}\n\n')));
    const { api } = make();
    const body = await api.retryReading("r1");
    expect(await collect(parseSse(body))).toHaveLength(1);
  });

  test("streams are not buffered: body is returned before the response completes", async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(`${BASE}/readings`, () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode('event: delta\ndata: {"text":"a"}\n\n'));
            await gate;
            c.enqueue(enc.encode('event: done\ndata: {"reading_id":"r"}\n\n'));
            c.close();
          },
        });
        return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );
    const { api } = make();
    const body = await api.startReading({ spread_type: "daily" });
    const gen = parseSse(body);
    const first = await gen.next();
    expect(first.value).toEqual({ event: "delta", data: { text: "a" } });
    release();
    expect((await gen.next()).value?.event).toBe("done");
  });

  test("retryReading maps 409 envelope", async () => {
    server.use(
      http.post(`${BASE}/readings/r1/retry`, () =>
        HttpResponse.json({ error: { code: "generation_in_progress", message: "m" } }, { status: 409 }),
      ),
    );
    await expect(make().api.retryReading("r1")).rejects.toMatchObject({
      status: 409,
      code: "generation_in_progress",
    });
  });

  test("daily returns kind reading for JSON and kind stream for text/event-stream", async () => {
    const reading = { id: "r1", text: "t" };
    let mode: "json" | "sse" = "json";
    let sent: unknown;
    server.use(
      http.post(`${BASE}/daily`, async ({ request }) => {
        sent = await request.json();
        return mode === "json"
          ? HttpResponse.json({ reading })
          : sse('event: done\ndata: {"reading_id":"r1"}\n\n');
      }),
    );
    const { api } = make();
    await expect(api.daily("America/New_York")).resolves.toEqual({ kind: "reading", reading });
    expect(sent).toEqual({ tz: "America/New_York" });
    mode = "sse";
    const res = await api.daily("America/New_York");
    expect(res.kind).toBe("stream");
    if (res.kind === "stream") expect(await collect(parseSse(res.body))).toHaveLength(1);
  });

  test("daily maps 409 generation_in_progress", async () => {
    server.use(
      http.post(`${BASE}/daily`, () =>
        HttpResponse.json({ error: { code: "generation_in_progress", message: "m" } }, { status: 409 }),
      ),
    );
    await expect(make().api.daily("UTC")).rejects.toMatchObject({ code: "generation_in_progress" });
  });

  test("stream endpoint retries once on 401", async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.post(`${BASE}/readings`, ({ request }) => {
        const a = request.headers.get("authorization");
        seen.push(a);
        return a === "Bearer t2"
          ? sse('event: done\ndata: {"reading_id":"r"}\n\n')
          : HttpResponse.json({ error: { code: "unauthorized", message: "n" } }, { status: 401 });
      }),
    );
    const { api } = make();
    await api.startReading({ spread_type: "daily" });
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });
});

