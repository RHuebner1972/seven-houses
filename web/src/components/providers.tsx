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
import { decodeUserId, localStorageTokenStore, type TokenStore } from "@/lib/auth";

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
      () => {
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
    store.clear();
    setToken(null);
    await mint();
    queryClient.clear();
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

/** Placeholder; Task 10 supplies the real value. */
export const BillingContext = createContext<null | unknown>(null);

export function BillingProvider({ children }: { children: ReactNode }) {
  return <BillingContext.Provider value={null}>{children}</BillingContext.Provider>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: process.env.NODE_ENV === "test" ? false : 1,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <BillingProvider>{children}</BillingProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
