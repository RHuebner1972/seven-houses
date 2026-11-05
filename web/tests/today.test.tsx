import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import { ReadingStream } from "@/components/reading-stream";
import TodayPage from "@/app/page";
import { apiBase } from "@/lib/api";
import { localDate } from "@/lib/tz";
import type { Reading, ReadingSummary } from "@/lib/types";

// localDate() with no `at` returns tzMock.today when set (to cross midnight); otherwise real.
const tzMock = vi.hoisted(() => ({ today: undefined as string | undefined }));
vi.mock("@/lib/tz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tz")>();
  return {
    ...actual,
    localDate: (tz?: string, at?: Date) =>
      at === undefined && tzMock.today ? tzMock.today : actual.localDate(tz, at),
  };
});

const BASE = apiBase();
const jwt = (sub: string) => {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
};
let qc: QueryClient;
function Providers({ children }: { children: ReactNode }) {
  return <RealProviders queryClient={qc}>{children}</RealProviders>;
}
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

let log: { method: string; path: string; body?: unknown }[] = [];
const count = (method: string, path: string) =>
  log.filter((l) => l.method === method && l.path === path).length;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  log = [];
  tzMock.today = undefined;
  localStorage.clear();
  localStorage.setItem("sh.token", jwt("u1"));
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const CARDS = frame("cards", {
  reading_id: "r1",
  cost: 0,
  cards: [{ position: "card", card_id: "major-00-fool", reversed: false }],
});

function sse(frames: string[], { close = true } = {}) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (close) c.close();
    },
  });
  return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
}

function reading(over: Partial<Reading> = {}): Reading {
  return {
    id: "r9",
    spread_type: "daily",
    cards: [{ position: "card", card_id: "major-01-magician", reversed: true }],
    question: null,
    chart_id: null,
    text: "Stored wisdom.\n\nSecond thought.",
    status: "complete",
    created_at: new Date().toISOString(),
    ...over,
  };
}

function onDaily(resolver: (body: unknown) => Response | Promise<Response>) {
  return http.post(`${BASE}/daily`, async ({ request }) => {
    const body = await request.json();
    log.push({ method: "POST", path: "/daily", body });
    return resolver(body);
  });
}

const reveal = async () =>
  fireEvent.click(await screen.findByRole("button", { name: /reveal/i }));

test("tap flips the card and streams today's reading", async () => {
  server.use(
    onDaily(() => sse([CARDS, frame("delta", { text: "Welcome" }), frame("done", { reading_id: "r1" })])),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  expect(screen.getByRole("heading", { name: /your card for today/i })).toBeInTheDocument();
  await reveal();
  expect(await screen.findByAltText("The Fool, upright")).toBeInTheDocument();
  expect(await screen.findByText(/Welcome/)).toBeInTheDocument();
  expect(await screen.findByText(/renews at midnight/i)).toBeInTheDocument();
  const cached = JSON.parse(localStorage.getItem("sh.lastDaily")!);
  expect(cached.reading.text).toMatch(/Welcome/);
  expect(cached.reading).toMatchObject({
    id: "r1",
    spread_type: "daily",
    status: "complete",
    question: null,
    chart_id: null,
    cards: [{ card_id: "major-00-fool", reversed: false }],
  });
  expect(cached.localDate).toBe(localDate());
  expect(cached.userId).toBe("u1");
  expect(screen.getByText(/The Fool/, { selector: "p" })).toHaveTextContent(/upright/i);
  expect(screen.getByRole("link", { name: /go deeper/i })).toHaveAttribute("href", "/reading/new/");
});

test("existing complete daily renders without streaming", async () => {
  const created = new Date(Date.now() - 86_400_000);
  server.use(onDaily(() => HttpResponse.json({ reading: reading({ created_at: created.toISOString() }) })));
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText("Stored wisdom.")).toBeInTheDocument();
  expect(screen.getByText("Second thought.")).toBeInTheDocument();
  expect(screen.getByAltText("The Magician, reversed")).toBeInTheDocument();
  expect(document.querySelector("[data-streaming]")).toBeNull();
  const cached = JSON.parse(localStorage.getItem("sh.lastDaily")!);
  expect(cached.reading.id).toBe("r9");
  // stamped with the reading's own local date, not the write time
  expect(cached.localDate).toBe(localDate(undefined, created));
});

