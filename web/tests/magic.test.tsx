import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import { Providers as RealProviders } from "@/components/providers";
import MagicPage from "@/app/auth/magic/page";
import { apiBase } from "@/lib/api";

const nav = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/auth/magic/",
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
  nav.replace.mockReset();
  nav.push.mockReset();
  localStorage.clear();
});
afterEach(() => server.resetHandlers());

const EXPIRED = /This link has expired\. Request a new one\./;

test("magic landing verifies with the current bearer and stores the new token", async () => {
  localStorage.setItem("sh.token", "anon1");
  nav.search = "token=m1";
  const seen: { auth: string | null; body: unknown }[] = [];
  server.use(
    http.post(`${BASE}/auth/magic/verify`, async ({ request }) => {
      seen.push({ auth: request.headers.get("authorization"), body: await request.json() });
      return HttpResponse.json({ token: "t9", user_id: "u9" });
    }),
  );
  render(
    <Providers>
      <MagicPage />
    </Providers>,
  );
  expect(screen.getByText(/Signing you in/)).toBeInTheDocument();
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe("t9"));
  expect(seen).toEqual([{ auth: "Bearer anon1", body: { token: "m1" } }]);
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/account/"));
  expect(screen.queryByText(EXPIRED)).toBeNull();
});

test("magic landing mints an anonymous session first when none exists, then links it", async () => {
  nav.search = "token=m2";
  const seen: (string | null)[] = [];
  server.use(
    http.post(`${BASE}/auth/anonymous`, () =>
      HttpResponse.json({ token: "anon-new", user_id: "a" }, { status: 201 }),
    ),
    http.post(`${BASE}/auth/magic/verify`, ({ request }) => {
      seen.push(request.headers.get("authorization"));
      return HttpResponse.json({ token: "t2", user_id: "u2" });
    }),
  );
  render(
    <Providers>
      <MagicPage />
    </Providers>,
  );
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe("t2"));
  expect(seen).toEqual(["Bearer anon-new"]);
});

test("the single-use token is verified once even under StrictMode double effects", async () => {
  localStorage.setItem("sh.token", "anon1");
  nav.search = "token=m3";
  let calls = 0;
  server.use(
    http.post(`${BASE}/auth/magic/verify`, () => {
      calls++;
      return HttpResponse.json({ token: "t3", user_id: "u3" });
    }),
  );
  render(
    <StrictMode>
      <Providers>
        <MagicPage />
      </Providers>
    </StrictMode>,
  );
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/account/"));
  await new Promise((r) => setTimeout(r, 30));
  expect(calls).toBe(1);
});

test("magic landing without token shows expired copy and a link to the account page", async () => {
  localStorage.setItem("sh.token", "anon1");
  render(
    <Providers>
      <MagicPage />
    </Providers>,
  );
  expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /account/i })).toHaveAttribute("href", "/account/");
  expect(nav.replace).not.toHaveBeenCalled();
});

test("an invalid or expired token shows the expired copy and keeps the current session", async () => {
  localStorage.setItem("sh.token", "anon1");
  nav.search = "token=stale";
  server.use(
    http.post(`${BASE}/auth/magic/verify`, () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "Invalid or expired link" } },
        { status: 401 },
      ),
    ),
  );
  render(
    <Providers>
      <MagicPage />
    </Providers>,
  );
  expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /account/i })).toHaveAttribute("href", "/account/");
  // a failed verify must not clear the anonymous session or redirect
  expect(localStorage.getItem("sh.token")).toBe("anon1");
  expect(nav.replace).not.toHaveBeenCalled();
});
