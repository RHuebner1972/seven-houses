import { createMockBilling } from "./mock";
import type { BillingProvider } from "./provider";
import { createRevenueCatBilling } from "./revenuecat";

export type BillingKind = "mock" | "revenuecat";

export interface BillingEnv {
  NEXT_PUBLIC_BILLING?: string;
  NEXT_PUBLIC_RC_WEB_KEY?: string;
}

/**
 * `NEXT_PUBLIC_BILLING=mock|revenuecat`; unset → `revenuecat` when `NEXT_PUBLIC_RC_WEB_KEY`
 * is set, else `mock`. Asking for RevenueCat without a key degrades to mock so a
 * misconfigured build renders a store instead of crashing.
 */
export function selectBillingProvider(env: BillingEnv): { kind: BillingKind; provider: BillingProvider } {
  const key = env.NEXT_PUBLIC_RC_WEB_KEY?.trim() || null;
  const wanted = env.NEXT_PUBLIC_BILLING?.trim().toLowerCase();
  const kind: BillingKind = wanted === "mock" ? "mock" : key ? "revenuecat" : "mock";
  if (kind === "revenuecat" && key) return { kind, provider: createRevenueCatBilling(key) };
  return { kind: "mock", provider: createMockBilling() };
}

export type { BillingProvider, Package } from "./provider";