test("a cached daily for today renders instantly without a request", async () => {
  localStorage.setItem(
    "sh.lastDaily",
    JSON.stringify({ userId: "u1", localDate: localDate(), reading: reading() }),
  );
  server.use(onDaily(() => HttpResponse.json({ reading: reading() })));
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  expect(await screen.findByText("Stored wisdom.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /reveal/i })).toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  expect(count("POST", "/daily")).toBe(0);
});

test("409 polls the journal until complete", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const summary = (over: Partial<ReadingSummary>): ReadingSummary => ({
    id: "r5",
    spread_type: "daily",
    cards: [],
    question: null,
    status: "pending",
    created_at: new Date().toISOString(),
    excerpt: "",
    ...over,
  });
  let polls = 0;
  server.use(
    onDaily(() =>
      HttpResponse.json(
        { error: { code: "generation_in_progress", message: "busy" } },
        { status: 409 },
      ),
    ),
    http.get(`${BASE}/readings`, ({ request }) => {
      log.push({ method: "GET", path: "/readings" });
      expect(new URL(request.url).searchParams.get("limit")).toBe("1");
      polls++;
      return HttpResponse.json([summary({ status: polls < 2 ? "pending" : "complete" })]);
    }),
    http.get(`${BASE}/readings/r5`, () => {
      log.push({ method: "GET", path: "/readings/r5" });
      return HttpResponse.json(reading({ id: "r5", text: "Prepared at last." }));
    }),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText(/being prepared/i)).toBeInTheDocument();
  expect(count("GET", "/readings")).toBe(0);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  await waitFor(() => expect(count("GET", "/readings")).toBe(1));
  expect(screen.getByText(/being prepared/i)).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(await screen.findByText("Prepared at last.")).toBeInTheDocument();
  expect(count("GET", "/readings")).toBe(2);
  expect(count("GET", "/readings/r5")).toBe(1);
  expect(JSON.parse(localStorage.getItem("sh.lastDaily")!).reading.id).toBe("r5");
});

test("409 gives up after 30 polls with a retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(
    onDaily(() =>
      HttpResponse.json({ error: { code: "generation_in_progress", message: "busy" } }, { status: 409 }),
    ),
    http.get(`${BASE}/readings`, () => {
      log.push({ method: "GET", path: "/readings" });
      return HttpResponse.json([]);
    }),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText(/being prepared/i)).toBeInTheDocument();
  for (let i = 0; i < 30; i++) await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(await screen.findByText(/still preparing your card/i)).toBeInTheDocument();
  expect(count("GET", "/readings")).toBe(30);
  expect(localStorage.getItem("sh.lastDaily")).toBeNull();
  server.use(onDaily(() => HttpResponse.json({ reading: reading() })));
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("Stored wisdom.")).toBeInTheDocument();
});

test("a new local date invalidates the cached daily", async () => {
  localStorage.setItem(
    "sh.lastDaily",
    JSON.stringify({ userId: "u1", localDate: "2000-01-01", reading: reading({ text: "Old news." }) }),
  );
  server.use(onDaily(() => HttpResponse.json({ reading: reading({ id: "r10", text: "Fresh today." }) })));
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText("Fresh today.")).toBeInTheDocument();
  expect(screen.queryByText("Old news.")).toBeNull();
  expect(count("POST", "/daily")).toBe(1);
  const cached = JSON.parse(localStorage.getItem("sh.lastDaily")!);
  expect(cached).toMatchObject({ localDate: localDate(), reading: { id: "r10" } });
});

