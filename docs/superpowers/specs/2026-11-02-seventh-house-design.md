# Seventh House — Design Spec

**Date:** 2026-11-02
**Status:** Approved in conversation; awaiting written review
**Owner:** Rich Huebner (Nantasket Analytics, LLC)

## 1. Purpose

Seventh House is a tarot reading and birth chart app for Android and the web.
Its differentiator is a reading type that interprets a tarot spread through the
user's natal chart. Readings are AI-generated. A free daily card drives
retention; per-reading credits drive revenue.

**Audience:** daily-card casuals and serious astrology hobbyists.

**Success for v1:** live on Google Play and the web within a few weeks, with
daily card, 3-card and Celtic Cross spreads, natal chart, chart-informed
readings, and credit purchases working end to end on both platforms.

## 2. Decisions already made

| Area | Decision |
|---|---|
| Platforms | Android + web. No iOS in v1. |
| Monetization | Per-reading credit packs (consumables). Daily card is free. |
| Readings | AI-generated (Claude). Sonnet for paid spreads, Haiku for daily card. |
| Spreads | Daily (1 card), 3-card, Celtic Cross (10 positions). Reversals on. |
| Deck | One static, AI-generated 78-card deck + back, produced offline by Rich. No runtime image generation. |
| Chart depth | Planets (Sun–Pluto + Moon's mean node), Whole Sign houses, major aspects. Tropical zodiac. |
| Chart engine | Skyfield + JPL DE440s (MIT). Not Swiss Ephemeris. |
| Backend | Python / FastAPI on Vercel's Python runtime. |
| Frontend | Next.js (App Router, TypeScript), static export, wrapped with Capacitor for Android. |
| Database | Neon Postgres via Vercel marketplace. |
| Billing | RevenueCat: Capacitor SDK → Google Play Billing on Android; Web SDK → Stripe on web. |
| Identity | Anonymous-first. Sign-in (Google or email magic link) required only at first purchase or to sync devices. |
| Name | Seventh House (trademark and domain checks pending). |

## 3. Architecture

Two Vercel projects plus managed services. The client is untrusted: anything
involving money or model cost lives in the API.

```
┌──────────────────────┐        HTTPS + bearer JWT        ┌──────────────────────────┐
│  web/  (Next.js)     │ ───────────────────────────────▶ │  api/  (FastAPI, Python) │
│  static export       │ ◀──────────── SSE ─────────────  │  identity, chart engine, │
│  • Vercel (web)      │                                  │  readings, ledger,       │
│  • Capacitor (APK)   │                                  │  RevenueCat webhook      │
└──────────┬───────────┘                                  └─────┬──────────┬─────────┘
           │ RevenueCat SDK (same app-user id)                  │          │
           ▼                                                    ▼          ▼
   ┌───────────────┐   webhook (signed)   ┌──────────────┐  ┌─────────┐ ┌────────────┐
   │  RevenueCat   │ ───────────────────▶ │  api webhook │  │  Neon   │ │ Anthropic  │
   │ Play / Stripe │                      └──────────────┘  │Postgres │ │   API      │
   └───────────────┘                                        └─────────┘ └────────────┘
```

### 3.1 `web/` — Next.js
- `output: 'export'`; the same bundle deploys to Vercel and into Capacitor.
- Owns all UI: card flip/shuffle animation, SVG chart wheel, streamed reading
  display, credit store, journal, account.
- Talks only to `api/` over HTTPS with a bearer JWT. Never calls Anthropic or
  touches the ledger.
- Static deck assets (78 cards + back, WebP, 1024×1536) bundled in the app and
  served from the web CDN.

### 3.2 `api/` — FastAPI
Modules, each independently testable:

| Module | Responsibility | Depends on |
|---|---|---|
| `auth/` | Mint anonymous JWTs; link Google / magic-link identities to the same user id; verify tokens | DB |
| `astro/` | Pure functions: birth data → natal chart JSON | Skyfield, DE440s |
| `tarot/` | Spread definitions, card catalogue, server-side draw | — |
| `readings/` | Prompt builder, Claude streaming, reading persistence, refund-on-failure | `astro`, `tarot`, `ledger`, Anthropic |
| `ledger/` | Append-only credit ledger, atomic debit, idempotent credit | DB |
| `billing/` | RevenueCat webhook verification and product → credit mapping | `ledger` |
| `daily/` | Daily card issuance, one per user per local day | `readings`, DB |

### 3.3 Managed services
- **Neon Postgres** — all persistent state. Branch per preview deploy and per CI run.
- **RevenueCat** — one project, two apps (Play, Web Billing). Same product IDs and the same app-user id on both platforms. RevenueCat's anonymous ids are not used; the API's user id is passed to the SDK on every platform.
- **Anthropic API** — Claude Sonnet (paid spreads), Claude Haiku (daily card).
- **Geocoding** — birth-place search. A single provider behind a small interface so it can be swapped; results cached by query string.

## 4. Data model

```sql
users            (id uuid pk, email text null, auth_provider text null,
                  auth_subject text null, created_at timestamptz)
birth_profiles   (id uuid pk, user_id fk, name text, birth_datetime_utc timestamptz,
                  birth_tz text, lat double, lon double, place_label text,
                  time_known bool, created_at)
charts           (id uuid pk, birth_profile_id fk unique, data jsonb,
                  engine_version text, computed_at)
readings         (id uuid pk, user_id fk, spread_type text, cards jsonb,
                  question text null, chart_id fk null, text text,
                  model text, token_usage jsonb, status text, created_at)
credit_ledger    (id bigserial pk, user_id fk, delta int, reason text,
                  reference_id text unique, created_at)
daily_draws      (user_id fk, local_date date, card jsonb, reading_id fk,
                  primary key (user_id, local_date))
spread_prices    (spread_type text pk, credits int)
```

Rules:
- A user row is created on first launch (anonymous). Sign-in fills `email`,
  `auth_provider`, `auth_subject`. The id never changes, so RevenueCat and
  the ledger need no merge flow.
- `charts.data` holds planet longitudes, sign, Whole Sign house, Ascendant/MC
  (null when `time_known` is false), and aspects with orbs. Recomputed only
  when the profile changes or `engine_version` is bumped.
- Balance = `SUM(delta)` for the user. `reference_id` is the RevenueCat
  transaction id for purchases and the reading id for debits/refunds; the
  unique index makes webhook retries and double-submits idempotent.
- `spread_prices` is data, not code, so promos need no deploy.

### 4.1 The debit rule
A paid reading request runs one transaction:
1. `SELECT ... FOR UPDATE` the user row (serializes concurrent requests).
2. Check `balance >= spread_prices[spread_type]`; else 402.
3. Insert ledger row `delta = -cost, reason = 'reading', reference_id = reading_id`.
4. Insert the reading with `status = 'pending'` and the persisted draw.
5. Commit, then start generation.

If generation fails for any reason, insert `delta = +cost, reason = 'refund',
reference_id = reading_id + ':refund'` and set `status = 'failed'`. A user is
never charged for a reading they did not receive.

## 5. Reading pipeline

### 5.1 Chart engine (`astro/`)
Pure Python, no I/O after ephemeris load.
1. Local birth datetime + IANA tz → UTC → Julian date.
2. Skyfield with the bundled DE440s kernel → geocentric apparent ecliptic
   longitudes for Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus,
   Neptune, Pluto, and the Moon's mean north node.
3. Ascendant and MC from local sidereal time, mean obliquity, and latitude.
   Skipped when `time_known` is false.
4. Whole Sign houses: the Ascendant's sign is house 1; each following sign is
   the next house.
5. Aspects: conjunction 0°, opposition 180°, trine 120°, square 90°,
   sextile 60°. Orbs: 8° when the Sun or Moon is involved, 6° otherwise, 3°
   for sextiles.
6. Output: one JSON document (`charts.data`).

Out of scope: Chiron, asteroids, sidereal zodiac, other house systems,
transits, progressions, synastry.

### 5.2 Draw (`tarot/`)
- 78-card catalogue: id, name, arcana, suit/number, upright keywords,
  reversed keywords, image path. Keyword text is original, written once.
- Spread definitions: `daily` (1 position), `three_card` (past / present /
  future), `celtic_cross` (10 named positions with position meanings).
- Draw uses `secrets.SystemRandom` for the shuffle and a 50% reversal flip per
  card. The draw is persisted with the pending reading before generation, so a
  retry never re-draws.

### 5.3 Generation (`readings/`)
- Prompt builder assembles: system guardrails; spread and position meanings;
  drawn cards with orientation and keywords; the user's question if any; and,
  for chart-informed readings, the natal chart JSON plus weaving guidance
  (e.g. relate the *Self* position to Sun and Ascendant, *Hopes & Fears* to the
  Moon and 12th house, *Outcome* to the ruling planet of the Ascendant sign).
  When `time_known` is false the prompt states that houses and the Ascendant
  are unavailable and must not be invented.
- Claude is called with streaming. Chunks are relayed to the client over SSE
  and appended to `readings.text`. On completion `status = 'complete'` and
  `token_usage` is recorded. On error or timeout: `status = 'failed'`, refund.
- System prompt guardrails: readings are reflective, not predictive or
  deterministic; no medical, legal, financial, or pregnancy predictions; no
  claims about third parties; a fixed "for reflection and entertainment"
  footer. These matter for Google Play review.
- Models: `claude-sonnet-*` (current) for paid spreads, `claude-haiku-*` for the
  daily card. Model names live in config.

### 5.4 Daily card (`daily/`)
Same pipeline with the `daily` spread and the Haiku model, no debit. The
`daily_draws` primary key (user, local_date) is the only gate. The local date
is derived from the user's device tz sent with the request, bounded to a
valid IANA zone.

### 5.5 Cost
A chart-informed Celtic Cross is roughly 4–5k input / ~1.2k output tokens on
Sonnet — low single-digit cents. Daily cards on Haiku are fractions of a cent.
Credit pricing clears Play's 15% (first $1M/yr) comfortably.

## 6. Frontend

Mobile-first; identical layout on web.

| Screen | Behaviour |
|---|---|
| **Today** (home) | Daily card: tap to flip (CSS 3D), short reading streams in beneath. Credit balance in header. |
| **Birth chart** | Date, time (with "I don't know"), place search. Renders an SVG chart wheel (planets, signs, Whole Sign houses, aspect lines) and a plain-English placements summary. |
| **New reading** | Pick spread (3-card / Celtic Cross), optional question, "read through my chart" toggle (default on when a chart exists). Shows credit cost → shuffle animation → sequential reveal as text streams. |
| **Journal** | Past readings with cards shown; search by text. |
| **Store** | Credit packs. Web: RevenueCat Web SDK → Stripe Checkout. Android: RevenueCat Capacitor plugin → Play Billing. |
| **Account** | Google sign-in, email magic link, birth profiles, delete account (required by Play). |

### 6.1 Auth flow
1. First launch: client requests an anonymous JWT; API creates the user row.
   Token stored in Capacitor Preferences (Android) / localStorage (web).
2. Purchase attempt while anonymous → sign-in sheet. Google or magic link
   links the identity to the existing user id. Token is reissued; nothing else
   changes.
3. Magic link opens the app via a deep link on Android (`seventhhouse://auth`)
   and a normal URL on web.
4. RevenueCat SDK is configured with the API user id on every platform.

### 6.2 Android build
`next build` (static export) → `npx cap sync android` → Android Studio builds
the AAB. Native plugins: RevenueCat (`@revenuecat/purchases-capacitor`),
Preferences, Haptics, SplashScreen, StatusBar, App (deep links). The deck and
the last daily card are cached locally so the app opens instantly offline;
readings require connectivity and the UI says so.

### 6.3 Visual direction
Dark field (deep indigo → near-black), gold line work and accents, a serif
display face for headings, a humanist sans for body. Card art is the hero;
UI chrome stays quiet. A style guide (tokens, type scale, spacing, motion
timings) is part of the frontend implementation plan.

### 6.4 Deck
78 cards + 1 back, consistent style, delivered as 1024×1536 WebP under
`deck/`. Produced by Rich in parallel with the build. If art is late, the
Android build ships with a placeholder deck and the real one follows as an
update.

## 7. Error handling

- **Generation**: timeouts and model errors → `failed`, auto-refund, friendly
  retry. Partial streams are saved but never shown as complete.
- **Billing**: webhook signature verified; duplicate events are no-ops via the
  `reference_id` unique index. After a purchase the client polls balance for up
  to 30 s and shows "processing" until the webhook lands.
- **Chart input**: invalid place, future date, or out-of-range coordinates are
  rejected with field-level messages. Unknown birth time degrades gracefully.
- **Abuse**: per-user and per-IP rate limits on reading endpoints; anonymous
  users capped at one daily card per day and zero paid readings until a
  purchase exists.

## 8. Testing

- **Chart engine**: pytest against published reference charts for several
  well-known birth data, positions within 0.1°; aspect detection; Whole Sign
  assignment; unknown-time path.
- **Ledger**: concurrency test — two simultaneous reading requests with a
  balance of 1 produce exactly one debit and one reading.
- **Draw**: 78 unique cards, correct position count per spread, reversal rate
  ≈ 50% over many draws.
- **Prompt builder**: snapshot tests so prompt changes are deliberate.
- **API**: FastAPI TestClient against a throwaway Neon branch per CI run;
  Anthropic mocked.
- **Frontend**: Playwright on the three money paths — daily card, purchase
  (Stripe test mode on web, Play license testers on Android), chart-informed
  reading end to end.
- TDD throughout.

## 9. Deployment

- GitHub monorepo: `web/`, `api/`, `deck/`, `docs/`.
- Two Vercel projects auto-deploying from `main`; Neon branches for previews.
- Secrets in Vercel environment variables (Anthropic, RevenueCat webhook
  secret, JWT signing key, geocoding key, database URL).
- Android: signed locally with an upload key; Play App Signing holds the
  release key.

## 10. Launch sequence

1. **Now:** register a Google Play *organization* account under Nantasket
   Analytics, LLC (requires a D-U-N-S number; organization accounts are exempt
   from the 12-tester / 14-day closed-testing rule that applies to new personal
   accounts). Create Stripe account, RevenueCat project, Anthropic API key.
   Check "Seventh House" trademark and domain availability.
2. **Week 1:** API — auth, chart engine, ledger, billing webhook, readings.
3. **Week 2:** Frontend; web launch on Vercel.
4. **Week 3:** Capacitor build → Play internal testing → production review
   (allow up to a week for review).
5. Deck art by end of week 2, or placeholder deck ships first.

## 11. Out of scope for v1

iOS, transits, synastry, progressions, Chiron/asteroids, sidereal zodiac,
other house systems, custom spreads, social sharing, push notifications,
localization, subscriptions.

## 12. Open items (not blockers)

- Confirm current RevenueCat pricing tier and whether Web Billing is out of
  beta for consumables at build time; fall back to direct Stripe Checkout +
  webhook if not.
- Confirm current Play service fee for consumables under $1M/yr.
- Choose the geocoding provider (candidates: Mapbox, OpenCage, Google Places).
- Legal: terms, privacy policy, and "entertainment" disclaimer text.
