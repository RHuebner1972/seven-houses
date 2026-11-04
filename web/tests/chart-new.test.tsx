import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import NewChartPage from "@/app/chart/new/page";
import { apiBase } from "@/lib/api";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const BASE = apiBase();
let qc: QueryClient;
function Providers({ children }: { children: ReactNode }) {
  return <RealProviders queryClient={qc}>{children}</RealProviders>;
}
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const HULL = { label: "Hull, MA, USA", lat: 42.3, lon: -70.91, tz: "America/New_York" };
let geoQueries: string[] = [];
let posts: unknown[] = [];

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  geoQueries = [];
  posts = [];
  push.mockClear();
  localStorage.clear();
  localStorage.setItem("sh.token", "tok");
});
afterEach(() => server.resetHandlers());

function geo(resolver?: (q: string) => Response | Promise<Response>) {
  return http.get(`${BASE}/geocode`, ({ request }) => {
    const q = new URL(request.url).searchParams.get("q")!;
    geoQueries.push(q);
    return resolver ? resolver(q) : HttpResponse.json([HULL]);
  });
}
const profileResp = {
  profile: { id: "p1", name: "Ada", birth_date: "1990-05-15", birth_time: "09:15", tz: HULL.tz,
    lat: HULL.lat, lon: HULL.lon, place_label: HULL.label, time_known: true, created_at: "x" },
  chart: null,
};
function createOk(status = 201, body: typeof profileResp = profileResp) {
  return http.post(`${BASE}/profiles`, async ({ request }) => {
    posts.push(await request.json());
    return HttpResponse.json(body, { status });
  });
}

function setup() {
  const user = userEvent.setup();
  render(
    <Providers>
      <NewChartPage />
    </Providers>,
  );
  return user;
}
const submitBtn = () => screen.getByRole("button", { name: /cast my chart|casting/i });

async function fillBasics(user: ReturnType<typeof userEvent.setup>, withTime = true) {
  await user.type(screen.getByLabelText("Name"), "Ada");
  await user.type(screen.getByLabelText("Birth date"), "1990-05-15");
  if (withTime) await user.type(screen.getByLabelText("Birth time"), "09:15");
}
async function pickHull(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("combobox", { name: "Birth place" }), "Hull");
  await user.click(await screen.findByRole("option", { name: HULL.label }));
}

test("searching a place and submitting creates a profile", async () => {
  server.use(geo(), createOk());
  const user = setup();
  expect(screen.getByRole("heading", { name: "Your birth chart" })).toBeInTheDocument();
  await fillBasics(user);
  await pickHull(user);
  expect(screen.getByText("Time zone: America/New_York")).toBeInTheDocument();
  await user.click(submitBtn());
  await waitFor(() => expect(push).toHaveBeenCalledWith("/chart/?id=p1"));
  expect(posts).toEqual([
    { name: "Ada", birth_date: "1990-05-15", birth_time: "09:15", tz: "America/New_York",
      lat: 42.3, lon: -70.91, place_label: "Hull, MA, USA" },
  ]);
});

test("unknown birth time submits null and disables the time input", async () => {
  server.use(geo(), createOk());
  const user = setup();
  await fillBasics(user);
  await user.click(screen.getByLabelText(/don't know my birth time/i));
  const time = screen.getByLabelText("Birth time");
  expect(time).toBeDisabled();
  expect(time).toHaveValue("");
  await pickHull(user);
  await user.click(submitBtn());
  await waitFor(() => expect(posts).toHaveLength(1));
  expect((posts[0] as { birth_time: unknown }).birth_time).toBeNull();
});

test("422 from the API is shown inline", async () => {
  server.use(
    geo(),
    http.post(`${BASE}/profiles`, () =>
      HttpResponse.json({ error: { code: "validation", message: "birth_date: too early" } }, { status: 422 }),
    ),
  );
  const user = setup();
  await fillBasics(user);
  await pickHull(user);
  await user.click(submitBtn());
  expect(await screen.findByRole("alert")).toHaveTextContent("birth_date: too early");
  expect(push).not.toHaveBeenCalled();
});

test("other errors show a generic message", async () => {
  server.use(
    geo(),
    http.post(`${BASE}/profiles`, () =>
      HttpResponse.json({ error: { code: "boom", message: "internal detail" } }, { status: 500 }),
    ),
  );
  const user = setup();
  await fillBasics(user);
  await pickHull(user);
  await user.click(submitBtn());
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/something went wrong/i);
  expect(alert).not.toHaveTextContent("internal detail");
});

test("submit is disabled until a place is chosen", async () => {
  server.use(geo(), createOk());
  const user = setup();
  await fillBasics(user);
  expect(submitBtn()).toBeDisabled();
  await pickHull(user);
  expect(submitBtn()).toBeEnabled();
  // editing the place text invalidates the selection
  await user.type(screen.getByRole("combobox", { name: "Birth place" }), "x");
  expect(submitBtn()).toBeDisabled();
  expect(screen.queryByText(/Time zone:/)).toBeNull();
});

test("button shows pending state while casting", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.use(
    geo(),
    http.post(`${BASE}/profiles`, async () => {
      await gate;
      return HttpResponse.json(profileResp, { status: 201 });
    }),
  );
  const user = setup();
  await fillBasics(user);
  await pickHull(user);
  await user.click(submitBtn());
  const btn = await screen.findByRole("button", { name: "Casting your chart…" });
  expect(btn).toBeDisabled();
  release();
  await waitFor(() => expect(push).toHaveBeenCalled());
});