test("sends the browser time zone", async () => {
  server.use(onDaily(() => HttpResponse.json({ reading: reading() })));
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  await screen.findByText("Stored wisdom.");
  expect(log[0].body).toEqual({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
});

test("a stream that ends without done shows an error with Retry", async () => {
  let n = 0;
  server.use(
    onDaily(() =>
      ++n === 1
        ? sse([CARDS, frame("delta", { text: "Half a" })])
        : sse([CARDS, frame("delta", { text: "Whole thought" }), frame("done", { reading_id: "r1" })]),
    ),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText(/the reading was interrupted/i)).toBeInTheDocument();
  expect(localStorage.getItem("sh.lastDaily")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText(/Whole thought/)).toBeInTheDocument();
  await screen.findByText(/renews at midnight/i);
  expect(screen.queryByText(/Half a/)).toBeNull();
  expect(JSON.parse(localStorage.getItem("sh.lastDaily")!).reading.text).toBe("Whole thought");
});

test("a non-409 API error shows its message and Retry re-requests", async () => {
  let n = 0;
  server.use(
    onDaily(() =>
      ++n === 1
        ? HttpResponse.json({ error: { code: "boom", message: "The stars are cloudy." } }, { status: 500 })
        : HttpResponse.json({ reading: reading() }),
    ),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText("The stars are cloudy.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("Stored wisdom.")).toBeInTheDocument();
  expect(count("POST", "/daily")).toBe(2);
});

test("unmounting the Today page mid-stream aborts the request", async () => {
  const abort = vi.spyOn(AbortController.prototype, "abort");
  let req: Request | undefined;
  server.use(
    http.post(`${BASE}/daily`, ({ request }) => {
      req = request;
      return sse([CARDS, frame("delta", { text: "Midway" })], { close: false });
    }),
  );
  const { unmount } = render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText(/Midway/)).toBeInTheDocument();
  expect(document.querySelector("[data-streaming]")).toHaveAttribute("data-streaming", "true");
  abort.mockClear();
  unmount();
  expect(abort).toHaveBeenCalled();
  await waitFor(() => expect(req?.signal.aborted).toBe(true));
  expect(localStorage.getItem("sh.lastDaily")).toBeNull();
});

test("ReadingStream: paragraphs, caret, done; unmount aborts and reports delivered text", async () => {
  let signal!: AbortSignal;
  const onAbort = vi.fn();
  const onDone = vi.fn();
  const onDelta = vi.fn();
  const source = vi.fn(async (s: AbortSignal) => {
    signal = s;
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(frame("delta", { text: "One.\n\nTwo" })));
      },
    });
  });
  const { container, unmount } = render(
    <ReadingStream source={source} onAbort={onAbort} onDone={onDone} onDelta={onDelta} />,
  );
  expect(await screen.findByText("One.")).toBeInTheDocument();
  expect(screen.getByText("Two")).toBeInTheDocument();
  const root = container.querySelector("[data-streaming]")!;
  expect(root).toHaveAttribute("data-streaming", "true");
  expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
  expect(onDelta).toHaveBeenCalledWith("One.\n\nTwo");
  unmount();
  expect(signal.aborted).toBe(true);
  expect(onAbort).toHaveBeenCalledWith("One.\n\nTwo");
  expect(onDone).not.toHaveBeenCalled();
  expect(source).toHaveBeenCalledTimes(1);
});

test("ReadingStream: SSE error frame shows message and Retry re-runs source", async () => {
  let n = 0;
  const onError = vi.fn();
  const onDone = vi.fn();
  const source = vi.fn(async () => {
    n++;
    const res =
      n === 1
        ? sse([frame("delta", { text: "Partial" }), frame("error", { code: "llm_failed", message: "Lost the thread." })])
        : sse([frame("delta", { text: "Complete" }), frame("done", { reading_id: "rx" })]);
    return res.body!;
  });
  const { container } = render(<ReadingStream source={source} onError={onError} onDone={onDone} />);
  expect(await screen.findByText("Lost the thread.")).toBeInTheDocument();
  expect(onError).toHaveBeenCalledWith({ code: "llm_failed", message: "Lost the thread." });
  expect(container.querySelector("[data-streaming]")).toHaveAttribute("data-streaming", "false");
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("Complete")).toBeInTheDocument();
  expect(screen.queryByText("Partial")).toBeNull();
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("rx"));
  expect(container.querySelector("[data-streaming]")).toHaveAttribute("data-streaming", "false");
  expect(source).toHaveBeenCalledTimes(2);
});

test("a reveal that completes after midnight is cached under the day it started", async () => {
  tzMock.today = "2026-11-03";
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  server.use(
    onDaily(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          c.enqueue(enc.encode(CARDS));
          c.enqueue(enc.encode(frame("delta", { text: "Late night" })));
        },
      });
      return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
    }),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText(/Late night/)).toBeInTheDocument();
  tzMock.today = "2026-11-04";
  ctl.enqueue(enc.encode(frame("done", { reading_id: "r1" })));
  ctl.close();
  expect(await screen.findByText(/renews at midnight/i)).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("sh.lastDaily")!).localDate).toBe("2026-11-03");
});

