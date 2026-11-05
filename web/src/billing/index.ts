import { createMockBilling } from "./mock";
import type { BillingProvider } from "./provider";
import { createRevenueCatBilling } from "./revenuecat";

export type BillingKind = "mock" | "revenuecat";

let warnedUnavailable = false;

export interface BillingEnv {
  NEXT_PUBLIC_BILLING?: string;
  NEXT_PUBLIC_RC_WEB_KEY?: string;
  NODE_ENV?: string;
}

export interface BillingSelection {
  kind: BillingKind;
  provider: BillingProvider;
  /**
   * True when a production build resolved to mock billing: the store must say it is
   * unavailable rather than list packs nobody can really buy. Dev and test keep the mock.
   */
  unavailable: boolean;
}

/**
 * `NEXT_PUBLIC_BILLING=mock|revenuecat`; unset → `revenuecat` when `NEXT_PUBLIC_RC_WEB_KEY`
 * is set, else `mock`. Asking for RevenueCat without a key degrades to mock so a
 * misconfigured build renders instead of crashing; in production that mock is flagged
 * `unavailable`.
 */
export function selectBillingProvider(env: BillingEnv): BillingSelection {
  const key = env.NEXT_PUBLIC_RC_WEB_KEY?.trim() || null;
  const wanted = env.NEXT_PUBLIC_BILLING?.trim().toLowerCase();
  const kind: BillingKind = wanted === "mock" ? "mock" : key ? "revenuecat" : "mock";
  if (kind === "revenuecat" && key) return { kind, provider: createRevenueCatBilling(key), unavailable: false };
  if (wanted === "revenuecat") {
    console.error("NEXT_PUBLIC_BILLING=revenuecat but NEXT_PUBLIC_RC_WEB_KEY is unset; using mock billing");
  }
  const unavailable = env.NODE_ENV === "production";
  if (unavailable && !warnedUnavailable) {
    warnedUnavailable = true; // once per process, not once per prerendered page
    console.error("Production build resolved to mock billing; the store will show as unavailable");
  }
  return { kind: "mock", provider: createMockBilling(), unavailable };
}

export type { BillingProvider, Package } from "./provider";
