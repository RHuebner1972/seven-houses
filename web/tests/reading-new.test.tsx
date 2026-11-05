import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import ReadingNewPage from "@/app/reading/new/page";
import { BalancePill } from "@/components/balance-pill";
import { apiBase } from "@/lib/api";
import type { Profile, Spread } from "@/lib/types";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/reading/new/",
}));

const BASE = apiBase();
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

const motion = vi.hoisted(() => ({ reduced: false }));

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  log = [];
  nav.search = "";
  motion.reduced = false;
  localStorage.clear();
  localStorage.setItem("sh.token", "tok");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q.includes("reduce") && motion.reduced,
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function sse(frames: string[], { close = true } = {}) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      if (close) c.close();
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
const CELTIC_IDS = [
  "major-00-fool", "major-01-magician", "major-02-high-priestess", "major-03-empress", "major-04-emperor",
  "major-05-hierophant", "major-06-lovers", "major-07-chariot", "major-08-strength", "major-09-hermit",
];
const celticCards = () =>
  SPREADS[2].positions.map((p, i) => ({ position: p.key, card_id: CELTIC_IDS[i], reversed: i === 1 }));
const threeCards = () =>
  SPREADS[1].positions.map((p, i) => ({ position: p.key, card_id: CELTIC_IDS[i], reversed: false }));

const ada: Profile = {
  id: "p1", name: "Ada", birth_date: "1990-05-15", birth_time: "09:15", tz: "America/New_York",
  lat: 42.3, lon: -70.91, place_label: "Hull, MA, USA", time_known: true, created_at: "x",
};
const bob: Profile = { ...ada, id: "p2", name: "Bob" };

function baseHandlers({ profiles = [ada], balance = 3 }: { profiles?: Profile[]; balance?: number } = {}) {
  return [
    http.get(`${BASE}/spreads`, () => HttpResponse.json(SPREADS)),
    http.get(`${BASE}/profiles`, () => HttpResponse.json({ profiles })),
    http.get(`${BASE}/me`, () => {
      log.push({ method: "GET", path: "/me" });
      return HttpResponse.json({ user_id: "u1", email: null, anon: true, balance });
    }),
  ];
}

function onReadings(resolver: (body: unknown) => Response | Promise<Response>) {
  return http.post(`${BASE}/readings`, async ({ request }) => {
    const body = await request.json();
    log.push({ method: "POST", path: "/readings", body });
    return resolver(body);
  });
}

function setup() {
  return render(
    <Providers>
      <ReadingNewPage />
    </Providers>,
  );
}

const begin = async () => fireEvent.click(await screen.findByRole("button", { name: /begin/i }));
const faceUp = (name: string) => screen.queryByRole("img", { name }) !== null;

test("lists spreads with live costs and starts a chart-informed reading", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(
    ...baseHandlers(),
    onReadings(() =>
      sse([
        frame("cards", { reading_id: "r1", cost: 3, cards: celticCards() }),
        frame("delta", { text: "The cross speaks." }),
        frame("done", { reading_id: "r1" }),
      ]),
    ),
  );
  setup();

  // the daily spread is never offered
  const three = await screen.findByRole("radio", { name: /Three Card/ });
  expect(screen.queryByRole("radio", { name: /Card of the Day/ })).toBeNull();
  expect(three).toBeChecked();
  expect(screen.getByText("1 credit · 3 cards")).toBeInTheDocument();
  const celtic = screen.getByRole("radio", { name: /Celtic Cross/ });
  expect(screen.getByText("3 credits · 10 cards")).toBeInTheDocument();
  fireEvent.click(celtic);
  expect(await screen.findByText(/Costs 3 credits · you have 3/)).toBeInTheDocument();

  const toggle = await screen.findByRole("switch", { name: /read through my chart/i });
  expect(toggle).toBeChecked();
  expect(screen.getByText(/Ada/)).toBeInTheDocument();

  fireEvent.change(screen.getByRole("textbox", { name: /question/i }), {
    target: { value: "Should I take the job?" },
  });
  await begin();

  await waitFor(() => expect(count("POST", "/readings")).toBe(1));
  expect(log.find((l) => l.path === "/readings")!.body).toEqual({
    spread_type: "celtic_cross",
    question: "Should I take the job?",
    profile_id: "p1",
  });

  // ten labeled slots, in the Celtic Cross arrangement
  for (const p of SPREADS[2].positions) {
    expect(await screen.findByRole("group", { name: p.name })).toBeInTheDocument();
    expect(screen.getByText(p.name, { selector: "figcaption, figcaption *" })).toBeInTheDocument();
  }
  const challenge = screen.getByRole("group", { name: "Challenge" });
  expect(challenge.closest("[data-crossing]")).not.toBeNull();

  // cards reveal one every 600 ms
  expect(await screen.findByText(/The cross speaks/)).toBeInTheDocument();
  await waitFor(() => expect(faceUp("The Fool, upright")).toBe(true));
  expect(faceUp("The Magician, reversed")).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(faceUp("The Magician, reversed")).toBe(true);
  expect(faceUp("The Hermit, upright")).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(600 * 8));
  expect(faceUp("The Hermit, upright")).toBe(true);

  expect(await screen.findByText(/saved to your journal/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /journal/i })).toHaveAttribute("href", "/journal/");
  // balance is re-read from the server, never computed locally
  await waitFor(() => expect(count("GET", "/me")).toBeGreaterThanOrEqual(2));
});

