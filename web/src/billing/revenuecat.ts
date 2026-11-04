import { creditsFromProductId, PurchaseCancelledError, type BillingProvider, type Package } from "./provider";

type Sdk = typeof import("@revenuecat/purchases-js");
type RcPackage = import("@revenuecat/purchases-js").Package;

/**
 * RevenueCat Web Billing (`@revenuecat/purchases-js`). The SDK is imported lazily on the
 * first `configure()` so the mock path, tests, and the static prerender never load it.
 */
export function createRevenueCatBilling(apiKey: string): BillingProvider {
  let sdk: Sdk | null = null;
  let appUserId: string | null = null;
  // RevenueCat packages keyed by our Package.id so purchase() can hand back the original object.
  const rcPackages = new Map<string, RcPackage>();

  async function loadSdk(): Promise<Sdk> {
    sdk ??= await import("@revenuecat/purchases-js");
    return sdk;
  }

  function instance(): import("@revenuecat/purchases-js").Purchases {
    if (!sdk || !appUserId) throw new Error("RevenueCat billing: configure() first");
    return sdk.Purchases.getSharedInstance();
  }

  return {
    async configure(id) {
      const { Purchases } = await loadSdk();
      if (!Purchases.isConfigured()) {
        Purchases.configure({ apiKey, appUserId: id });
      } else if (Purchases.getSharedInstance().getAppUserId() !== id) {
        // Sign-in merged the anonymous user into a real one; follow it.
        await Purchases.getSharedInstance().changeUser(id);
      }
      appUserId = id;
    },

    async packages() {
      const offerings = await instance().getOfferings();
      const current = offerings.current;
      if (!current) return [];
      rcPackages.clear();
      const out: Package[] = [];
      for (const rc of current.availablePackages) {
        const credits = creditsFromProductId(rc.product.identifier);
        if (credits === null) continue; // not a credit pack we understand
        rcPackages.set(rc.identifier, rc);
        out.push({
          id: rc.identifier,
          productId: rc.product.identifier,
          title: rc.product.title,
          credits,
          priceString: rc.product.price.formattedPrice,
        });
      }
      return out;
    },

    async purchase(pkg) {
      const rcPackage = rcPackages.get(pkg.id);
      if (!rcPackage) throw new Error(`RevenueCat billing: unknown package ${pkg.id}`);
      const { ErrorCode, PurchasesError } = sdk as Sdk;
      try {
        const result = await instance().purchase({ rcPackage });
        return { transactionId: result.storeTransaction.storeTransactionId };
      } catch (e) {
        if (e instanceof PurchasesError && e.errorCode === ErrorCode.UserCancelledError) {
          throw new PurchaseCancelledError();
        }
        throw e;
      }
    },
  };
}
