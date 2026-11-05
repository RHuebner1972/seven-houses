import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import JournalPage from "@/app/journal/page";
import ReadingPage from "@/app/reading/page";
import { BalancePill } from "@/components/balance-pill";
import { apiBase } from "@/lib/api";
import { POLL_INTERVAL_MS, POLL_MAX_MS } from "@/hooks/use-readings";
import type { Reading, ReadingSummary, Spread } from "@/lib/types";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/journal/",
}));

const BASE = apiBase();
let qc: QueryClient;
function Providers({ children }: { children: ReactNode }) {
  return <RealProviders queryClient={qc}>{children}</RealProviders>;
}
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

let log: { method: string; path: string }[] = [];
const count = (method: string, path: string) =>
  log.filter((l) => l.method === method && l.path === path).length;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  log = [];
  nav.search = "";
  localStorage.clear();
  localStorage.setItem("sh.token", "tok");
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function sse(frames: string[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
}

const pos = (key: string, name: string) => ({ key, name, meaning: `About ${name.toLowerCase()}.` });
const SPREADS: Spread[] = [
  { type: "daily", name: "Card of the Day", credits: 0, positions: [pos("card", "Card of the Day")] },
  {
    type: "three_card",
    name: "Three Card",
    credits: 1,
    positions: [pos("past", "Past"), pos("present", "Present"), pos("future", "Future")],
  },
  {
    type: "celtic_cross",
    name: "Celtic Cross",
    credits: 3,
    positions: [
      pos("present", "Present"),
      pos("challenge", "Challenge"),
      pos("past", "Past"),
      pos("future", "Future"),
      pos("above", "Above"),
      pos("below", "Below"),
      pos("advice", "Advice"),
      pos("external", "External Influences"),
      pos("hopes_fears", "Hopes and Fears"),
      pos("outcome", "Outcome"),
    ],
  },
];
const IDS = [
  "major-00-fool", "major-01-magician", "major-02-high-priestess", "major-03-empress", "major-04-emperor",
  "major-05-hierophant", "major-06-lovers", "major-07-chariot", "major-08-strength", "major-09-hermit",
];
const cardsFor = (spread: Spread) =>
  spread.positions.map((p, i) => ({ position: p.key, card_id: IDS[i], reversed: i === 1 }));

const complete: ReadingSummary = {
  id: "r1",
  spread_type: "three_card",
  cards: cardsFor(SPREADS[1]),
  question: "Should I take the job?",
  status: "complete",
  created_at: "2026-11-01T10:00:00Z",
  excerpt: "The Fool opens the door to a leap you have been circling…",
};
const pending: ReadingSummary = {
  id: "r2",
  spread_type: "celtic_cross",
  cards: cardsFor(SPREADS[2]),
  question: null,
  status: "pending",
  created_at: "2026-11-03T09:00:00Z",
  excerpt: "",
};
const failed: ReadingSummary = {
  id: "r3",
  spread_type: "daily",
  cards: cardsFor(SPREADS[0]),
  question: null,
  status: "failed",
  created_at: "2026-11-02T08:00:00Z",
  excerpt: "A quiet morning",
};

const full = (s: ReadingSummary, text: string, extra: Partial<Reading> = {}): Reading => ({
  id: s.id,
  spread_type: s.spread_type,
  cards: s.cards,
  question: s.question,
  chart_id: null,
  text,
  status: s.status,
  created_at: s.created_at,
  ...extra,
});

const spreadsHandler = http.get(`${BASE}/spreads`, () => HttpResponse.json(SPREADS));
function readingsHandler(list: ReadingSummary[]) {
  return http.get(`${BASE}/readings`, ({ request }) => {
    log.push({ method: "GET", path: new URL(request.url).pathname + new URL(request.url).search });
    return HttpResponse.json(list);
  });
}

function renderJournal() {
  return render(
    <Providers>
      <JournalPage />
    </Providers>,
  );
}
function renderDetail(id: string) {
  nav.search = `id=${id}`;
  return render(
    <Providers>
      <ReadingPage />
    </Providers>,
  );
}

test("lists readings newest first with status badges and up to three cards per row", async () => {
  // API order is deliberately scrambled; the page sorts by created_at desc.
  server.use(spreadsHandler, readingsHandler([complete, failed, pending]));
  renderJournal();
  const items = await screen.findAllByRole("listitem");
  expect(items).toHaveLength(3);
  expect(within(items[0]).getByRole("link")).toHaveAttribute("href", "/reading/?id=r2");
  expect(within(items[1]).getByRole("link")).toHaveAttribute("href", "/reading/?id=r3");
  expect(within(items[2]).getByRole("link")).toHaveAttribute("href", "/reading/?id=r1");

  expect(within(items[0]).getByText("Preparing…")).toBeInTheDocument();
  expect(within(items[1]).getByText("Didn't complete — retry")).toBeInTheDocument();
  expect(within(items[2]).queryByText(/Preparing|Didn't complete/)).toBeNull();

  // spread names and dates come along
  expect(within(items[0]).getByText("Celtic Cross")).toBeInTheDocument();
  expect(within(items[2]).getByText("Three Card")).toBeInTheDocument();
  expect(within(items[2]).getByText(/Nov 1, 2026/)).toBeInTheDocument();
  expect(within(items[2]).getByText(complete.excerpt)).toBeInTheDocument();

  // celtic cross has ten cards; the row shows the first three, face-up
  const imgs = within(items[0]).getAllByRole("img");
  expect(imgs).toHaveLength(3);
  expect(imgs[0]).toHaveAttribute("alt", "The Fool, upright");
  expect(imgs[1]).toHaveAttribute("alt", "The Magician, reversed");
  expect(within(items[1]).getAllByRole("img")).toHaveLength(1);
  expect(count("GET", "/readings?limit=50")).toBe(1);
});

test("search filters by excerpt and question, case-insensitively, with an empty-result state", async () => {
  server.use(spreadsHandler, readingsHandler([complete, failed, pending]));
  renderJournal();
  await screen.findAllByRole("listitem");
  const box = screen.getByRole("searchbox", { name: /search/i });

  fireEvent.change(box, { target: { value: "QUIET" } });
  let items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(1);
  expect(within(items[0]).getByRole("link")).toHaveAttribute("href", "/reading/?id=r3");

  fireEvent.change(box, { target: { value: "the job" } });
  items = screen.getAllByRole("listitem");
  expect(items).toHaveLength(1);
  expect(within(items[0]).getByRole("link")).toHaveAttribute("href", "/reading/?id=r1");

  fireEvent.change(box, { target: { value: "zebra" } });
  expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  expect(screen.getByText(/nothing in your journal matches/i)).toBeInTheDocument();

  fireEvent.change(box, { target: { value: "" } });
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

test("empty journal invites a first reading", async () => {
  server.use(spreadsHandler, readingsHandler([]));
  renderJournal();
  expect(await screen.findByText(/no readings yet/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /new reading/i })).toHaveAttribute("href", "/reading/new/");
});

test("list fetch failure shows an error with retry, not a dead screen", async () => {
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings`, () =>
      HttpResponse.json({ error: { code: "boom", message: "x" } }, { status: 500 }),
    ),
  );
  renderJournal();
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load your journal/i);
  expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
});

test("detail renders cards, question, spread, date, and paragraphs", async () => {
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings/r1`, () =>
      HttpResponse.json(full(complete, "First paragraph.\n\nSecond paragraph.\n\nFor reflection and entertainment.")),
    ),
  );
  renderDetail("r1");
  expect(await screen.findByRole("heading", { name: "Three Card" })).toBeInTheDocument();
  expect(screen.getByText(/Should I take the job\?/)).toBeInTheDocument();
  expect(screen.getByText(/Nov 1, 2026/)).toBeInTheDocument();

  // all three cards face-up, in their named positions
  for (const alt of ["The Fool, upright", "The Magician, reversed", "The High Priestess, upright"]) {
    const img = screen.getByRole("img", { name: alt });
    expect(img.closest("[aria-hidden='true']")).toBeNull();
  }
  expect(screen.getByRole("group", { name: "Past" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Future" })).toBeInTheDocument();

  const paras = screen.getAllByText(/paragraph\.$/).map((el) => el.tagName);
  expect(paras).toEqual(["P", "P"]);
  expect(screen.getByText("For reflection and entertainment.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /journal/i })).toHaveAttribute("href", "/journal/");
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
});

test("failed detail offers retry which streams /readings/{id}/retry and then shows the completed text", async () => {
  let status = "failed";
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings/r3`, () => {
      log.push({ method: "GET", path: "/readings/r3" });
      return HttpResponse.json(
        full(failed, status === "failed" ? "A quiet morning" : "A quiet morning, then light.", { status }),
      );
    }),
    http.post(`${BASE}/readings/r3/retry`, () => {
      log.push({ method: "POST", path: "/readings/r3/retry" });
      status = "complete";
      return sse([
        frame("cards", { reading_id: "r3", cost: 0, cards: failed.cards }),
        frame("delta", { text: "A quiet morning, " }),
        frame("delta", { text: "then light." }),
        frame("done", { reading_id: "r3" }),
      ]);
    }),
  );
  renderDetail("r3");
  expect(await screen.findByText(/didn't complete/i)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "The Fool, upright" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("A quiet morning, then light.")).toBeInTheDocument();
  expect(count("POST", "/readings/r3/retry")).toBe(1);
  // done → the reading is re-read and the failure notice goes away
  await waitFor(() => expect(count("GET", "/readings/r3")).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(screen.queryByText(/didn't complete/i)).toBeNull());
  expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  expect(screen.getAllByText("A quiet morning, then light.")).toHaveLength(1);
});

test("pending detail shows Preparing… and polls until the reading completes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let calls = 0;
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings/r2`, () => {
      calls++;
      return HttpResponse.json(
        calls < 3 ? full(pending, "") : full(pending, "The cross resolves.", { status: "complete" }),
      );
    }),
  );
  renderDetail("r2");
  expect(await screen.findByText("Preparing…")).toBeInTheDocument();
  expect(calls).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50));
  await waitFor(() => expect(calls).toBe(2));
  expect(screen.getByText("Preparing…")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 50));
  expect(await screen.findByText("The cross resolves.")).toBeInTheDocument();
  expect(screen.queryByText("Preparing…")).toBeNull();
  // complete: no further polling
  await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2));
  expect(calls).toBe(3);
});

