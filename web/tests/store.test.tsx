import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Providers as RealProviders } from "@/components/providers";
import StorePage from "@/app/store/page";
import {
  PURCHASE_FAILED_COPY,
  PURCHASE_POLL_INTERVAL_MS,
  PURCHASE_POLL_MAX_MS,
} from "@/hooks/use-purchase";
import { apiBase } from "@/lib/api";
import { createMockBilling, MOCK_PACKAGES } from "@/billing/mock";
import { selectBillingProvider } from "@/billing";
import {
  creditsFromProductId,
  PurchaseCancelledError,
  PurchasePendingError,
  type BillingProvider,
  type Package,
} from "@/billing/provider";
import type { Me } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/store/",
}));

const BASE = apiBase();
const jwt = (sub: string) => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
};

let qc: QueryClient;
let billing: BillingProvider;
function Providers({ children }: { children: ReactNode }) {
  return (
    <RealProviders queryClient={qc} billing={billing}>
      {children}
    </RealProviders>
  );
}
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

let meCalls = 0;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  billing = createMockBilling();
  meCalls = 0;
  localStorage.clear();
  localStorage.setItem("sh.token", jwt("u1"));
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const me = (over: Partial<Me> = {}): Me => ({ user_id: "u1", email: null, anon: false, balance: 0, ...over });
/** GET /me answering from a script; the last entry repeats forever. */
function meHandler(script: Me[]) {
  return http.get(`${BASE}/me`, () => {
    const i = Math.min(meCalls, script.length - 1);
    meCalls += 1;
    return HttpResponse.json(script[i]);
  });
}

function renderStore() {
  return render(
    <Providers>
      <StorePage />
    </Providers>,
  );
}

const buyButtons = () => screen.getAllByRole("button", { name: /^Buy/ });
/** The first Buy button once packages and `/me` have both loaded. */
async function firstBuy() {
  const [b] = await waitFor(() => buyButtons());
  await waitFor(() => expect(b).toBeEnabled());
  return b;
}

test("packages render titles, credits and prices from the provider", async () => {
  server.use(meHandler([me()]));
  renderStore();
  const cards = await screen.findAllByRole("listitem");
  expect(cards).toHaveLength(MOCK_PACKAGES.length);
  for (const [i, pkg] of MOCK_PACKAGES.entries()) {
    expect(within(cards[i]).getByText(pkg.title)).toBeInTheDocument();
    expect(within(cards[i]).getByText(pkg.priceString)).toBeInTheDocument();
    expect(within(cards[i]).getByText(`${pkg.credits} credits`)).toBeInTheDocument();
    expect(
      within(cards[i]).getByRole("button", {
        name: `Buy ${pkg.title}: ${pkg.credits} credits for ${pkg.priceString}`,
      }),
    ).toBeEnabled();
  }
});

test("billing is configured with the signed-in user id before packages are listed", async () => {
  server.use(meHandler([me()]));
  const configure = vi.spyOn(billing, "configure");
  const packages = vi.spyOn(billing, "packages");
  renderStore();
  await screen.findAllByRole("listitem");
  expect(configure).toHaveBeenCalledTimes(1);
  expect(configure).toHaveBeenCalledWith("u1");
  expect(configure.mock.invocationCallOrder[0]).toBeLessThan(packages.mock.invocationCallOrder[0]);
});

