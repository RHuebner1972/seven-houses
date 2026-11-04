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
import { decodeUserId, localStorageTokenStore, type TokenStore } from "@/lib/auth";
import { ToastProvider } from "@/components/toast";
import { selectBillingProvider } from "@/billing";
import type { BillingProvider as BillingProviderApi } from "@/billing/provider";

export interface AuthValue {
  token: string | null;
  userId: string | null;
  ready: boolean;
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
    const api: Api = createApi(
      () => store.get(),
      (failed) => {
        // A stale 401 must not destroy a newer valid token.
        const cur = store.get();
        if (cur && cur !== failed) return Promise.resolve(cur);
        store.clear();
        return mint();
      },
    );
    return { api, mint, adopt };
  });
  const { api, mint, adopt } = session;

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
    })();
  }, [store, mint]);

  const signInWithGoogle = useCallback(
    async (idToken: string) => {
      const r = await api.google(idToken);
      adopt(r.token);
      await queryClient.invalidateQueries();
    },
    [api, adopt, queryClient],
  );

  const verifyMagic = useCallback(
    async (t: string) => {
      const r = await api.magicVerify(t);
      adopt(r.token);
      await queryClient.invalidateQueries();
    },
    [api, adopt, queryClient],
  );

  const signOut = useCallback(async () => {
    // cancel synchronously so in-flight fetches cannot repopulate the cache
    const cancelled = queryClient.cancelQueries();
    queryClient.clear();
    await cancelled;
    try {
      store.clear();
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
      signInWithGoogle,
      verifyMagic,
      signOut,
    }),
    [api, token, ready, signInWithGoogle, verifyMagic, signOut],
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
          <ToastProvider>{children}</ToastProvider>
        </BillingProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
