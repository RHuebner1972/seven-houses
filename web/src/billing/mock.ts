import type { BillingProvider, Package } from "./provider";

/** Deterministic packages for tests and local development. */
export const MOCK_PACKAGES: readonly Package[] = [
  { id: "credits_5", productId: "sh_credits_5", title: "Starter", credits: 5, priceString: "$4.99" },
  { id: "credits_15", productId: "sh_credits_15", title: "Seeker", credits: 15, priceString: "$12.99" },
  { id: "credits_40", productId: "sh_credits_40", title: "Oracle", credits: 40, priceString: "$29.99" },
];

/**
 * Resolves purchases immediately without charging anything. The API still owns the
 * balance, so in dev the credits only appear once something posts the webhook.
 */
export function createMockBilling(): BillingProvider {
  let configuredFor: string | null = null;
  let seq = 0;
  return {
    async configure(appUserId) {
      configuredFor = appUserId;
    },
    async packages() {
      if (!configuredFor) throw new Error("mock billing: configure() first");
      return MOCK_PACKAGES.map((p) => ({ ...p }));
    },
    async purchase(pkg) {
      if (!configuredFor) throw new Error("mock billing: configure() first");
      seq += 1;
      return { transactionId: `mock-${pkg.productId}-${seq}` };
    },
  };
}