test("unknown reading shows not found and a way back", async () => {
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings/nope`, () =>
      HttpResponse.json({ error: { code: "not_found", message: "no" } }, { status: 404 }),
    ),
  );
  renderDetail("nope");
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't find that reading/i);
  expect(screen.getByRole("link", { name: /journal/i })).toHaveAttribute("href", "/journal/");
});

test("detail without ?id= points back to the journal", () => {
  server.use(spreadsHandler);
  render(
    <Providers>
      <ReadingPage />
    </Providers>,
  );
  expect(screen.getByRole("link", { name: /journal/i })).toHaveAttribute("href", "/journal/");
});

test("detail still lays out a daily reading even though the spread picker hides daily", async () => {
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings/r3`, () => HttpResponse.json(full(failed, "Done.", { status: "complete" }))),
  );
  renderDetail("r3");
  expect(await screen.findByRole("heading", { name: "Card of the Day" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Card of the Day" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "The Fool, upright" })).toBeInTheDocument();
});

test("pending detail stops polling after the cap and offers to check again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let calls = 0;
  server.use(
    spreadsHandler,
    http.get(`${BASE}/readings/r2`, () => {
      calls++;
      return HttpResponse.json(full(pending, ""));
    }),
  );
  renderDetail("r2");
  expect(await screen.findByText("Preparing…")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTimeAsync(POLL_MAX_MS + POLL_INTERVAL_MS));
  expect(await screen.findByText(/still preparing/i)).toBeInTheDocument();
  const after = calls;
  expect(after).toBeGreaterThan(2);
  await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3));
  expect(calls).toBe(after);
  fireEvent.click(screen.getByRole("button", { name: /check again/i }));
  await waitFor(() => expect(calls).toBe(after + 1));
});