test("reduced motion reveals every card at once", async () => {
  motion.reduced = true;
  server.use(
    ...baseHandlers(),
    onReadings(() =>
      sse([
        frame("cards", { reading_id: "r1", cost: 1, cards: threeCards() }),
        frame("delta", { text: "Quick." }),
        frame("done", { reading_id: "r1" }),
      ]),
    ),
  );
  setup();
  await begin();
  await waitFor(() => expect(faceUp("The Fool, upright")).toBe(true));
  expect(faceUp("The Magician, upright")).toBe(true);
  expect(faceUp("The High Priestess, upright")).toBe(true);
});

test("toggle off omits profile_id; blank question is omitted; ?profile= picks the profile", async () => {
  nav.search = "profile=p2";
  server.use(
    ...baseHandlers({ profiles: [ada, bob] }),
    onReadings(() =>
      sse([
        frame("cards", { reading_id: "r2", cost: 1, cards: threeCards() }),
        frame("done", { reading_id: "r2" }),
      ]),
    ),
  );
  setup();
  const toggle = await screen.findByRole("switch", { name: /read through my chart/i });
  expect(toggle).toBeChecked();
  expect(screen.getByRole("combobox", { name: /chart/i })).toHaveValue("p2");
  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  await begin();
  await waitFor(() => expect(count("POST", "/readings")).toBe(1));
  expect(log.find((l) => l.path === "/readings")!.body).toEqual({ spread_type: "three_card" });
});

test("without profiles the chart toggle is absent and profile_id is omitted", async () => {
  server.use(
    ...baseHandlers({ profiles: [] }),
    onReadings(() =>
      sse([frame("cards", { reading_id: "r3", cost: 1, cards: threeCards() }), frame("done", { reading_id: "r3" })]),
    ),
  );
  setup();
  await screen.findByRole("radio", { name: /Three Card/ });
  await waitFor(() => expect(qc.getQueryState(["profiles"])?.status).toBe("success"));
  expect(screen.queryByRole("switch")).toBeNull();
  await begin();
  await waitFor(() => expect(count("POST", "/readings")).toBe(1));
  expect(log.find((l) => l.path === "/readings")!.body).toEqual({ spread_type: "three_card" });
});

test("402 shows the store prompt instead of a stream", async () => {
  server.use(
    ...baseHandlers({ balance: 1 }),
    onReadings(() =>
      HttpResponse.json({ error: { code: "insufficient_credits", message: "no" } }, { status: 402 }),
    ),
  );
  setup();
  fireEvent.click(await screen.findByRole("radio", { name: /Celtic Cross/ }));
  await begin();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/you need 3 credits/i);
  expect(within(alert).getByRole("link", { name: /store/i })).toHaveAttribute("href", "/store/");
  expect(document.querySelector("[data-streaming]")).toBeNull();
  // the form stays usable
  expect(screen.getByRole("button", { name: /begin/i })).toBeEnabled();
  expect(screen.getByRole("radio", { name: /Celtic Cross/ })).toBeChecked();
});

test("429 asks the user to wait and keeps the form", async () => {
  server.use(
    ...baseHandlers(),
    onReadings(() => HttpResponse.json({ error: { code: "rate_limited", message: "slow" } }, { status: 429 })),
  );
  setup();
  await begin();
  expect(await screen.findByRole("alert")).toHaveTextContent(/please wait a little before another reading/i);
  expect(document.querySelector("[data-streaming]")).toBeNull();
  expect(screen.getByRole("button", { name: /begin/i })).toBeEnabled();
});

