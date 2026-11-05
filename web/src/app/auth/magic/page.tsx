"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers";
import { ApiError } from "@/lib/errors";

const shell = "mx-auto max-w-3xl px-6 pt-10 pb-28 md:pb-16";
const button =
  "inline-block rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10";

const MAGIC_EXPIRED_COPY = "This link has expired. Request a new one.";
const MAGIC_UNAVAILABLE_COPY = "We couldn't verify this link right now.";

function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-muted">
      <span
        aria-hidden="true"
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gold/30 border-t-gold motion-reduce:animate-none"
      />
      {label}
    </div>
  );
}

export default function MagicPage() {
  // useSearchParams needs a Suspense boundary so the static export can prerender the shell.
  return (
    <Suspense
      fallback={
        <section className={shell}>
          <Spinner label="Loading…" />
        </section>
      }
    >
      <MagicRoute />
    </Suspense>
  );
}

type State = { kind: "verifying" } | { kind: "expired" } | { kind: "unavailable" };

/**
 * `/auth/magic/?token=` — spends the single-use link. Waits for auth to be ready so
 * the request carries this device's current (anonymous) bearer, which is what lets
 * the API fold the anonymous readings into the signed-in account.
 */
function MagicRoute() {
  const token = useSearchParams().get("token");
  const router = useRouter();
  const { ready, verifyMagic } = useAuth();
  const [state, setState] = useState<State>({ kind: "verifying" });
  // The token is single-use: StrictMode's doubled effects and re-renders must not re-send it.
  const attempted = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ready || !token) return;
    const key = `${token}#${attempt}`;
    if (attempted.current === key) return;
    attempted.current = key;
    setState({ kind: "verifying" });
    verifyMagic(token).then(
      () => router.replace("/account/"),
      (e: unknown) => {
        const transient = e instanceof ApiError && (e.status === 0 || e.status >= 500);
        setState({ kind: transient ? "unavailable" : "expired" });
      },
    );
  }, [ready, token, attempt, verifyMagic, router]);

  if (!token || state.kind === "expired") {
    return (
      <section className={shell}>
        <h1 className="text-4xl text-gold-hi">Sign-in link</h1>
        <p role="alert" className="mt-4 text-ink">
          {MAGIC_EXPIRED_COPY}
        </p>
        <p className="mt-2 text-sm text-muted">
          Links work once and only on the device that asked for them. If you requested this one
          elsewhere, open it there.
        </p>
        <Link href="/account/" className={`${button} mt-8`}>
          Go to your account
        </Link>
      </section>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <section className={shell}>
        <h1 className="text-4xl text-gold-hi">Sign-in link</h1>
        <p role="alert" className="mt-4 text-ink">
          {MAGIC_UNAVAILABLE_COPY}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className={button}>
            Try again
          </button>
          <Link href="/account/" className="inline-block px-6 py-2.5 text-muted hover:text-ink">
            Go to your account
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={shell}>
      <Spinner label="Signing you in…" />
    </section>
  );
}