test("anonymous user is asked to sign in before buying", async () => {
  server.use(meHandler([me({ anon: true })]));
  const purchase = vi.spyOn(billing, "purchase");
  renderStore();
  const buy = await firstBuy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(buy);

  const dialog = screen.getByRole("dialog", { name: "Sign in to buy credits" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(purchase).not.toHaveBeenCalled();
  // the heading takes focus so screen readers announce the sheet
  expect(within(dialog).getByRole("heading", { name: "Sign in to buy credits" })).toHaveFocus();
  // no Google client id in tests: the slot says so; the email path is live
  expect(within(dialog).getByText("Google sign-in isn't configured")).toBeInTheDocument();
  expect(within(dialog).getByRole("textbox", { name: /email/i })).toBeEnabled();

  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(purchase).not.toHaveBeenCalled();
});

test("purchase then polls /me until balance rises", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // initial load, fresh baseline, two polls at 0, then the webhook has landed
  server.use(
    meHandler([me({ balance: 0 }), me({ balance: 0 }), me({ balance: 0 }), me({ balance: 0 }), me({ balance: 5 })]),
  );
  const purchase = vi.spyOn(billing, "purchase");
  renderStore();
  const buy = await firstBuy();
  expect(meCalls).toBe(1);

  fireEvent.click(buy);
  await waitFor(() => expect(purchase).toHaveBeenCalledTimes(1));
  expect(purchase.mock.calls[0][0].productId).toBe(MOCK_PACKAGES[0].productId);
  await screen.findByText(/Processing/);
  for (const b of buyButtons()) expect(b).toBeDisabled();
  // fresh baseline before checkout, then a first check right away
  await waitFor(() => expect(meCalls).toBe(3));

  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS + 50));
  await waitFor(() => expect(meCalls).toBe(4));
  expect(screen.getByText(/Processing/)).toBeInTheDocument();

  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS + 50));
  await waitFor(() => expect(meCalls).toBe(5));
  const status = await screen.findByRole("status", { name: "Purchase status" });
  expect(status).toHaveTextContent(/credits are in/i);
  expect(status).toHaveTextContent("5");
  expect(screen.queryByText(/Processing/)).toBeNull();
  for (const b of buyButtons()) expect(b).toBeEnabled();
  // the shared /me cache now carries the new balance
  expect(qc.getQueryData<Me>(["me"])?.balance).toBe(5);

  // no stray polling continues after success
  const before = meCalls;
  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS * 3));
  expect(meCalls).toBe(before);
});

test("slow webhook shows processing note, not an error", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(meHandler([me({ balance: 0 })]));
  renderStore();
  const buy = await firstBuy();
  fireEvent.click(buy);
  await screen.findByText(/Processing/);

  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_MAX_MS + PURCHASE_POLL_INTERVAL_MS));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status", { name: "Purchase status" })).toHaveTextContent(
    "Your purchase is being processed — credits will appear shortly",
  );
  for (const b of buyButtons()) expect(b).toBeEnabled();

  const before = meCalls;
  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS * 3));
  expect(meCalls).toBe(before);
});

test("polling stops when the page unmounts", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  server.use(meHandler([me({ balance: 0 })]));
  const { unmount } = renderStore();
  const buy = await firstBuy();
  fireEvent.click(buy);
  await screen.findByText(/Processing/);
  await waitFor(() => expect(meCalls).toBe(3));
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS * 3));
  expect(meCalls).toBe(3);
});

test("a cancelled purchase re-enables Buy quietly; an SDK failure shows an inline message", async () => {
  server.use(meHandler([me({ balance: 0 })]));
  const purchase = vi
    .spyOn(billing, "purchase")
    .mockRejectedValueOnce(new PurchaseCancelledError())
    .mockRejectedValueOnce(new Error("card declined"));
  renderStore();
  const buy = await firstBuy();

  fireEvent.click(buy);
  await waitFor(() => expect(purchase).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(buy).toBeEnabled());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Processing/)).toBeNull();

  fireEvent.click(buy);
  await waitFor(() => expect(purchase).toHaveBeenCalledTimes(2));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(PURCHASE_FAILED_COPY);
  expect(buy).toBeEnabled();
  // one load plus a fresh baseline per attempt; no polling after a failed checkout
  expect(meCalls).toBe(3);
});

test("a payment the SDK reports as pending enters the processing path, not an error", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // load, baseline, first poll still 0, then credited
  server.use(meHandler([me({ balance: 0 }), me({ balance: 0 }), me({ balance: 0 }), me({ balance: 5 })]));
  vi.spyOn(billing, "purchase").mockRejectedValueOnce(new PurchasePendingError());
  renderStore();
  fireEvent.click(await firstBuy());
  await screen.findByText(/Processing/);
  expect(screen.queryByRole("alert")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS + 50));
  const status = await screen.findByRole("status", { name: "Purchase status" });
  expect(status).toHaveTextContent(/credits are in/i);
  expect(status).toHaveTextContent("5");
});

test("the balance baseline comes from a fresh GET /me, not the cache", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // cached 0 at load; an earlier purchase's credits (5) landed unseen before this buy.
  // Polls: 5 (no change yet) → 10 (this purchase).
  server.use(meHandler([me({ balance: 0 }), me({ balance: 5 }), me({ balance: 5 }), me({ balance: 10 })]));
  renderStore();
  fireEvent.click(await firstBuy());
  await screen.findByText(/Processing/);
  await waitFor(() => expect(meCalls).toBe(3));
  // the first poll returned 5 — above the stale cache, but not above the fresh baseline
  expect(screen.getByText(/Processing/)).toBeInTheDocument();
  expect(screen.queryByText(/credits are in/i)).toBeNull();

  await act(() => vi.advanceTimersByTimeAsync(PURCHASE_POLL_INTERVAL_MS + 50));
  const status = await screen.findByRole("status", { name: "Purchase status" });
  expect(status).toHaveTextContent(/credits are in/i);
  expect(status).toHaveTextContent("10");
  expect(qc.getQueryData<Me>(["me"])?.balance).toBe(10);
});

