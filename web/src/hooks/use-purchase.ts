"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApi, useBilling } from "@/components/providers";
import { isPurchaseCancelled, type Package } from "@/billing/provider";
import type { Me } from "@/lib/types";

/** After a successful charge, `/me` is re-read this often, for at most this long. */
export const PURCHASE_POLL_INTERVAL_MS = 2000;
export const PURCHASE_POLL_MAX_MS = 30_000;

export type PurchasePhase =
  | { kind: "idle" }
  | { kind: "purchasing"; packageId: string }
  | { kind: "processing"; packageId: string }
  | { kind: "success"; packageId: string; balance: number }
  | { kind: "slow"; packageId: string }
  | { kind: "error"; packageId: string; message: string };

/**
 * Drives one purchase: checkout → "processing" while the API's webhook credits the account
 * (detected by `/me.balance` rising above where it started) → success, or a calm
 * "still processing" note once the poll budget is spent. A successful charge is never an error.
 */
export function usePurchase() {
  const api = useApi();
  const billing = useBilling();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<PurchasePhase>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const buy = useCallback(
    async (pkg: Package, startBalance: number) => {
      setPhase({ kind: "purchasing", packageId: pkg.id });
      try {
        await billing.purchase(pkg);
      } catch (e) {
        if (!mounted.current) return;
        setPhase(
          isPurchaseCancelled(e)
            ? { kind: "idle" }
            : {
                kind: "error",
                packageId: pkg.id,
                message: "We couldn't complete that purchase. You haven't been charged — please try again.",
              },
        );
        return;
      }
      if (!mounted.current) return;
      setPhase({ kind: "processing", packageId: pkg.id });

      const startedAt = Date.now();
      const poll = async () => {
        timer.current = null;
        let me: Me | null = null;
        try {
          me = await api.me();
        } catch {
          /* transient; keep polling until the budget runs out */
        }
        if (!mounted.current) return;
        if (me && me.balance > startBalance) {
          queryClient.setQueryData<Me>(["me"], me);
          void queryClient.invalidateQueries({ queryKey: ["me"], refetchType: "none" });
          setPhase({ kind: "success", packageId: pkg.id, balance: me.balance });
          return;
        }
        if (Date.now() - startedAt >= PURCHASE_POLL_MAX_MS) {
          // Mark stale so the next visit re-reads, without starting a fetch from here.
          void queryClient.invalidateQueries({ queryKey: ["me"], refetchType: "none" });
          setPhase({ kind: "slow", packageId: pkg.id });
          return;
        }
        timer.current = setTimeout(poll, PURCHASE_POLL_INTERVAL_MS);
      };
      await poll();
    },
    [api, billing, queryClient],
  );

  const busy = phase.kind === "purchasing" || phase.kind === "processing";
  return { phase, busy, buy };
}