test("409 whose daily failed re-requests once, then surfaces an error with Retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(
    onDaily(() =>
      HttpResponse.json({ error: { code: "generation_in_progress", message: "busy" } }, { status: 409 }),
    ),
    http.get(`${BASE}/readings`, () => {
      log.push({ method: "GET", path: "/readings" });
      return HttpResponse.json([
        {
          id: "rf",
          spread_type: "daily",
          cards: [],
          question: null,
          status: "failed",
          created_at: new Date().toISOString(),
          excerpt: "",
        } satisfies ReadingSummary,
      ]);
    }),
  );
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  await reveal();
  expect(await screen.findByText(/being prepared/i)).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  await waitFor(() => expect(count("POST", "/daily")).toBe(2));
  expect(await screen.findByText(/being prepared/i)).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(await screen.findByText(/couldn't prepare your card/i)).toBeInTheDocument();
  expect(count("POST", "/daily")).toBe(2);
  expect(count("GET", "/readings")).toBe(2);
  server.use(onDaily(() => HttpResponse.json({ reading: reading() })));
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("Stored wisdom.")).toBeInTheDocument();
  expect(count("POST", "/daily")).toBe(3);
});

test("ReadingStream under StrictMode calls source once and never fires onAbort", async () => {
  const onAbort = vi.fn();
  const source = vi.fn(async () => sse([frame("delta", { text: "Once" }), frame("done", { reading_id: "r" })]).body!);
  render(
    <StrictMode>
      <ReadingStream source={source} onAbort={onAbort} />
    </StrictMode>,
  );
  expect(await screen.findByText("Once")).toBeInTheDocument();
  expect(source).toHaveBeenCalledTimes(1);
  expect(onAbort).not.toHaveBeenCalled();
});

test("ReadingStream: onSettled fires exactly once, after done, error or abort", async () => {
  const settledDone = vi.fn();
  const doneSource = async () => sse([frame("done", { reading_id: "d" })]).body!;
  render(<ReadingStream source={doneSource} onSettled={settledDone} />);
  await waitFor(() => expect(settledDone).toHaveBeenCalledWith("done"));
  expect(settledDone).toHaveBeenCalledTimes(1);

  const settledErr = vi.fn();
  const errSource = async () => sse([frame("error", { code: "x", message: "Nope." })]).body!;
  render(<ReadingStream source={errSource} onSettled={settledErr} />);
  await screen.findByText("Nope.");
  expect(settledErr).toHaveBeenCalledTimes(1);
  expect(settledErr).toHaveBeenCalledWith("error");

  const settledAbort = vi.fn();
  const onAbort = vi.fn();
  const openSource = async () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(frame("delta", { text: "Half" })));
      },
    });
  const { unmount } = render(<ReadingStream source={openSource} onAbort={onAbort} onSettled={settledAbort} />);
  await screen.findByText("Half");
  unmount();
  expect(onAbort).toHaveBeenCalledTimes(1);
  expect(settledAbort).toHaveBeenCalledTimes(1);
  expect(settledAbort).toHaveBeenCalledWith("abort");
  // onAbort precedes onSettled
  expect(onAbort.mock.invocationCallOrder[0]).toBeLessThan(settledAbort.mock.invocationCallOrder[0]);

  // a source that steps aside (AbortError) is not a settlement: the caller took over
  const settledAside = vi.fn();
  const aside = async () => {
    throw new DOMException("aside", "AbortError");
  };
  render(<ReadingStream source={aside} onSettled={settledAside} />);
  await new Promise((r) => setTimeout(r, 20));
  expect(settledAside).not.toHaveBeenCalled();
});

test("another user's cached daily is not shown; the card is drawn afresh", async () => {
  localStorage.setItem(
    "sh.lastDaily",
    JSON.stringify({ userId: "someone-else", localDate: localDate(), reading: reading({ text: "Not yours." }) }),
  );
  server.use(onDaily(() => HttpResponse.json({ reading: reading({ id: "r11", text: "Yours today." }) })));
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  expect(await screen.findByRole("button", { name: /reveal/i })).toBeInTheDocument();
  expect(screen.queryByText("Not yours.")).toBeNull();
  await reveal();
  expect(await screen.findByText("Yours today.")).toBeInTheDocument();
  expect(count("POST", "/daily")).toBe(1);
  expect(JSON.parse(localStorage.getItem("sh.lastDaily")!)).toMatchObject({ userId: "u1", reading: { id: "r11" } });
});

test("a pre-scoping cache entry (no userId) is ignored", async () => {
  localStorage.setItem("sh.lastDaily", JSON.stringify({ localDate: localDate(), reading: reading({ text: "Legacy." }) }));
  server.use(onDaily(() => HttpResponse.json({ reading: reading({ id: "r12", text: "Scoped." }) })));
  render(
    <Providers>
      <TodayPage />
    </Providers>,
  );
  expect(await screen.findByRole("button", { name: /reveal/i })).toBeInTheDocument();
  expect(screen.queryByText("Legacy.")).toBeNull();
  await reveal();
  expect(await screen.findByText("Scoped.")).toBeInTheDocument();
});