test("a user whose fresh /me is anonymous gets the sign-in sheet instead of a charge", async () => {
  // cached /me says signed in; the account was deleted/signed out elsewhere before Buy
  server.use(meHandler([me({ anon: false }), me({ anon: true })]));
  const purchase = vi.spyOn(billing, "purchase");
  renderStore();
  fireEvent.click(await firstBuy());
  await screen.findByRole("dialog", { name: "Sign in to buy credits" });
  expect(purchase).not.toHaveBeenCalled();
  expect(screen.queryByText(/Processing/)).toBeNull();
});

test("a double click starts one purchase", async () => {
  server.use(meHandler([me({ balance: 0 })]));
  let release: () => void = () => {};
  const purchase = vi.spyOn(billing, "purchase").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ transactionId: "mock-1" });
      }),
  );
  renderStore();
  const buy = await firstBuy();
  fireEvent.click(buy);
  fireEvent.click(buy);
  fireEvent.click(buy);
  await waitFor(() => expect(purchase).toHaveBeenCalledTimes(1));
  // baseline fetch has resolved; still only one checkout
  await waitFor(() => expect(meCalls).toBe(2));
  expect(purchase).toHaveBeenCalledTimes(1);
  release();
  await screen.findByText(/Processing/);
});

test("packages that fail to load offer a retry", async () => {
  server.use(meHandler([me()]));
  vi.spyOn(billing, "packages")
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(MOCK_PACKAGES.slice(0, 1));
  renderStore();
  const alert = await screen.findByRole("alert");
  fireEvent.click(within(alert).getByRole("button", { name: /retry/i }));
  expect(await screen.findAllByRole("listitem")).toHaveLength(1);
});

test("credits are parsed from the product id suffix", () => {
  expect(creditsFromProductId("sh_credits_5")).toBe(5);
  expect(creditsFromProductId("sh_credits_40")).toBe(40);
  expect(creditsFromProductId("sh_credits_")).toBeNull();
  expect(creditsFromProductId("sh_credits_abc")).toBeNull();
  expect(creditsFromProductId("premium_monthly")).toBeNull();
  expect(creditsFromProductId("sh_credits_0")).toBeNull();
});

test("selectBillingProvider honours NEXT_PUBLIC_BILLING and falls back on the RC key", () => {
  expect(selectBillingProvider({}).kind).toBe("mock");
  expect(selectBillingProvider({ NEXT_PUBLIC_RC_WEB_KEY: "rcb_x" }).kind).toBe("revenuecat");
  expect(selectBillingProvider({ NEXT_PUBLIC_BILLING: "mock", NEXT_PUBLIC_RC_WEB_KEY: "rcb_x" }).kind).toBe("mock");
  expect(selectBillingProvider({ NEXT_PUBLIC_BILLING: "revenuecat", NEXT_PUBLIC_RC_WEB_KEY: "rcb_x" }).kind).toBe(
    "revenuecat",
  );
  // asking for RevenueCat without a key cannot work; fall back (loudly) rather than crash at import time
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(selectBillingProvider({ NEXT_PUBLIC_BILLING: "revenuecat" }).kind).toBe("mock");
  expect(err).toHaveBeenCalledTimes(1);
  expect(err.mock.calls[0][0]).toMatch(/NEXT_PUBLIC_RC_WEB_KEY/);
  expect(selectBillingProvider({ NEXT_PUBLIC_BILLING: "bogus", NEXT_PUBLIC_RC_WEB_KEY: "rcb_x" }).kind).toBe(
    "revenuecat",
  );
});

test("mock provider lists 5/15/40 and resolves purchases with a transaction id", async () => {
  const p = createMockBilling();
  await p.configure("u1");
  const pk: Package[] = await p.packages();
  expect(pk.map((x) => x.credits)).toEqual([5, 15, 40]);
  const r = await p.purchase(pk[1]);
  expect(r.transactionId).toMatch(/^mock-/);
});