test("error event offers retry which calls /readings/{id}/retry", async () => {
  motion.reduced = true;
  server.use(
    ...baseHandlers(),
    onReadings(() =>
      sse([
        frame("cards", { reading_id: "r7", cost: 1, cards: threeCards() }),
        frame("delta", { text: "Half" }),
        frame("error", { code: "generation_failed", message: "The stars went quiet." }),
      ]),
    ),
    http.post(`${BASE}/readings/r7/retry`, () => {
      log.push({ method: "POST", path: "/readings/r7/retry" });
      return sse([
        frame("cards", { reading_id: "r7", cost: 1, cards: threeCards() }),
        frame("delta", { text: "Whole again." }),
        frame("done", { reading_id: "r7" }),
      ]);
    }),
  );
  setup();
  await begin();
  expect(await screen.findByText("The stars went quiet.")).toBeInTheDocument();
  await waitFor(() => expect(faceUp("The Fool, upright")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  expect(await screen.findByText("Whole again.")).toBeInTheDocument();
  expect(screen.queryByText("Half")).toBeNull();
  expect(count("POST", "/readings")).toBe(1);
  expect(count("POST", "/readings/r7/retry")).toBe(1);
  // the same cards stay revealed across the retry
  expect(faceUp("The Fool, upright")).toBe(true);
  expect(await screen.findByText(/saved to your journal/i)).toBeInTheDocument();
});

test("unmount mid-stream aborts the request and toasts that the reading is being saved", async () => {
  const abort = vi.spyOn(AbortController.prototype, "abort");
  let req: Request | undefined;
  server.use(
    ...baseHandlers(),
    http.post(`${BASE}/readings`, ({ request }) => {
      req = request;
      return sse([frame("cards", { reading_id: "r8", cost: 1, cards: threeCards() }), frame("delta", { text: "Midway" })], {
        close: false,
      });
    }),
  );
  const { rerender } = render(
    <Providers>
      <ReadingNewPage />
    </Providers>,
  );
  await begin();
  expect(await screen.findByText(/Midway/)).toBeInTheDocument();
  expect(document.querySelector("[data-streaming]")).toHaveAttribute("data-streaming", "true");
  abort.mockClear();
  rerender(<Providers>{null}</Providers>);
  expect(abort).toHaveBeenCalled();
  await waitFor(() => expect(req?.signal.aborted).toBe(true));
  expect(screen.getByRole("status")).toHaveTextContent(/your reading is being saved to your journal/i);
});

test("unmount before any text arrives aborts silently", async () => {
  server.use(
    ...baseHandlers(),
    http.post(`${BASE}/readings`, () =>
      sse([frame("cards", { reading_id: "r8", cost: 1, cards: threeCards() })], { close: false }),
    ),
  );
  const { rerender } = render(
    <Providers>
      <ReadingNewPage />
    </Providers>,
  );
  await begin();
  await screen.findByRole("group", { name: "Past" });
  await waitFor(() =>
    expect(document.querySelector("[data-streaming]")).toHaveAttribute("data-streaming", "true"),
  );
  rerender(<Providers>{null}</Providers>);
  expect(screen.queryByText(/being saved/i)).toBeNull();
});

test("question is capped at 500 characters", async () => {
  server.use(...baseHandlers());
  setup();
  const box = await screen.findByRole("textbox", { name: /question/i });
  expect(box).toHaveAttribute("maxlength", "500");
  fireEvent.change(box, { target: { value: "a".repeat(120) } });
  expect(screen.getByText("120 / 500")).toBeInTheDocument();
});

test("an error event re-reads the balance (the server refunds the spread)", async () => {
  server.use(
    ...baseHandlers(),
    onReadings(() => sse([frame("error", { code: "generation_failed", message: "The stars went quiet." })])),
  );
  setup();
  await screen.findByRole("radio", { name: /Three Card/ });
  await waitFor(() => expect(count("GET", "/me")).toBe(1));
  await begin();
  expect(await screen.findByText("The stars went quiet.")).toBeInTheDocument();
  await waitFor(() => expect(count("GET", "/me")).toBe(2));
});

test("leaving mid-stream re-reads the balance once the stream is abandoned", async () => {
  server.use(
    ...baseHandlers(),
    http.post(`${BASE}/readings`, () => sse([frame("delta", { text: "Midway" })], { close: false })),
  );
  const { rerender } = render(
    <Providers>
      <BalancePill />
      <ReadingNewPage />
    </Providers>,
  );
  await begin();
  expect(await screen.findByText(/Midway/)).toBeInTheDocument();
  await waitFor(() => expect(count("GET", "/me")).toBe(1));
  rerender(
    <Providers>
      <BalancePill />
    </Providers>,
  );
  await waitFor(() => expect(count("GET", "/me")).toBe(2));
});
