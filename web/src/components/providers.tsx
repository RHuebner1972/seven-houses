"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createApi, type Api } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import { decodeClaims, decodeUserId, localStorageTokenStore, needsRefresh, type TokenStore } from "@/lib/auth";
import { clearDailyCache } from "@/lib/daily-cache";
import { ToastProvider } from "@/components/toast";
import { SessionExpiredNotice } from "@/components/session-expired-notice";
import { selectBillingProvider } from "@/billing";
import type { BillingProvider as BillingProviderApi } from "@/billing/provider";

export const SESSION_EXPIRED_COPY =
  "Your session ended. Sign in again to restore your readings and credits.";

export interface AuthValue {
  token: string | null;
  userId: string | null;
  ready: boolean;
  /** A signed-in token was rejected and replaced by an anonymous one; cleared by signing in. */
  sessionExpired: boolean;
  signInWithGoogle(idToken: string): Promise<void>;
  verifyMagic(token: string): Promise<void>;
  signOut(): Promise<void>;
}

interface AuthInternals extends AuthValue {
  api: Api;
}

const AuthContext = createContext<AuthInternals | null>(null);

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function useApi(): Api {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useApi must be used within <AuthProvider>");
  return ctx.api;
}

export function AuthProvider({
  children,
  store = localStorageTokenStore,
}: {
  children: ReactNode;
  store?: TokenStore;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const bootstrapped = useRef(false);

  const [session] = useState(() => {
    const adopt = (t: string) => {
      store.set(t);
      setToken(t);
    };
    let pending: Promise<string> | null = null;
    // Mint an anonymous session; concurrent callers share one in-flight request.
    const mint = (): Promise<string> => {
      pending ??= (async () => {
        try {
          const r = await api.anonymous();
          adopt(r.token);
          return r.token;
        } finally {
          pending = null;
        }
      })();
      return pending;
    };
    let refreshing: Promise<void> | null = null;
    /**
     * Swap a valid-but-ageing token for a fresh one so a regular visitor never reaches the
     * 30-day expiry. Best effort: failures are swallowed (the next boot tries again), and the
     * reply is dropped if sign-in or sign-out changed the token while it was in flight.
     */
    const refreshIfStale = (): Promise<void> => {
      const cur = store.get();
      if (!cur || !needsRefresh(cur)) return Promise.resolve();
      refreshing ??= (async () => {
        try {
          const r = await api.refresh();
          if (store.get() === cur) adopt(r.token);
        } catch {
          /* keep the current token; it is still valid */
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    };
    const api: Api = createApi(
      () => store.get(),
      (failed) => {
        // A stale 401 must not destroy a newer valid token.
        const cur = store.get();
        if (cur && cur !== failed) return Promise.resolve(cur);
        // Losing a signed-in session is worth a word; an anonymous one is replaced silently.
        if (decodeClaims(failed)?.anon === false) setSessionExpired(true);
        store.clear();
        return mint();
      },
    );
    return { api, mint, adopt, refreshIfStale };
  });
  const { api, mint, adopt, refreshIfStale } = session;

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      const existing = store.get();
      if (existing) setToken(existing);
      else {
        try {
          await mint();
        } catch {
          /* offline: stay unauthenticated; first 401 retries */
        }
      }
      setReady(true);
      if (existing) void refreshIfStale();
    })();
  }, [store, mint, refreshIfStale]);

  // A tab left open for days: re-check the token age whenever it comes back into view.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshIfStale]);

  const signInWithGoogle = useCallback(
    async (idToken: string) => {
      const r = await api.google(idToken);
      adopt(r.token);
      setSessionExpired(false);
      await queryClient.invalidateQueries();
    },
    [api, adopt, queryClient],
  );

  const verifyMagic = useCallback(
    async (t: string) => {
      // the link is single-use: do not spend it on a bearer the API may be about to reject
      await refreshIfStale();
      const r = await api.magicVerify(t);
      adopt(r.token);
      setSessionExpired(false);
      await queryClient.invalidateQueries();
    },
    [api, adopt, refreshIfStale, queryClient],
  );

  const signOut = useCallback(async () => {
    // cancel synchronously so in-flight fetches cannot repopulate the cache
    const cancelled = queryClient.cancelQueries();
    queryClient.clear();
    await cancelled;
    try {
      store.clear();
      clearDailyCache(); // the daily card belongs to the account being left
      setToken(null);
      await mint();
    } finally {
      queryClient.clear();
    }
  }, [store, mint, queryClient]);

  const value = useMemo<AuthInternals>(
    () => ({
      api,
      token,
      userId: decodeUserId(token),
      ready,
      sessionExpired,
      signInWithGoogle,
      verifyMagic,
      signOut,
    }),
    [api, token, ready, sessionExpired, signInWithGoogle, verifyMagic, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

const BillingContext = createContext<BillingProviderApi | null>(null);

/**
 * The selected billing backend, already bound to the signed-in user: `packages()` and
 * `purchase()` wait for `configure(userId)` to finish, so pages need not sequence it.
 */
export function useBilling(): BillingProviderApi {
  const ctx = useContext(BillingContext);
  if (!ctx) throw new Error("useBilling must be used within <BillingProvider>");
  return ctx;
}

function defaultBilling(): BillingProviderApi {
  // Literal `process.env.NEXT_PUBLIC_*` reads so the static build inlines them.
  return selectBillingProvider({
    NEXT_PUBLIC_BILLING: process.env.NEXT_PUBLIC_BILLING,
    NEXT_PUBLIC_RC_WEB_KEY: process.env.NEXT_PUBLIC_RC_WEB_KEY,
  }).provider;
}

export function BillingProvider({
  children,
  provider,
}: {
  children: ReactNode;
  provider?: BillingProviderApi;
}) {
  const { userId } = useAuth();
  const [backend] = useState(() => provider ?? defaultBilling());
  // The configure() in flight (or settled) for a given user id; one per id, re-run on change.
  const bound = useRef<{ userId: string; promise: Promise<void> } | null>(null);

  const bind = useCallback(
    (id: string): Promise<void> => {
      if (bound.current?.userId === id) return bound.current.promise;
      const entry = { userId: id, promise: Promise.resolve() };
      entry.promise = backend.configure(id).catch((e: unknown) => {
        // let the next caller try again rather than caching the failure forever
        if (bound.current === entry) bound.current = null;
        throw e;
      });
      bound.current = entry;
      return entry.promise;
    },
    [backend],
  );

  // Configure as soon as auth knows who we are, and again when sign-in changes the id.
  useEffect(() => {
    if (!userId) return;
    bind(userId).catch(() => {
      /* surfaced to whoever calls packages()/purchase() */
    });
  }, [userId, bind]);

  const value = useMemo<BillingProviderApi>(
    () => ({
      configure: bind,
      async packages() {
        if (!userId) throw new Error("billing: no user yet");
        await bind(userId);
        return backend.packages();
      },
      async purchase(pkg) {
        if (!userId) throw new Error("billing: no user yet");
        await bind(userId);
        return backend.purchase(pkg);
      },
    }),
    [backend, bind, userId],
  );

  return <BillingContext.Provider value={value}>{children}</BillingContext.Provider>;
}

function defaultQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (count, err) =>
          !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
      },
    },
  });
}

export function Providers({
  children,
  queryClient,
  billing,
}: {
  children: ReactNode;
  queryClient?: QueryClient;
  /** Test seam; production selects from `NEXT_PUBLIC_BILLING` / `NEXT_PUBLIC_RC_WEB_KEY`. */
  billing?: BillingProviderApi;
}) {
  const [client] = useState(() => queryClient ?? defaultQueryClient());
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <BillingProvider provider={billing}>
          <ToastProvider>
            {children}
            <SessionExpiredNotice />
          </ToastProvider>
        </BillingProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
