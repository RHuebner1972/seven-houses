import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { QueryClient } from "@tanstack/react-query";
import { Providers as RealProviders } from "@/components/providers";
import AccountPage from "@/app/account/page";
import { apiBase } from "@/lib/api";
import type { Me, Profile } from "@/lib/types";

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/account/",
}));

const BASE = apiBase();
const jwt = (sub: string) => {
  const b64 = (o: unknown) =>
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

let meCalls = 0;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  meCalls = 0;
  nav.replace.mockReset();
  nav.push.mockReset();
  localStorage.clear();
  localStorage.setItem("sh.token", jwt("u1"));
  delete (window as { google?: unknown }).google;
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const anon: Me = { user_id: "u1", email: null, anon: true, balance: 0 };
const signedIn: Me = { user_id: "u1", email: "ada@example.com", anon: false, balance: 3 };
const ada: Profile = {
  id: "p1", name: "Ada", birth_date: "1990-05-15", birth_time: "09:15", tz: "America/New_York",
  lat: 42.3, lon: -70.91, place_label: "Hull, MA, USA", time_known: true, created_at: "x",
};
const bob: Profile = { ...ada, id: "p2", name: "Bob", place_label: "Boston, MA, USA" };

/** GET /me answering from a script; the last entry repeats forever. */
function meHandler(script: Me[]) {
  return http.get(`${BASE}/me`, () => {
    const i = Math.min(meCalls, script.length - 1);
    meCalls += 1;
    return HttpResponse.json(script[i]);
  });
}
const profilesHandler = (list: () => Profile[]) =>
  http.get(`${BASE}/profiles`, () => HttpResponse.json({ profiles: list() }));

function renderAccount() {
  return render(
    <Providers>
      <AccountPage />
    </Providers>,
  );
}

async function openSheet() {
  const opener = await screen.findByRole("button", { name: "Sign in" });
  opener.focus(); // a real click focuses the button first; jsdom's fireEvent does not
  fireEvent.click(opener);
  return screen.getByRole("dialog");
}

test("anonymous user sees the nudge and can open the sign-in sheet", async () => {
  server.use(meHandler([anon]), profilesHandler(() => []));
  renderAccount();
  expect(
    await screen.findByText("Anonymous — sign in to keep your readings across devices"),
  ).toBeInTheDocument();
  // an anonymous session can still be reset, behind a confirmation
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  const dialog = await openSheet();
  expect(dialog).toHaveAttribute("aria-modal", "true");
  // no NEXT_PUBLIC_GOOGLE_CLIENT_ID in tests: the Google slot explains itself instead of failing silently
  expect(within(dialog).getByText("Google sign-in isn't configured")).toBeInTheDocument();
  expect(within(dialog).getByRole("textbox", { name: /email/i })).toBeEnabled();
});

test("sheet closes on backdrop click and traps Tab inside", async () => {
  server.use(meHandler([anon]), profilesHandler(() => []));
  renderAccount();
  const dialog = await openSheet();
  const user = userEvent.setup();
  expect(within(dialog).getByRole("heading")).toHaveFocus();
  // shift+Tab from the heading wraps to the last control; Tab from the last wraps to the first
  await user.tab({ shift: true });
  const last = within(dialog).getByRole("button", { name: /email me a link/i });
  expect(last).toHaveFocus();
  await user.tab();
  expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(last).toHaveFocus();

  // clicking inside does nothing; clicking the backdrop closes
  fireEvent.click(dialog);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  fireEvent.click(dialog.parentElement as HTMLElement);
  expect(screen.queryByRole("dialog")).toBeNull();
  // focus returns to the opener
  expect(screen.getByRole("button", { name: "Sign in" })).toHaveFocus();
});

test("signed-in user sees their email and signs out directly into a fresh anonymous session", async () => {
  let minted = 0;
  server.use(
    meHandler([signedIn, anon]),
    profilesHandler(() => []),
    http.post(`${BASE}/auth/anonymous`, () => {
      minted++;
      return HttpResponse.json({ token: jwt("anon2"), user_id: "anon2" }, { status: 201 });
    }),
  );
  renderAccount();
  expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(minted).toBe(1));
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe(jwt("anon2")));
  expect(await screen.findByText(/Anonymous — sign in/)).toBeInTheDocument();
  expect(await screen.findByText("Signed out")).toBeInTheDocument();
});

test("an anonymous sign-out warns about losing data and can be cancelled", async () => {
  let minted = 0;
  server.use(
    meHandler([anon]),
    profilesHandler(() => []),
    http.post(`${BASE}/auth/anonymous`, () => {
      minted++;
      return HttpResponse.json({ token: jwt("anon2"), user_id: "anon2" }, { status: 201 });
    }),
  );
  renderAccount();
  await screen.findByText(/Anonymous — sign in/);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  const confirm = screen.getByRole("alertdialog");
  expect(confirm).toHaveTextContent(/lose/i);
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(minted).toBe(0);
  expect(localStorage.getItem("sh.token")).toBe(jwt("u1"));

  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /sign out anyway/i }));
  await waitFor(() => expect(minted).toBe(1));
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe(jwt("anon2")));
});

