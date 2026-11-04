import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import ChartPage from "@/app/chart/page";
import { apiBase } from "@/lib/api";
import { fixtureChart } from "./helpers/chart";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/chart/",
}));

const BASE = apiBase();
let qc: QueryClient;
function Providers({ children }: { children: ReactNode }) {
  return <RealProviders queryClient={qc}>{children}</RealProviders>;
}
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  nav.search = "";
  localStorage.clear();
  localStorage.setItem("sh.token", "tok");
});
afterEach(() => server.resetHandlers());

const ada = {
  id: "p1", name: "Ada", birth_date: "1990-05-15", birth_time: "09:15", tz: "America/New_York",
  lat: 42.3, lon: -70.91, place_label: "Hull, MA, USA", time_known: true, created_at: "x",
};
const bob = { ...ada, id: "p2", name: "Bob", birth_time: null, time_known: false, place_label: "Boston, MA, USA",
  birth_date: "1985-12-01" };

function setup() {
  render(
    <Providers>
      <ChartPage />
    </Providers>,
  );
}

test("without ?id= lists profiles with name, place, and date, plus a New chart button", async () => {
  server.use(http.get(`${BASE}/profiles`, () => HttpResponse.json({ profiles: [ada, bob] })));
  setup();
  const adaLink = await screen.findByRole("link", { name: /Ada/ });
  expect(adaLink).toHaveAttribute("href", "/chart/?id=p1");
  expect(adaLink).toHaveTextContent("Hull, MA, USA");
  expect(adaLink).toHaveTextContent(/1990/);
  expect(screen.getByRole("link", { name: /Bob/ })).toHaveAttribute("href", "/chart/?id=p2");
  expect(screen.getByRole("link", { name: "New chart" })).toHaveAttribute("href", "/chart/new/");
});

test("empty list shows an explanation of why a chart helps", async () => {
  server.use(http.get(`${BASE}/profiles`, () => HttpResponse.json({ profiles: [] })));
  setup();
  expect(await screen.findByText(/no charts yet/i)).toBeInTheDocument();
  expect(screen.getByText(/lets your readings speak to your own sky/i)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "New chart" })).toHaveAttribute("href", "/chart/new/");
});

test("?id= fetches the profile and renders wheel, placements, and the readings link", async () => {
  nav.search = "id=p1";
  const chart = fixtureChart({ sun: 54.3, ascendant: 110 });
  let listCalls = 0;
  server.use(
    http.get(`${BASE}/profiles/p1`, () => HttpResponse.json({ profile: ada, chart })),
    http.get(`${BASE}/profiles`, () => {
      listCalls++;
      return HttpResponse.json({ profiles: [ada] });
    }),
  );
  setup();
  expect(await screen.findByRole("heading", { name: "Ada" })).toBeInTheDocument();
  expect(screen.getByText(/Hull, MA, USA/)).toBeInTheDocument();
  expect(screen.getByRole("img", { name: /Sun in Taurus/ })).toBeInTheDocument();
  // the wheel's SVG <title> tooltips also carry this text; assert on the placements list
  expect(screen.getByText(/Sun in Taurus 24°/, { ignore: "svg *" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Use for readings/ })).toHaveAttribute(
    "href",
    "/reading/new/?profile=p1",
  );
  expect(listCalls).toBe(0);
});

test("?id= for a profile without a chart explains and still offers readings", async () => {
  nav.search = "id=p2";
  server.use(http.get(`${BASE}/profiles/p2`, () => HttpResponse.json({ profile: bob, chart: null })));
  setup();
  expect(await screen.findByRole("heading", { name: "Bob" })).toBeInTheDocument();
  expect(screen.getByText(/chart isn't available/i)).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
});

test("?id= for an unknown profile shows not found and a way back", async () => {
  nav.search = "id=nope";
  server.use(
    http.get(`${BASE}/profiles/nope`, () =>
      HttpResponse.json({ error: { code: "not_found", message: "no" } }, { status: 404 }),
    ),
  );
  setup();
  expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't find that chart/i);
  expect(screen.getByRole("link", { name: /all charts/i })).toHaveAttribute("href", "/chart/");
});

test("list fetch failure shows an error, not a dead screen", async () => {
  server.use(
    http.get(`${BASE}/profiles`, () =>
      HttpResponse.json({ error: { code: "boom", message: "x" } }, { status: 500 }),
    ),
  );
  setup();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load your charts/i));
});
