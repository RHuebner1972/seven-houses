"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApi, useBilling } from "@/components/providers";
import { isPurchaseCancelled, isPurchasePending, type Package } from "@/billing/provider";
import type { Me } from "@/lib/types";

/** After a successful charge, `/me` is re-read this often, for at most this long. */
export const PURCHASE_POLL_INTERVAL_MS = 2000;
export const PURCHASE_POLL_MAX_MS = 30_000;

export const PURCHASE_FAILED_COPY =
  "We couldn't confirm that purchase. If you were charged, your credits will appear shortly — otherwise please try again.";
export const PURCHASE_BASELINE_FAILED_COPY =
  "We couldn't reach your account just now. You haven't been charged — please try again.";

export type PurchasePhase =
  | { kind: "idle" }
  | { kind: "purchasing"; packageId: string }
  | { kind: "processing"; packageId: string }
  | { kind: "success"; packageId: string; balance: number }
  | { kind: "slow"; packageId: string }
  | { kind: "error"; packageId: string; message: string };

/** Why `buy` declined to start a checkout. */
export type BuyOutcome = "started" | "busy" | "needs_sign_in" | "failed";

/**
 * Drives one purchase: fresh `/me` for the balance baseline → checkout → "processing" while
 * the API's webhook credits the account (detected by `/me.balance` rising above the
 * baseline) → success, or a calm "still processing" note once the poll budget is spent.
 * A payment the SDK reports as pending is treated as a successful charge, never an error.
 */
export function usePurchase() {
  const api = useApi();
  const billing = useBilling();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<PurchasePhase>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const buy = useCallback(
    async (pkg: Package): Promise<BuyOutcome> => {
      if (inFlight.current) return "busy";
      inFlight.current = true;
      const finish = (next: PurchasePhase): void => {
        inFlight.current = false;
        if (mounted.current) setPhase(next);
      };

      setPhase({ kind: "purchasing", packageId: pkg.id });

      // Re-read the account right now: the cached balance may predate credits that landed
      // after an earlier "still processing" purchase, which would fake a success here.
      let baseline: Me;
      try {
        baseline = await api.me();
      } catch {
        finish({ kind: "error", packageId: pkg.id, message: PURCHASE_BASELINE_FAILED_COPY });
        return "failed";
      }
      if (!mounted.current) {
        inFlight.current = false;
        return "failed";
      }
      queryClient.setQueryData<Me>(["me"], baseline);
      if (baseline.anon) {
        finish({ kind: "idle" });
        return "needs_sign_in";
      }
      const startBalance = baseline.balance;

      try {
        await billing.purchase(pkg);
      } catch (e) {
        if (isPurchaseCancelled(e)) {
          finish({ kind: "idle" });
          return "failed";
        }
        if (!isPurchasePending(e)) {
          finish({ kind: "error", packageId: pkg.id, message: PURCHASE_FAILED_COPY });
          return "failed";
        }
        // pending: the charge went through; fall into the poll path below
      }
      if (!mounted.current) {
        inFlight.current = false;
        return "started";
      }
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
        if (!mounted.current) {
          inFlight.current = false;
          return;
        }
        if (me && me.balance > startBalance) {
          queryClient.setQueryData<Me>(["me"], me);
          void queryClient.invalidateQueries({ queryKey: ["me"], refetchType: "none" });
          finish({ kind: "success", packageId: pkg.id, balance: me.balance });
          return;
        }
        if (Date.now() - startedAt >= PURCHASE_POLL_MAX_MS) {
          // Let the nav pill and anything else watching /me pick up credits as they land.
          void queryClient.invalidateQueries({ queryKey: ["me"], refetchType: "active" });
          finish({ kind: "slow", packageId: pkg.id });
          return;
        }
        timer.current = setTimeout(poll, PURCHASE_POLL_INTERVAL_MS);
      };
      await poll();
      return "started";
    },
    [api, billing, queryClient],
  );

  const busy = phase.kind === "purchasing" || phase.kind === "processing";
  return { phase, busy, buy };
}
