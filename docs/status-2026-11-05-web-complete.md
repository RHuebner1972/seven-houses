# Seventh House — Status: Plan 2 (web) complete

**Date:** 2026-11-05
**Repo:** github.com/RHuebner1972/seven-houses — `main` at 5852b5b (merge of `feature/web`)
**Tests:** 198 Vitest + 3 Playwright E2E passing; `eslint`, `tsc --noEmit`, `next build` (10 static routes) clean; CI at `.github/workflows/web.yml`
**Plan:** `docs/superpowers/plans/2026-11-03-seventh-house-web.md` — 14 tasks, each implemented and reviewed by separate agents, then a whole-branch review and one fix wave

## What shipped

Next.js 16 static export under `web/` (see `web/README.md` for env vars, scripts, Vercel setup, deck replacement, Capacitor hand-off):

- **Shell:** App Router, `output: "export"`, trailing slashes, `?id=` detail routes (no dynamic segments — Capacitor-ready). Tailwind v4 theme tokens (indigo/gold/parchment), Cormorant Garamond + Inter, six-link nav with mobile tab bar, disclaimer footer.
- **Auth:** anonymous JWT minted on first load (`sh.token` in localStorage behind a `TokenStore` seam); Google Identity Services button; magic-link request + device-bound landing page (`/auth/magic/?token=`); proactive `/auth/refresh` when a token is >7 days old (30-day TTL); a signed-in user whose token is rejected gets a "Your session ended — sign in to restore your readings" toast instead of a silent downgrade.
- **Today:** free daily card with flip, streamed interpretation, per-user per-local-day cache, 409 polling, restart of a failed daily.
- **Birth chart:** form with debounced OpenCage geocode combobox → `POST /profiles` → SVG chart wheel (Whole Sign houses rotated to the Ascendant, planet glyphs with collision nudging, AC/MC ticks, aspect lines by kind) + readable placements list.
- **New reading:** spread picker with live credit prices, 500-char question, "Read through my chart" toggle (`?profile=` aware), Celtic Cross cross-and-staff layout and 3-card row, 600 ms reveal cadence (instant under reduced motion), 402 → Store prompt, 429 copy, SSE `error` → Retry via `/readings/{id}/retry`, abort-on-navigate with "saving to your journal" toast, balance refetched after every terminal stream event (so refunds show).
- **Journal:** newest-first list with status badges, 3 face-up thumbnails, client search; detail page with full spread, paragraphs, pending-poll and failed-retry.
- **Store:** `BillingProvider` interface with `@revenuecat/purchases-js` (lazy-loaded) and a mock; anonymous buyers are sent to sign in first; purchase baseline taken from a fresh `/me`; `PaymentPending` treated as paid; `/me` polled 2 s × 30 s then a calm "still processing" note; production builds without a RevenueCat key show "Store unavailable" rather than a fake store.
- **Account:** email/anonymous state, sign in/out (anon sign-out warns about data loss), profile delete with inline confirm, type-DELETE account deletion → `DELETE /account` → fresh anonymous session.
- **PWA:** manifest, generated seven-pointed-star icons (192/512/maskable/apple-touch), hand-written service worker with a per-build cache name (stamped from `VERCEL_GIT_COMMIT_SHA`), cache-first for deck + hashed chunks, network-first navigations, API never cached, skipped inside Capacitor.
- **Tests:** MSW-backed component/hook tests for every page; `node:vm` tests for the service worker's routing; Playwright money-path E2E (daily, chart-informed Celtic Cross → journal, anonymous → sign-in → purchase → webhook) against route mocks — deterministic, no API or Anthropic spend.

## Owner actions before real users

1. **Vercel web project**: root directory `web/`, framework Next.js (static export → `out/`). Env: `NEXT_PUBLIC_API_URL` (the API deployment origin), `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_RC_WEB_KEY`; leave `NEXT_PUBLIC_BILLING` unset (never `mock` in production).
2. **API env**: `CORS_ORIGINS` must include the web origin (and `https://localhost` for the Capacitor WebView in Plan 3); `APP_BASE_URL` = web origin so magic links point at the web app.
3. **Google Cloud**: authorise the web origin as a JavaScript origin on the OAuth web client.
4. **RevenueCat**: a Web Billing app with products whose identifiers end in `_credits_N` (e.g. `sh_credits_5`); the API's `CREDIT_PRODUCTS` must map the same ids.
5. **Deck art**: replace `web/public/deck/<card id>.webp` (1024×1536) and `back.webp` 1:1; ids are in `web/src/data/cards.json`. The `card-generator/` script you added produces these.
6. Smoke on the deployed site: Today card streams; new chart; a 1-credit reading 402s at balance 0; Store shows real packages when signed in.

## Backlog (known, deliberately deferred)

**Should land in the first follow-up PR**
- Session-expired toast can fire right after "Account deleted" if a signed-in request 401s during the sign-out window (`providers.tsx` — add a `leaving` ref in `signOut`).
- API magic link URL lacks the trailing slash (`/auth/magic?token=`); Vercel redirects, plain static hosts may not (`api/app/auth/magic.py`).
- `verifyMagic`/`signInWithGoogle` use `invalidateQueries`; inactive cached queries for the old anonymous user survive (prefer `cancelQueries` + `clear`, or user-scoped query keys).
- "Check again" on a stalled pending reading doesn't re-arm the 2-minute poll cap; `useReading` spreads the tracked query result (extra re-renders).
- Begin button is enabled on `/reading/new` while profiles are still loading (chart-less reading possible for a fast click).

**Nice to have**
- Chart wheel: wrap-around nudging for 3+ bodies straddling the Descendant; one-directional push can cross a sign cusp for 4-planet clusters; `--color-aspect-hard/soft` tokens are hex fallbacks; sign/degree recomputed from longitude rather than the API fields.
- Service worker: dedicated `/offline/` page instead of serving the home shell for uncached routes; update toast only sampled at mount.
- Store: `role=status` regions mounted on demand (use one persistent live region); `revenuecat.ts` has no unit tests; double-click test doesn't exercise the `inFlight` guard.
- E2E: assert `spread_type` in the reading spec; mock `POST /profiles` should 422 like the API; add a 402 spec.
- Position meanings are hover-only (`title`); add an sr-only description.
- Web CI's path filter ignores `api/data/cards.json`; the `sync-cards` equality test catches drift on the next web push.

**Plan 3 (Capacitor Android) must address**
- Google sign-in in a WebView needs native Google auth (GIS requires an authorised https origin).
- In-app purchases must use `purchases-capacitor` / Play Billing — the web RevenueCat/Stripe flow inside a Play WebView violates Play policy. The `BillingProvider` seam exists for this.
- Token storage should move to Capacitor Preferences (the `TokenStore` seam exists).
- Service worker is already skipped under `Capacitor.isNativePlatform()`.

## Next

Plan 3 of 3: Capacitor Android wrapper, native auth + billing providers, Play Console listing and submission. The organization developer account (D-U-N-S) remains the long pole.
