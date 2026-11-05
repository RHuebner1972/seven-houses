import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { StrictMode, useEffect } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Providers as RealProviders, SESSION_EXPIRED_COPY, useAuth, useApi } from "@/components/providers";
import type { ReactNode } from "react";
import { BalancePill } from "@/components/balance-pill";
import { decodeClaims, decodeUserId, needsRefresh, REFRESH_AFTER_MS } from "@/lib/auth";
import { apiBase } from "@/lib/api";

const BASE = apiBase();
let qc: QueryClient;
function Providers({ children }: { children: ReactNode }) {
  return <RealProviders queryClient={qc}>{children}</RealProviders>;
}
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const cap: { auth?: ReturnType<typeof useAuth>; api?: ReturnType<typeof useApi> } = {};
function Grab() {
  const auth = useAuth();
  const api = useApi();
  useEffect(() => {
    cap.auth = auth;
    cap.api = api;
  });
  return null;
}

let log: { path: string; auth: string | null }[] = [];
const count = (path: string) => log.filter((l) => l.path === path).length;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });
  log = [];
  cap.auth = undefined;
  cap.api = undefined;
  localStorage.clear();
});
afterEach(() => server.resetHandlers());

const jwt = (sub: string) => {
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "none" })}.${b64({ sub })}.sig`;
};

function logged(path: string, method: "get" | "post", resolver: () => Response) {
  return http[method](`${BASE}${path}`, ({ request }) => {
    log.push({ path, auth: request.headers.get("authorization") });
    return resolver();
  });
}

test("mints an anonymous session on first load", async () => {
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "t1", user_id: "u1" })),
    logged("/me", "get", () => HttpResponse.json({ user_id: "u1", email: null, anon: true, balance: 0 })),
  );
  render(
    <StrictMode>
      <Providers>
        <BalancePill />
      </Providers>
    </StrictMode>,
  );
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe("t1"));
  expect(await screen.findByText("0")).toBeInTheDocument();
  expect(count("/auth/anonymous")).toBe(1);
  expect(log.find((l) => l.path === "/me")?.auth).toBe("Bearer t1");
});

test("recovers from a 401 by re-bootstrapping", async () => {
  localStorage.setItem("sh.token", "dead");
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "t2", user_id: "u2" })),
    http.get(`${BASE}/me`, ({ request }) => {
      const auth = request.headers.get("authorization");
      log.push({ path: "/me", auth });
      return auth === "Bearer dead"
        ? HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 })
        : HttpResponse.json({ user_id: "u2", email: null, anon: true, balance: 3 });
    }),
  );
  render(
    <Providers>
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("3")).toBeInTheDocument();
  expect(localStorage.getItem("sh.token")).toBe("t2");
  expect(log.map((l) => `${l.path} ${l.auth}`)).toEqual([
    "/me Bearer dead",
    "/auth/anonymous null",
    "/me Bearer t2",
  ]);
});

test("concurrent 401s share one anonymous mint", async () => {
  localStorage.setItem("sh.token", "dead");
  server.use(
    http.post(`${BASE}/auth/anonymous`, async () => {
      log.push({ path: "/auth/anonymous", auth: null });
      await new Promise((r) => setTimeout(r, 50));
      return HttpResponse.json({ token: "t2", user_id: "u2" });
    }),
    http.get(`${BASE}/me`, ({ request }) => {
      const auth = request.headers.get("authorization");
      return auth === "Bearer dead"
        ? HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 })
        : HttpResponse.json({ user_id: "u2", email: null, anon: true, balance: 1 });
    }),
  );
  let me: Promise<unknown>[] = [];
  function Probe() {
    const { ready } = useAuth();
    return <span>{ready ? "ready" : "wait"}</span>;
  }
  function Caller() {
    const api = useApi();
    const { ready } = useAuth();
    useEffect(() => {
      if (ready && me.length === 0) me = [api.me(), api.me()];
    }, [api, ready]);
    return null;
  }
  render(
    <Providers>
      <Probe />
      <Caller />
    </Providers>,
  );
  await waitFor(() => expect(me.length).toBe(2));
  const res = (await Promise.all(me)) as { balance: number }[];
  expect(res.map((r) => r.balance)).toEqual([1, 1]);
  expect(count("/auth/anonymous")).toBe(1);
});

test("signOut clears the token and mints a new anonymous one", async () => {
  localStorage.setItem("sh.token", "old");
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "fresh", user_id: "u9" })),
    logged("/me", "get", () => HttpResponse.json({ user_id: "u", email: null, anon: true, balance: 5 })),
  );
  render(
    <Providers>
      <Grab />
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("5")).toBeInTheDocument();
  expect(count("/auth/anonymous")).toBe(0);
  let p!: Promise<void>;
  await act(async () => {
    p = cap.auth!.signOut();
  });
  expect(screen.getByLabelText("Credit balance")).toHaveTextContent("—");
  await act(async () => {
    await p;
  });
  expect(localStorage.getItem("sh.token")).toBe("fresh");
  expect(count("/auth/anonymous")).toBe(1);
  await waitFor(() => expect(log.filter((l) => l.path === "/me").at(-1)?.auth).toBe("Bearer fresh"));
});

test("userId is decoded from the token sub; malformed tokens give null", () => {
  expect(decodeUserId(jwt("user-42"))).toBe("user-42");
  expect(decodeUserId("garbage")).toBeNull();
  expect(decodeUserId("a.!!!.c")).toBeNull();
  expect(decodeUserId(null)).toBeNull();
});

test("useAuth exposes userId from the stored token", async () => {
  localStorage.setItem("sh.token", jwt("u-7"));
  server.use(
    logged("/me", "get", () => HttpResponse.json({ user_id: "u-7", email: null, anon: true, balance: 0 })),
  );
  function Show() {
    const { userId } = useAuth();
    return <span data-testid="uid">{userId ?? "none"}</span>;
  }
  render(
    <Providers>
      <Show />
    </Providers>,
  );
  await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u-7"));
});

test("balance pill shows a dash while loading", async () => {
  server.use(
    http.get(`${BASE}/me`, () => new Promise(() => {})),
    http.post(`${BASE}/auth/anonymous`, () => new Promise(() => {})),
  );
  render(
    <Providers>
      <BalancePill />
    </Providers>,
  );
  expect(screen.getByLabelText("Credit balance")).toHaveTextContent("—");
  // let the (hanging) bootstrap request reach this test's handler before the next test starts
  await new Promise((r) => setTimeout(r, 30));
});

test("a straggler 401 for a stale token does not destroy a newer token", async () => {
  localStorage.setItem("sh.token", "anon1");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "x", user_id: "x" })),
    logged("/auth/google", "post", () => HttpResponse.json({ token: "real", user_id: "u" })),
    http.get(`${BASE}/me`, async ({ request }) => {
      const auth = request.headers.get("authorization");
      if (auth === "Bearer anon1") {
        await gate;
        return HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 });
      }
      return HttpResponse.json({ user_id: "u", email: "a@b.c", anon: false, balance: 9 });
    }),
  );
  render(
    <Providers>
      <Grab />
    </Providers>,
  );
  await waitFor(() => expect(cap.auth?.ready).toBe(true));
  const straggler = cap.api!.me();
  await act(async () => {
    await cap.auth!.signInWithGoogle("idt");
  });
  expect(localStorage.getItem("sh.token")).toBe("real");
  release();
  expect((await straggler).balance).toBe(9);
  expect(localStorage.getItem("sh.token")).toBe("real");
  expect(count("/auth/anonymous")).toBe(0);
});

test("signOut with a failing mint still clears cache and store", async () => {
  localStorage.setItem("sh.token", "old");
  server.use(
    http.post(`${BASE}/auth/anonymous`, () => HttpResponse.error()),
    http.get(`${BASE}/me`, ({ request }) =>
      request.headers.get("authorization")
        ? HttpResponse.json({ user_id: "u", email: null, anon: true, balance: 5 })
        : HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 }),
    ),
  );
  render(
    <Providers>
      <Grab />
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("5")).toBeInTheDocument();
  await act(async () => {
    await cap.auth!.signOut().catch(() => undefined);
  });
  expect(qc.getQueryData(["me"])).toBeUndefined();
  expect(localStorage.getItem("sh.token")).toBeNull();
});

test("signInWithGoogle and verifyMagic adopt the token and refetch /me", async () => {
  localStorage.setItem("sh.token", "anon");
  let n = 0;
  server.use(
    logged("/auth/google", "post", () => HttpResponse.json({ token: "g1", user_id: "u" })),
    logged("/auth/magic/verify", "post", () => HttpResponse.json({ token: "m1", user_id: "u" })),
    logged("/me", "get", () => HttpResponse.json({ user_id: "u", email: null, anon: true, balance: ++n })),
  );
  render(
    <Providers>
      <Grab />
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("1")).toBeInTheDocument();
  await act(async () => {
    await cap.auth!.signInWithGoogle("idt");
  });
  expect(localStorage.getItem("sh.token")).toBe("g1");
  expect(await screen.findByText("2")).toBeInTheDocument();
  expect(log.filter((l) => l.path === "/me").at(-1)?.auth).toBe("Bearer g1");
  await act(async () => {
    await cap.auth!.verifyMagic("link");
  });
  expect(localStorage.getItem("sh.token")).toBe("m1");
  expect(log.find((l) => l.path === "/auth/magic/verify")?.auth).toBe("Bearer g1");
  expect(await screen.findByText("3")).toBeInTheDocument();
  expect(log.filter((l) => l.path === "/me").at(-1)?.auth).toBe("Bearer m1");
});

// --- token refresh and session expiry ---

const b64url = (o: object) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
/** A token minted `ageDays` ago with the API's 30-day TTL. */
const aged = (ageDays: number, { anon = true, sub = "u1" } = {}) => {
  const iat = nowSec() - ageDays * DAY;
  return `${b64url({ alg: "none" })}.${b64url({ sub, anon, iat, exp: iat + 30 * DAY })}.sig`;
};
const meOk = (over: object = {}) =>
  HttpResponse.json({ user_id: "u1", email: null, anon: true, balance: 0, ...over });

test("decodeClaims reads sub/anon/iat/exp and rejects malformed tokens", () => {
  const t = aged(2, { anon: false, sub: "u-2" });
  const c = decodeClaims(t)!;
  expect(c.sub).toBe("u-2");
  expect(c.anon).toBe(false);
  expect(c.exp! - c.iat!).toBe(30 * DAY);
  expect(decodeClaims(jwt("only-sub"))).toEqual({ sub: "only-sub", anon: null, iat: null, exp: null });
  expect(decodeClaims("garbage")).toBeNull();
  expect(decodeClaims("a.!!!.c")).toBeNull();
  expect(decodeClaims(`${b64url({})}.${b64url({ anon: true })}.s`)).toBeNull();
  expect(decodeClaims(null)).toBeNull();
  expect(REFRESH_AFTER_MS).toBe(7 * DAY * 1000);
  expect(needsRefresh(aged(8))).toBe(true);
  expect(needsRefresh(aged(1))).toBe(false);
  expect(needsRefresh(aged(31))).toBe(false); // expired: a refresh would 401; let the mint path handle it
  expect(needsRefresh("tok")).toBe(false);
});

test("a token older than seven days is refreshed on boot and the new one adopted", async () => {
  const old = aged(8);
  localStorage.setItem("sh.token", old);
  server.use(
    logged("/auth/refresh", "post", () => HttpResponse.json({ token: "r1" })),
    logged("/me", "get", () => meOk()),
  );
  render(
    <StrictMode>
      <Providers>
        <Grab />
        <BalancePill />
      </Providers>
    </StrictMode>,
  );
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe("r1"));
  expect(count("/auth/refresh")).toBe(1);
  expect(log.find((l) => l.path === "/auth/refresh")?.auth).toBe(`Bearer ${old}`);
  expect(count("/auth/anonymous")).toBe(0);
  await waitFor(() => expect(cap.auth?.token).toBe("r1"));
});

test("a one-day-old token is not refreshed", async () => {
  const fresh = aged(1);
  localStorage.setItem("sh.token", fresh);
  server.use(
    logged("/auth/refresh", "post", () => HttpResponse.json({ token: "r1" })),
    logged("/me", "get", () => meOk({ balance: 4 })),
  );
  render(
    <Providers>
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("4")).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 30));
  expect(count("/auth/refresh")).toBe(0);
  expect(localStorage.getItem("sh.token")).toBe(fresh);
});

test("the tab becoming visible re-checks the token age", async () => {
  localStorage.setItem("sh.token", aged(1));
  server.use(
    logged("/auth/refresh", "post", () => HttpResponse.json({ token: "r2" })),
    logged("/me", "get", () => meOk()),
  );
  render(
    <Providers>
      <Grab />
    </Providers>,
  );
  await waitFor(() => expect(cap.auth?.ready).toBe(true));
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(count("/auth/refresh")).toBe(0);
  // time passes (simulated: the stored token is now eight days old)
  localStorage.setItem("sh.token", aged(8));
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe("r2"));
  expect(count("/auth/refresh")).toBe(1);
});

test("a refresh that lands after the token changed is discarded", async () => {
  const old = aged(8);
  localStorage.setItem("sh.token", old);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.use(
    http.post(`${BASE}/auth/refresh`, async () => {
      log.push({ path: "/auth/refresh", auth: null });
      await gate;
      return HttpResponse.json({ token: "late" });
    }),
    logged("/auth/google", "post", () => HttpResponse.json({ token: "real", user_id: "u" })),
    logged("/me", "get", () => meOk()),
  );
  render(
    <Providers>
      <Grab />
    </Providers>,
  );
  await waitFor(() => expect(count("/auth/refresh")).toBe(1));
  await act(async () => {
    await cap.auth!.signInWithGoogle("idt");
  });
  expect(localStorage.getItem("sh.token")).toBe("real");
  release();
  await new Promise((r) => setTimeout(r, 30));
  expect(localStorage.getItem("sh.token")).toBe("real");
});

test("a refused refresh neither mints nor disturbs the current token", async () => {
  const old = aged(8);
  localStorage.setItem("sh.token", old);
  server.use(
    logged("/auth/refresh", "post", () =>
      HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 }),
    ),
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "x", user_id: "x" })),
    logged("/me", "get", () => meOk({ balance: 2 })),
  );
  render(
    <Providers>
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("2")).toBeInTheDocument();
  await waitFor(() => expect(count("/auth/refresh")).toBe(1));
  await new Promise((r) => setTimeout(r, 30));
  expect(count("/auth/anonymous")).toBe(0);
  expect(localStorage.getItem("sh.token")).toBe(old);
});

test("verifyMagic refreshes a stale bearer before spending the link", async () => {
  const old = aged(8);
  localStorage.setItem("sh.token", old);
  server.use(
    logged("/auth/refresh", "post", () => HttpResponse.json({ token: "r3" })),
    logged("/auth/magic/verify", "post", () => HttpResponse.json({ token: "m1", user_id: "u" })),
    logged("/me", "get", () => meOk()),
  );
  render(
    <Providers>
      <Grab />
    </Providers>,
  );
  await waitFor(() => expect(cap.auth?.ready).toBe(true));
  await act(async () => {
    await cap.auth!.verifyMagic("link");
  });
  expect(log.find((l) => l.path === "/auth/magic/verify")?.auth).toBe("Bearer r3");
  expect(localStorage.getItem("sh.token")).toBe("m1");
});

test("a 401 on a signed-in token mints anonymous and says the session ended", async () => {
  const signedIn = aged(1, { anon: false, sub: "u-real" });
  localStorage.setItem("sh.token", signedIn);
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "a1", user_id: "a" })),
    http.get(`${BASE}/me`, ({ request }) => {
      const auth = request.headers.get("authorization");
      log.push({ path: "/me", auth });
      return auth === `Bearer ${signedIn}`
        ? HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 })
        : meOk({ user_id: "a", balance: 0 });
    }),
    logged("/auth/google", "post", () => HttpResponse.json({ token: "g", user_id: "u-real" })),
  );
  render(
    <Providers>
      <Grab />
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("0")).toBeInTheDocument();
  expect(localStorage.getItem("sh.token")).toBe("a1");
  expect(count("/auth/anonymous")).toBe(1);
  await waitFor(() => expect(cap.auth?.sessionExpired).toBe(true));
  expect(screen.getByRole("status")).toHaveTextContent(SESSION_EXPIRED_COPY);
  // the toast offers a way back in
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  // signing in clears the flag
  await act(async () => {
    await cap.auth!.signInWithGoogle("idt");
  });
  expect(cap.auth?.sessionExpired).toBe(false);
});

test("a 401 on an anonymous token mints silently", async () => {
  const anon = aged(1, { anon: true });
  localStorage.setItem("sh.token", anon);
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "a2", user_id: "a" })),
    http.get(`${BASE}/me`, ({ request }) =>
      request.headers.get("authorization") === `Bearer ${anon}`
        ? HttpResponse.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 })
        : meOk({ balance: 6 }),
    ),
  );
  render(
    <Providers>
      <Grab />
      <BalancePill />
    </Providers>,
  );
  expect(await screen.findByText("6")).toBeInTheDocument();
  expect(localStorage.getItem("sh.token")).toBe("a2");
  expect(cap.auth?.sessionExpired).toBe(false);
  expect(screen.getByRole("status")).not.toHaveTextContent(/session ended/i);
});

test("signOut forgets the daily card cached for the previous user", async () => {
  localStorage.setItem("sh.token", jwt("u-a"));
  localStorage.setItem("sh.lastDaily", JSON.stringify({ userId: "u-a", localDate: "2026-11-05", reading: {} }));
  server.use(
    logged("/auth/anonymous", "post", () => HttpResponse.json({ token: "fresh", user_id: "u9" })),
    logged("/me", "get", () => meOk()),
  );
  render(
    <Providers>
      <Grab />
    </Providers>,
  );
  await waitFor(() => expect(cap.auth?.ready).toBe(true));
  await act(async () => {
    await cap.auth!.signOut();
  });
  expect(localStorage.getItem("sh.lastDaily")).toBeNull();
  expect(localStorage.getItem("sh.token")).toBe("fresh");
});
