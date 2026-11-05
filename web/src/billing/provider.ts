/** A purchasable credit pack, normalised across billing backends. */
export interface Package {
  /** Backend package identifier (RevenueCat package id). */
  id: string;
  /** Store product identifier, e.g. `sh_credits_5`. */
  productId: string;
  title: string;
  /** Credits granted on purchase, parsed from the product id. */
  credits: number;
  /** Localised, formatted price, e.g. `$4.99`. */
  priceString: string;
}

/**
 * Isolates the payment SDK so the web app, tests, and the Android wrapper can swap it.
 * Implementations never touch credit balances: the API's webhook does that, and the
 * client re-reads `/me`.
 */
export interface BillingProvider {
  /** Bind the backend to the current app user. Idempotent for the same id; re-binds on change. */
  configure(appUserId: string): Promise<void>;
  packages(): Promise<Package[]>;
  /** Resolves once the charge succeeded; rejects with {@link PurchaseCancelledError} if the user backed out. */
  purchase(pkg: Package): Promise<{ transactionId: string }>;
}

/** The user closed the checkout without paying — not an error to show. */
export class PurchaseCancelledError extends Error {
  constructor() {
    super("purchase cancelled");
    this.name = "PurchaseCancelledError";
  }
}

export function isPurchaseCancelled(e: unknown): boolean {
  return e instanceof PurchaseCancelledError;
}

/**
 * The payment was accepted but is still settling (e.g. bank transfer, 3DS follow-up).
 * Treat as a successful purchase whose webhook has not landed yet.
 */
export class PurchasePendingError extends Error {
  constructor() {
    super("payment pending");
    this.name = "PurchasePendingError";
  }
}

export function isPurchasePending(e: unknown): boolean {
  return e instanceof PurchasePendingError;
}

const CREDITS_RE = /_credits_(\d+)$/;

/** `sh_credits_5` → 5. Null for any other shape (callers skip such packages). */
export function creditsFromProductId(productId: string): number | null {
  const m = CREDITS_RE.exec(productId);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
