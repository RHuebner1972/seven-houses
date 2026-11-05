"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth, useBilling } from "@/components/providers";
import { SignInSheet } from "@/components/sign-in-sheet";
import { useMe } from "@/hooks/use-me";
import { usePurchase, type PurchasePhase } from "@/hooks/use-purchase";
import type { Package } from "@/billing/provider";

const shell = "mx-auto max-w-3xl px-6 pt-10 pb-28 md:pb-16";
const button =
  "rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
const smallButton =
  "rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10";

export const PACKAGES_KEY = ["billing", "packages"] as const;

function Spinner({ label, live = true }: { label: string; live?: boolean }) {
  return (
    <div role={live ? "status" : undefined} className="flex items-center gap-3 text-muted">
      <span
        aria-hidden="true"
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gold/30 border-t-gold motion-reduce:animate-none"
      />
      {label}
    </div>
  );
}

export default function StorePage() {
  const { ready, userId } = useAuth();
  const billing = useBilling();
  const me = useMe();
  const { phase, busy, buy } = usePurchase();
  const [askSignIn, setAskSignIn] = useState(false);

  const packages = useQuery({
    queryKey: [...PACKAGES_KEY, userId],
    queryFn: () => billing.packages(),
    enabled: ready && !!userId,
    staleTime: 5 * 60_000,
  });

  const onBuy = (pkg: Package) => {
    if (!me.data || busy) return;
    // Cached state is a fast path; `buy` re-checks against a fresh /me before charging.
    if (me.data.anon) {
      setAskSignIn(true);
      return;
    }
    void buy(pkg).then((outcome) => {
      if (outcome === "needs_sign_in") setAskSignIn(true);
    });
  };

  return (
    <section className={shell}>
      <h1 className="text-4xl text-gold-hi">Credits</h1>
      <p className="mt-2 max-w-prose leading-relaxed text-muted">
        Full readings draw on credits; your daily card is always free. Packs never expire.
      </p>
      {me.data ? (
        <p className="mt-4 text-ink">
          Your balance: <span className="font-display text-2xl text-gold-hi">{me.data.balance}</span>
        </p>
      ) : null}

      <PurchaseStatus phase={phase} />

      {packages.isPending ? (
        <div className="mt-8">
          <Spinner label="Fetching packs…" />
        </div>
      ) : null}

      {packages.isError ? (
        <div role="alert" className="mt-8 space-y-3">
          <p className="text-gold-hi">We couldn&apos;t load the credit packs right now.</p>
          <button type="button" onClick={() => packages.refetch()} className={smallButton}>
            Retry
          </button>
        </div>
      ) : null}

      {packages.isSuccess && packages.data.length === 0 ? (
        <p className="mt-8 text-muted">No credit packs are available right now. Please check back soon.</p>
      ) : null}

      {packages.isSuccess && packages.data.length > 0 ? (
        <ul className="mt-8 grid gap-4 sm:grid-cols-3">
          {packages.data.map((pkg) => (
            <li
              key={pkg.id}
              className="flex flex-col rounded-lg border border-gold/30 bg-bg-deep/60 p-5"
            >
              <h2 className="font-display text-2xl text-gold-hi">{pkg.title}</h2>
              <p className="mt-1 text-ink">{`${pkg.credits} credits`}</p>
              <p className="mt-4 text-3xl text-gold-hi">{pkg.priceString}</p>
              <button
                type="button"
                aria-label={`Buy ${pkg.title}: ${pkg.credits} credits for ${pkg.priceString}`}
                disabled={busy || !me.data}
                onClick={() => onBuy(pkg)}
                className={`${button} mt-5`}
              >
                {busy && phase.kind !== "idle" && "packageId" in phase && phase.packageId === pkg.id
                  ? "Buying…"
                  : "Buy"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <SignInSheet open={askSignIn} onClose={() => setAskSignIn(false)} />
    </section>
  );
}

function PurchaseStatus({ phase }: { phase: PurchasePhase }) {
  const box = "mt-6 rounded-lg border px-5 py-4";
  switch (phase.kind) {
    case "processing":
      return (
        <div role="status" aria-label="Purchase status" className={`${box} border-gold/40 bg-bg-deep/60 text-ink`}>
          <Spinner label="Processing your purchase…" live={false} />
        </div>
      );
    case "success":
      return (
        <p role="status" aria-label="Purchase status" className={`${box} border-gold bg-gold/10 text-gold-hi`}>
          Your credits are in. Balance: {phase.balance}.
        </p>
      );
    case "slow":
      return (
        <p role="status" aria-label="Purchase status" className={`${box} border-gold/40 bg-bg-deep/60 text-ink`}>
          Your purchase is being processed — credits will appear shortly.
        </p>
      );
    case "error":
      return (
        <p role="alert" className={`${box} border-gold/60 bg-bg-deep/60 text-gold-hi`}>
          {phase.message}
        </p>
      );
    default:
      return null;
  }
}