test("typing quickly debounces to a single request", async () => {
  server.use(geo());
  const user = setup();
  const input = screen.getByRole("combobox", { name: "Birth place" });
  await user.type(input, "Hu");
  await user.type(input, "ll");
  await screen.findByRole("option", { name: HULL.label });
  expect(geoQueries).toEqual(["Hull"]);
});

test("does not search for fewer than 2 characters", async () => {
  server.use(geo());
  const user = setup();
  await user.type(screen.getByRole("combobox", { name: "Birth place" }), "H");
  await new Promise((r) => setTimeout(r, 450));
  expect(geoQueries).toEqual([]);
});

test("a stale response is ignored", async () => {
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((r) => (releaseOld = r));
  server.use(
    geo(async (q) => {
      if (q === "Hu") {
        await oldGate;
        return HttpResponse.json([{ ...HULL, label: "Stale, XX" }]);
      }
      return HttpResponse.json([HULL]);
    }),
  );
  const user = setup();
  const input = screen.getByRole("combobox", { name: "Birth place" });
  await user.type(input, "Hu");
  await waitFor(() => expect(geoQueries).toEqual(["Hu"]));
  await user.type(input, "ll");
  await screen.findByRole("option", { name: HULL.label });
  releaseOld();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByRole("option", { name: "Stale, XX" })).toBeNull();
  expect(screen.getByRole("option", { name: HULL.label })).toBeInTheDocument();
});

test("keyboard: ArrowDown + Enter selects a result; whole form is keyboard operable", async () => {
  server.use(geo(), createOk());
  const user = setup();
  await user.type(screen.getByLabelText("Name"), "Ada");
  await user.tab();
  await user.keyboard("1990-05-15");
  await user.tab();
  await user.keyboard("0915");
  await user.tab(); // checkbox
  await user.tab(); // place
  const input = screen.getByRole("combobox", { name: "Birth place" });
  expect(input).toHaveFocus();
  await user.keyboard("Hull");
  await screen.findByRole("option", { name: HULL.label });
  expect(input).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{ArrowDown}");
  const opt = screen.getByRole("option", { name: HULL.label });
  expect(input).toHaveAttribute("aria-activedescendant", opt.id);
  await user.keyboard("{Enter}");
  expect(input).toHaveValue(HULL.label);
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("Time zone: America/New_York")).toBeInTheDocument();
  expect(push).not.toHaveBeenCalled(); // Enter chose the option, did not submit
  await user.tab();
  expect(submitBtn()).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(push).toHaveBeenCalledWith("/chart/?id=p1"));
});

test("Escape closes the list", async () => {
  server.use(geo());
  const user = setup();
  const input = screen.getByRole("combobox", { name: "Birth place" });
  await user.type(input, "Hull");
  await screen.findByRole("option", { name: HULL.label });
  await user.keyboard("{Escape}");
  expect(input).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("option")).toBeNull();
});

test("503 geocode_unavailable shows an inline message", async () => {
  server.use(
    geo(() =>
      HttpResponse.json({ error: { code: "geocode_unavailable", message: "down" } }, { status: 503 }),
    ),
  );
  const user = setup();
  await user.type(screen.getByRole("combobox", { name: "Birth place" }), "Hull");
  expect(await screen.findByText("Place lookup is temporarily unavailable")).toBeInTheDocument();
});

test("backspacing below 2 characters hides the stale list", async () => {
  server.use(geo());
  const user = setup();
  const input = screen.getByRole("combobox", { name: "Birth place" });
  await user.type(input, "Hull");
  await screen.findByRole("option", { name: HULL.label });
  await user.keyboard("{Backspace}{Backspace}{Backspace}");
  expect(input).toHaveValue("H");
  expect(screen.queryByRole("option")).toBeNull();
  expect(input).toHaveAttribute("aria-expanded", "false");
});

test("blur closes the list", async () => {
  server.use(geo());
  const user = setup();
  const input = screen.getByRole("combobox", { name: "Birth place" });
  await user.type(input, "Hull");
  await screen.findByRole("option", { name: HULL.label });
  await user.tab();
  expect(screen.queryByRole("option")).toBeNull();
});

test("date input has min and a max of today's local date after mount", () => {
  server.use(geo());
  setup();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const el = screen.getByLabelText("Birth date");
  expect(el).toHaveAttribute("min", "1850-01-01");
  expect(el).toHaveAttribute("max", `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
});

test("submit stays disabled after success so a second click cannot duplicate", async () => {
  server.use(geo(), createOk());
  const user = setup();
  await fillBasics(user);
  await pickHull(user);
  await user.click(submitBtn());
  await waitFor(() => expect(push).toHaveBeenCalled());
  expect(submitBtn()).toBeDisabled();
  expect(posts).toHaveLength(1);
});