test("retrying a failed reading re-reads the balance when the stream settles", async () => {
  let status = "failed";
  server.use(
    spreadsHandler,
    http.get(`${BASE}/me`, () => {
      log.push({ method: "GET", path: "/me" });
      return HttpResponse.json({ user_id: "u1", email: null, anon: true, balance: 2 });
    }),
    http.get(`${BASE}/readings/r3`, () =>
      HttpResponse.json(full(failed, "A quiet morning", { status: status as Reading["status"] })),
    ),
    http.post(`${BASE}/readings/r3/retry`, () => {
      status = "complete";
      return sse([
        frame("cards", { reading_id: "r3", cost: 0, cards: failed.cards }),
        frame("delta", { text: "then light." }),
        frame("done", { reading_id: "r3" }),
      ]);
    }),
  );
  nav.search = "id=r3";
  render(
    <Providers>
      <BalancePill />
      <ReadingPage />
    </Providers>,
  );
  expect(await screen.findByText(/didn't complete/i)).toBeInTheDocument();
  await waitFor(() => expect(count("GET", "/me")).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  await waitFor(() => expect(screen.queryByText(/didn't complete/i)).toBeNull());
  // cards and done each refresh the balance
  await waitFor(() => expect(count("GET", "/me")).toBeGreaterThanOrEqual(2));
});