test("profiles are listed and deleted after an inline confirmation", async () => {
  let list = [ada, bob];
  let deleted: string[] = [];
  server.use(
    meHandler([signedIn]),
    profilesHandler(() => list),
    http.delete(`${BASE}/profiles/:id`, ({ params }) => {
      deleted.push(params.id as string);
      list = list.filter((p) => p.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderAccount();
  const items = await screen.findAllByRole("listitem");
  expect(items).toHaveLength(2);
  expect(items[0]).toHaveTextContent("Ada");
  expect(items[0]).toHaveTextContent("Hull, MA, USA");

  fireEvent.click(within(items[0]).getByRole("button", { name: "Delete Ada" }));
  expect(screen.getByText("Delete Ada?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Delete Ada?")).toBeNull();
  expect(deleted).toEqual([]);

  fireEvent.click(within(items[0]).getByRole("button", { name: "Delete Ada" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(deleted).toEqual(["p1"]));
  await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  expect(screen.getByRole("listitem")).toHaveTextContent("Bob");
  deleted = [];
});

test("requesting a magic link shows check-your-email on 202 and a wait message on 429", async () => {
  const bodies: unknown[] = [];
  let status = 202;
  server.use(
    meHandler([anon]),
    profilesHandler(() => []),
    http.post(`${BASE}/auth/magic/request`, async ({ request }) => {
      bodies.push(await request.json());
      if (status === 429)
        return HttpResponse.json(
          { error: { code: "rate_limited", message: "slow down" } },
          { status: 429 },
        );
      if (status === 404)
        return HttpResponse.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      return HttpResponse.json({}, { status: 202 });
    }),
  );
  renderAccount();

  // 202 → check your email
  let dialog = await openSheet();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /email/i }), {
    target: { value: "ada@example.com" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /email me a link/i }));
  expect(await within(dialog).findByText("Check your email")).toBeInTheDocument();
  expect(within(dialog).getByText(/ada@example\.com/)).toBeInTheDocument();
  expect(bodies).toEqual([{ email: "ada@example.com" }]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

  // 429 → wait message, no "check your email"
  status = 429;
  dialog = await openSheet();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /email/i }), {
    target: { value: "ada@example.com" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /email me a link/i }));
  expect(
    await within(dialog).findByText("Please wait a few minutes before requesting another link."),
  ).toBeInTheDocument();
  expect(within(dialog).queryByText("Check your email")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

  // 404 (or any other 4xx) must not reveal whether the account exists
  status = 404;
  dialog = await openSheet();
  fireEvent.change(within(dialog).getByRole("textbox", { name: /email/i }), {
    target: { value: "nobody@example.com" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: /email me a link/i }));
  expect(await within(dialog).findByText("Check your email")).toBeInTheDocument();
});

test("delete account requires typing DELETE and then re-bootstraps anonymously", async () => {
  let deleted = 0;
  let minted = 0;
  server.use(
    meHandler([signedIn, anon]),
    profilesHandler(() => []),
    http.delete(`${BASE}/account`, ({ request }) => {
      deleted++;
      expect(request.headers.get("authorization")).toBe(`Bearer ${jwt("u1")}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${BASE}/auth/anonymous`, () => {
      minted++;
      return HttpResponse.json({ token: jwt("anon2"), user_id: "anon2" }, { status: 201 });
    }),
  );
  renderAccount();
  await screen.findByText("ada@example.com");
  const button = screen.getByRole("button", { name: "Delete account" });
  expect(button).toBeDisabled();
  const input = screen.getByRole("textbox", { name: /type DELETE/i });
  fireEvent.change(input, { target: { value: "delete" } });
  expect(button).toBeDisabled();
  fireEvent.change(input, { target: { value: "DELETE" } });
  expect(button).toBeEnabled();

  fireEvent.click(button);
  await waitFor(() => expect(deleted).toBe(1));
  await waitFor(() => expect(minted).toBe(1));
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe(jwt("anon2")));
  await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/"));
  expect(await screen.findByText("Account deleted")).toBeInTheDocument();
  // the cache no longer carries the deleted user's /me
  expect(qc.getQueryData<Me>(["me"])?.email ?? null).toBeNull();
});

test("google credential is posted and /me refreshed", async () => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
  let callback: ((r: { credential: string }) => void) | null = null;
  const initialize = vi.fn((cfg: { client_id: string; callback: (r: { credential: string }) => void }) => {
    callback = cfg.callback;
  });
  const renderButton = vi.fn((el: HTMLElement, opts: Record<string, unknown>) => {
    const b = document.createElement("div");
    b.dataset.theme = String(opts.theme);
    b.setAttribute("role", "button");
    b.textContent = "Sign in with Google";
    el.appendChild(b);
  });
  (window as unknown as { google: unknown }).google = {
    accounts: { id: { initialize, renderButton, prompt: vi.fn(), disableAutoSelect: vi.fn() } },
  };
  const posted: { auth: string | null; body: unknown }[] = [];
  server.use(
    meHandler([anon, signedIn]),
    profilesHandler(() => []),
    http.post(`${BASE}/auth/google`, async ({ request }) => {
      posted.push({ auth: request.headers.get("authorization"), body: await request.json() });
      return HttpResponse.json({ token: jwt("u1"), user_id: "u1" });
    }),
  );
  renderAccount();
  const dialog = await openSheet();
  await waitFor(() => expect(renderButton).toHaveBeenCalledTimes(1));
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(initialize.mock.calls[0][0].client_id).toBe("cid.apps.googleusercontent.com");
  expect(renderButton.mock.calls[0][1]).toMatchObject({ theme: "filled_black", size: "large", width: 320 });
  expect(within(dialog).getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  expect(meCalls).toBe(1);

  await act(async () => {
    callback!({ credential: "cred1" });
  });
  await waitFor(() => expect(posted).toHaveLength(1));
  // the anonymous bearer rides along so the API links this session's data to the Google account
  expect(posted[0]).toEqual({ auth: `Bearer ${jwt("u1")}`, body: { id_token: "cred1" } });
  expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
  expect(meCalls).toBe(2);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByText("Signed in")).toBeInTheDocument();
});
