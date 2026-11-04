# Seventh House Web Frontend Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Next.js web app (static export) that consumes the Seventh House API: daily card, birth chart entry and wheel, chart-informed tarot readings streamed over SSE, journal, credit store, and account — the same bundle Plan 3 wraps with Capacitor.

**Architecture:** Next.js App Router with `output: 'export'`; every page is a client component that talks only to the API over HTTPS with a bearer JWT. No server components fetch at request time, no API routes, no middleware, no dynamic route segments (detail pages use `?id=`), so the export is Capacitor-ready. A thin `lib/api` layer owns fetch + SSE; TanStack Query caches `/me`, profiles, spreads, and readings; a `BillingProvider` interface isolates RevenueCat so tests and Android can swap it.

**Tech Stack:** Next.js 15 (App Router, TypeScript, static export), React 19, Tailwind CSS v4, TanStack Query v5, `@revenuecat/purchases-js`, Google Identity Services (script tag), Vitest + React Testing Library + MSW (unit/component), Playwright (E2E with route mocks), `sharp` (build-time placeholder deck), `next/font` (Cormorant Garamond display, Inter body).

**Spec:** `docs/superpowers/specs/2026-11-02-seventh-house-design.md` (§6 Frontend, §3.1, §7, §8)

## Global Constraints

- `web/` is its own Vercel project; `next.config.ts` has `output: 'export'`, `images: { unoptimized: true }`, `trailingSlash: true` (Capacitor serves `index.html` per folder).
- The client is untrusted: never call Anthropic, never compute balances, never trust local credit state — always re-read `/me`.
- API base URL from `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`). All requests send `Authorization: Bearer <jwt>`; a 401 clears the token and re-bootstraps an anonymous session.
- API contract (from `api/`): `POST /auth/anonymous` → 201 `{token, user_id}`; `POST /auth/refresh` → `{token}`; `GET /me` → `{user_id, email, anon, balance}`; `POST /auth/google {id_token}` → `{token, user_id}`; `POST /auth/magic/request {email}` → 202; `POST /auth/magic/verify {token}` (optional bearer) → `{token, user_id}`; `DELETE /account` → 204; `GET /geocode?q=` → `[{label, lat, lon, tz}]`; `POST /profiles {name, birth_date, birth_time|null, tz, lat, lon, place_label}` → 201 `{profile, chart}`; `GET /profiles` → `{profiles: [...]}`; `GET /profiles/{id}` → `{profile, chart}`; `DELETE /profiles/{id}` → 204; `GET /spreads` → `[{type, name, credits, positions:[{key,name,meaning}]}]`; `POST /readings {spread_type, question?, profile_id?}` → SSE; `POST /readings/{id}/retry` → SSE; `GET /readings?limit=` → list with `excerpt`; `GET /readings/{id}` → `{id, spread_type, cards:[{position, card_id, reversed}], question, chart_id, text, status, created_at}`; `POST /daily {tz}` → SSE or 200 `{reading}` or 409 `generation_in_progress`.
- SSE events: `cards` `{reading_id, cost, cards}`, `delta` `{text}`, `done` `{reading_id}`, `error` `{code, message}`. Frames are `event: <name>\ndata: <json>\n\n`.
- Error envelope: `{"error": {"code", "message"}}`; codes used by the UI: `insufficient_credits` (402), `generation_in_progress` (409), `rate_limited` (429), `validation_failed` (422), `unauthorized` (401), `not_found` (404).
- Profile shape: `{id, name, birth_date "YYYY-MM-DD", birth_time "HH:MM"|null, tz, lat, lon, place_label, time_known, created_at}`. Chart shape: `{engine_version, time_known, planets: {sun|moon|mercury|venus|mars|jupiter|saturn|uranus|neptune|pluto|north_node: {longitude, sign, degree, house|null, retrograde}}, ascendant|null, mc|null, aspects: [{a, b, kind, orb}], houses_unavailable_reason: "unknown_time"|"polar_latitude"|null}`.
- Card ids: `major-00-fool` … `major-21-world`, `{suit}-01`…`{suit}-10`, `{suit}-11-page|12-knight|13-queen|14-king`; image path `/deck/{id}.webp`; card back `/deck/back.webp`. Catalogue copied from `api/app/tarot/data/cards.json`.
- Spread types and default costs: `daily` 0, `three_card` 1, `celtic_cross` 3 (always display the cost returned by `GET /spreads`, never a hard-coded value).
- Visual direction (spec §6.3): dark field `#0B0B1F` → `#05050C`, gold `#C9A84C` (accent) / `#E8D5A3` (highlight), parchment text `#F2EBDD`, muted `#9A94B3`; serif display (Cormorant Garamond), humanist sans body (Inter); card art is the hero.
- Fixed copy: every reading already ends with `For reflection and entertainment.` from the API — do not append it again. Footer on every page: "Seventh House is for reflection and entertainment. It is not medical, legal, or financial advice."
- Timezone for the daily card: `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Accessibility: every interactive element keyboard-reachable; card images carry `alt` = card name + orientation; `prefers-reduced-motion` disables flip/shuffle animations.
- Tests run with `npm test` (Vitest, jsdom) and `npm run e2e` (Playwright against `next dev` with route mocks); `npm run lint` (ESLint) and `npm run typecheck` (tsc) must pass.

## Review Focus

1. **SSE frames split across network chunks** (a `data:` line arriving in two reads, or two events in one read) — the parser must reassemble by the blank-line delimiter, never by read boundary. Test in Task 2.
2. **Token expiry or deletion mid-session** — any 401 must silently mint a new anonymous session and retry once; the user must never see a dead screen. Test in Task 3.
3. **Pressing Back or closing the tab mid-stream** — the client aborts the fetch; the UI must not show the reading as complete, and the journal must show whatever the server persisted (complete, per the API's drain policy). Test in Task 8.
4. **Daily card across midnight and across a timezone change** — the Today page must re-request when the local date changes and must handle 409 by polling `GET /readings/{id}` until complete. Test in Task 5.
5. **Purchase completes but the webhook is slow** — after `purchase()` resolves, poll `/me` every 2 s for up to 30 s showing "Processing…", then show the new balance or a "still processing" note; never show an error for a successful charge. Test in Task 10.

---

## File Structure

```
web/
  package.json, next.config.ts, tsconfig.json, postcss.config.mjs, eslint.config.mjs
  vitest.config.ts, vitest.setup.ts, playwright.config.ts
  public/
    deck/                     # 78 + back .webp (placeholders generated by script; real art drops in)
    manifest.webmanifest, icons/
  scripts/
    sync-cards.mjs            # copies ../api/app/tarot/data/cards.json → src/data/cards.json
    make-placeholder-deck.mjs # renders 79 SVG → WebP via sharp
  src/
    app/
      layout.tsx              # fonts, providers, nav shell, footer
      globals.css             # tokens + Tailwind
      page.tsx                # Today (daily card)
      chart/page.tsx          # profiles list + wheel
      chart/new/page.tsx      # birth data form
      reading/new/page.tsx    # spread picker → stream
      reading/page.tsx        # ?id= detail
      journal/page.tsx
      store/page.tsx
      account/page.tsx
      auth/magic/page.tsx     # ?token= landing
    lib/
      api.ts                  # typed client: every endpoint
      sse.ts                  # parseSse(stream) async generator
      auth.ts                 # token storage adapter + bootstrap/refresh
      errors.ts               # ApiError, isCode()
      tz.ts                   # localTimeZone()
      cards.ts                # catalogue lookup, imageUrl(id), placeholder fallback
    data/cards.json
    components/
      providers.tsx           # QueryClient + AuthProvider + BillingProvider
      nav.tsx, balance-pill.tsx, footer.tsx
      card.tsx                # flip + reversed + fallback image
      card-fan.tsx            # shuffle + sequential reveal
      reading-stream.tsx      # consumes SSE → cards/delta/done/error UI
      chart-wheel.tsx         # SVG wheel
      placements.tsx          # plain-English chart summary
      geocode-search.tsx
      sign-in-sheet.tsx       # Google + magic link
    billing/
      provider.ts             # BillingProvider interface
      revenuecat.ts           # purchases-js implementation
      mock.ts                 # deterministic implementation for tests/dev
    hooks/
      use-me.ts, use-profiles.ts, use-spreads.ts, use-readings.ts, use-daily.ts
  tests/                      # vitest: mirrors src/
  e2e/                        # playwright: daily.spec.ts, purchase.spec.ts, reading.spec.ts, mocks/api.ts
```

---

### Task 1: Scaffold, theme, shell

**Files:**
- Create: `web/package.json`, `web/next.config.ts`, `web/tsconfig.json`, `web/postcss.config.mjs`, `web/eslint.config.mjs`, `web/vitest.config.ts`, `web/vitest.setup.ts`, `web/src/app/layout.tsx`, `web/src/app/globals.css`, `web/src/app/page.tsx` (placeholder), `web/src/components/nav.tsx`, `web/src/components/footer.tsx`, `web/tests/shell.test.tsx`, `web/.gitignore`, `web/README.md`

**Interfaces:**
- Produces: CSS variables `--bg`, `--bg-deep`, `--gold`, `--gold-hi`, `--ink`, `--muted` with the Global Constraints values, exposed as Tailwind theme colors `bg`, `bg-deep`, `gold`, `gold-hi`, `ink`, `muted`; `<Nav />` with links Today `/`, Chart `/chart/`, Reading `/reading/new/`, Journal `/journal/`, Store `/store/`, Account `/account/`; `<Footer />` with the fixed disclaimer; `layout.tsx` applying `next/font` Cormorant Garamond (`--font-display`) and Inter (`--font-body`).

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/shell.test.tsx
test("nav renders the six primary links", () => {
  render(<Nav />);
  for (const name of ["Today", "Chart", "Reading", "Journal", "Store", "Account"])
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
});
test("footer carries the disclaimer", () => {
  render(<Footer />);
  expect(screen.getByText(/not medical, legal, or financial advice/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail** — `cd web && npm test` → FAIL (modules missing)
- [ ] **Step 3: Scaffold** — `npx create-next-app@latest web --ts --app --tailwind --eslint --src-dir --no-import-alias` then set `output: 'export'`, `images.unoptimized`, `trailingSlash`; add vitest + `@testing-library/react` + `@testing-library/jest-dom` + jsdom; tokens in `globals.css` via `@theme`; `npm run typecheck` script = `tsc --noEmit`.
- [ ] **Step 4: Run tests to verify they pass** — `npm test` → PASS; `npm run build` produces `out/index.html`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): scaffold Next.js static export with theme and shell"`

---

### Task 2: API client and SSE parser

**Files:**
- Create: `web/src/lib/errors.ts`, `web/src/lib/sse.ts`, `web/src/lib/api.ts`, `web/src/lib/types.ts`, `web/tests/sse.test.ts`, `web/tests/api.test.ts`

**Interfaces:**
- Produces: `types.ts` — `Me`, `Profile`, `Chart`, `Placement`, `Aspect`, `Spread`, `Reading`, `ReadingSummary`, `DrawnCard`, `Place`, `SseEvent = {event:"cards",data:{reading_id,cost,cards:DrawnCard[]}} | {event:"delta",data:{text}} | {event:"done",data:{reading_id}} | {event:"error",data:{code,message}}`. `errors.ts` — `class ApiError extends Error { status: number; code: string }`, `isCode(e, code)`. `sse.ts` — `async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>`. `api.ts` — `createApi(getToken: () => string | null, onUnauthorized: () => Promise<string>)` returning `{ anonymous(), refresh(), me(), google(idToken), magicRequest(email), magicVerify(token), deleteAccount(), geocode(q), createProfile(body), profiles(), profile(id), deleteProfile(id), spreads(), readings(limit?), reading(id), startReading(body, signal): Promise<ReadableStream>, retryReading(id, signal), daily(tz, signal): Promise<{kind:"stream", body} | {kind:"reading", reading}> }`. Non-2xx → `ApiError` from the envelope. A 401 on any authenticated call invokes `onUnauthorized()` once and retries with the new token.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sse.test.ts
test("reassembles events split across chunks", async () => {
  const chunks = ['event: cards\ndata: {"reading_id":"r1","cost":1,"ca', 'rds":[]}\n\nevent: delta\ndata: {"text":"Hi"}\n\nevent: do', 'ne\ndata: {"reading_id":"r1"}\n\n'];
  const events = await collect(parseSse(streamOf(chunks)));
  expect(events.map(e => e.event)).toEqual(["cards", "delta", "done"]);
  expect(events[1].data).toEqual({ text: "Hi" });
});
test("ignores comment and blank keep-alive lines", async () => {
  const events = await collect(parseSse(streamOf([": ping\n\n", "event: done\ndata: {\"reading_id\":\"r\"}\n\n"])));
  expect(events).toHaveLength(1);
});
// tests/api.test.ts (MSW)
test("maps error envelope to ApiError", async () => {
  server.use(http.post("*/readings", () => HttpResponse.json({ error: { code: "insufficient_credits", message: "x" } }, { status: 402 })));
  await expect(api.startReading({ spread_type: "three_card" })).rejects.toMatchObject({ status: 402, code: "insufficient_credits" });
});
test("retries once after 401 with a fresh token", async () => {
  // first /me → 401, onUnauthorized returns "t2", second /me → 200 with Authorization "Bearer t2"
});
test("daily returns kind reading for JSON and kind stream for text/event-stream", async () => { /* two MSW handlers by content-type */ });
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement** — `parseSse` buffers text with `TextDecoder({stream:true})`, splits on `\n\n`, parses `event:`/`data:` lines, ignores lines starting with `:`. `api.ts` uses `fetch` with `Accept: text/event-stream` for stream endpoints and returns `res.body` after checking status (402/409 arrive as JSON before any stream).
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): typed API client and SSE parser"`

---

### Task 3: Auth bootstrap and token storage

**Files:**
- Create: `web/src/lib/auth.ts`, `web/src/components/providers.tsx`, `web/src/hooks/use-me.ts`, `web/src/components/balance-pill.tsx`, `web/tests/auth.test.tsx`
- Modify: `web/src/app/layout.tsx` (wrap in `<Providers>`), `web/src/components/nav.tsx` (show `<BalancePill />`)

**Interfaces:**
- Produces: `TokenStore { get(): string|null; set(t: string): void; clear(): void }` with `localStorageTokenStore` (key `sh.token`) — Plan 3 adds a Capacitor Preferences store behind the same interface. `AuthProvider` bootstraps: if no token → `POST /auth/anonymous`; exposes `useAuth(): { token, userId, ready, signInWithGoogle(idToken), verifyMagic(token), signOut() }` where `signOut()` clears the token and mints a new anonymous session. `onUnauthorized` (from Task 2) = clear + anonymous + return new token. `useMe()` = TanStack Query on `GET /me` (staleTime 10 s), invalidated after purchases, readings, sign-in. `<BalancePill />` shows `balance` with a coin glyph; shows "—" while loading.

- [ ] **Step 1: Write the failing tests**

```tsx
test("mints an anonymous session on first load", async () => {
  // MSW: POST /auth/anonymous → {token:"t1", user_id:"u1"}; GET /me → {balance: 0, anon: true}
  render(<Providers><BalancePill /></Providers>);
  await waitFor(() => expect(localStorage.getItem("sh.token")).toBe("t1"));
  expect(await screen.findByText("0")).toBeInTheDocument();
});
test("recovers from a 401 by re-bootstrapping", async () => {
  localStorage.setItem("sh.token", "dead");
  // GET /me with Bearer dead → 401; POST /auth/anonymous → t2; GET /me with t2 → {balance: 3}
  render(<Providers><BalancePill /></Providers>);
  expect(await screen.findByText("3")).toBeInTheDocument();
  expect(localStorage.getItem("sh.token")).toBe("t2");
});
test("signOut clears the token and mints a new anonymous one", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement auth.ts, providers.tsx (QueryClientProvider + AuthProvider + BillingProvider placeholder), use-me.ts, balance-pill.tsx**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): anonymous auth bootstrap, token store, balance pill"`

---

### Task 4: Card catalogue, placeholder deck, Card component

**Files:**
- Create: `web/scripts/sync-cards.mjs`, `web/scripts/make-placeholder-deck.mjs`, `web/src/data/cards.json`, `web/public/deck/*.webp` (79 files), `web/src/lib/cards.ts`, `web/src/components/card.tsx`, `web/tests/cards.test.ts`, `web/tests/card.test.tsx`
- Modify: `web/package.json` (scripts `sync-cards`, `placeholder-deck`; `prebuild` runs `sync-cards` when `../api` exists)

**Interfaces:**
- Produces: `cards.ts` — `CARDS: CardMeta[]`, `cardById(id): CardMeta`, `imageUrl(id): string` (= `/deck/${id}.webp`), `BACK_URL = "/deck/back.webp"`. `<Card id reversed faceUp onFlip? size="sm"|"md"|"lg" />` renders the back when `!faceUp`, flips with a CSS 3D transform (disabled under `prefers-reduced-motion`), rotates 180° when `reversed`, `alt` = `"{name}, reversed"` or `"{name}, upright"`, and falls back to a styled text face if the image 404s (`onError`).
- Placeholder deck: each card is a 1024×1536 WebP rendered from SVG — dark field, gold border, suit glyph (🜂 wands / 🜄 cups / 🜁 swords / 🜃 pentacles as simple drawn shapes, not emoji), roman numeral or court title, card name in the display face; the back is a gold star-field pattern. Real art replaces these files 1:1.

- [ ] **Step 1: Write the failing tests**

```ts
test("catalogue matches the API copy when present", () => {
  const apiPath = path.resolve(__dirname, "../../api/app/tarot/data/cards.json");
  if (!fs.existsSync(apiPath)) return;
  expect(JSON.parse(fs.readFileSync(apiPath, "utf8"))).toEqual(CARDS);
});
test("78 cards, image urls, lookup", () => {
  expect(CARDS).toHaveLength(78);
  expect(imageUrl("cups-11-page")).toBe("/deck/cups-11-page.webp");
  expect(cardById("major-00-fool").name).toBe("The Fool");
});
test("every catalogue image exists in public/deck", () => {
  for (const c of CARDS) expect(fs.existsSync(path.join("public", c.image))).toBe(true);
  expect(fs.existsSync("public/deck/back.webp")).toBe(true);
});
// card.test.tsx
test("face-down shows the back; face-up reversed shows rotated alt text", () => { /* alt contains ", reversed"; style transform includes rotate(180deg) */ });
test("falls back to a text face when the image errors", () => { /* fireEvent.error(img) → card name visible */ });
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement scripts (run them once, commit outputs), cards.ts, card.tsx**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): card catalogue, placeholder deck, Card component"`

---

### Task 5: Today page — daily card

**Files:**
- Create: `web/src/lib/tz.ts`, `web/src/hooks/use-daily.ts`, `web/src/components/reading-stream.tsx`, `web/src/app/page.tsx`, `web/tests/today.test.tsx`

**Interfaces:**
- Produces: `localTimeZone(): string`. `<ReadingStream source={() => Promise<ReadableStream>} onCards onDone onError />` — generic consumer rendering streamed text progressively (paragraphs split on blank lines), a blinking caret while streaming, an inline error with a Retry button on `error`; exposes the `AbortController` so unmount aborts the fetch. `useDaily()` — on mount calls `api.daily(tz)`: `kind:"reading"` → show it; `kind:"stream"` → `<ReadingStream>`; 409 `generation_in_progress` → poll `GET /readings/{id}`… (the 409 body has no id; instead poll `GET /readings?limit=1` for today's daily every 2 s up to 60 s, then show "Still preparing your card…" with a Retry). Caches the last complete daily reading in `localStorage` key `sh.lastDaily` (`{localDate, reading}`) so the page renders instantly offline; re-requests when `localDate !== today`.
- Today page: hero `<Card>` face-down; tap/click or Enter flips it, which triggers the daily request; text streams below; a "Deeper reading" CTA links to `/reading/new/`.

- [ ] **Step 1: Write the failing tests**

```tsx
test("tap flips the card and streams today's reading", async () => {
  // MSW: POST /daily → text/event-stream with cards(major-00-fool, upright) / delta "Welcome" / done
  render(<Providers><TodayPage /></Providers>);
  fireEvent.click(await screen.findByRole("button", { name: /reveal/i }));
  expect(await screen.findByAltText("The Fool, upright")).toBeInTheDocument();
  expect(await screen.findByText(/Welcome/)).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("sh.lastDaily")!).reading.text).toMatch(/Welcome/);
});
test("existing complete daily renders without streaming", async () => { /* POST /daily → 200 {reading} */ });
test("409 polls the journal until complete", async () => { /* POST /daily → 409; GET /readings?limit=1 → pending then complete */ });
test("a new local date invalidates the cached daily", async () => { /* seed sh.lastDaily with yesterday's localDate; expect POST /daily called */ });
test("sends the browser time zone", async () => { /* assert body.tz === Intl.DateTimeFormat().resolvedOptions().timeZone */ });
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement tz.ts, reading-stream.tsx, use-daily.ts, page.tsx**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): Today page with daily card stream"`

---

### Task 6: Birth data form and profile creation

**Files:**
- Create: `web/src/components/geocode-search.tsx`, `web/src/hooks/use-profiles.ts`, `web/src/app/chart/new/page.tsx`, `web/tests/chart-new.test.tsx`

**Interfaces:**
- Produces: `<GeocodeSearch onSelect(place: Place) />` — debounced (300 ms) `GET /geocode?q=` after 2 chars, listbox of results with keyboard navigation, shows `label`. `useProfiles()` — query `GET /profiles`; `useCreateProfile()` — mutation `POST /profiles` invalidating profiles. Form fields: name (required, ≤ 80), birth date (native `<input type=date>`, min 1850-01-01, max today), birth time (`<input type=time>`) with an "I don't know my birth time" checkbox that disables it and submits `null`, place via `<GeocodeSearch>` (sets `lat`, `lon`, `tz`, `place_label`), a read-only "Time zone: America/New_York" line once a place is chosen. Submit → on 201 navigate to `/chart/?id=<profile.id>`; 422 → show the API message under the form.

- [ ] **Step 1: Write the failing tests**

```tsx
test("searching a place and submitting creates a profile", async () => {
  // MSW: GET /geocode?q=Hull → [{label:"Hull, MA, USA", lat:42.3, lon:-70.91, tz:"America/New_York"}]; POST /profiles → 201
  // type name, date 1990-05-15, time 09:15, type "Hull", pick result, submit
  // assert POST body equals {name, birth_date:"1990-05-15", birth_time:"09:15", tz:"America/New_York", lat:42.3, lon:-70.91, place_label:"Hull, MA, USA"}
});
test("unknown birth time submits null and disables the time input", async () => { /* ... */ });
test("422 from the API is shown inline", async () => { /* POST /profiles → 422 {error:{message:"birth_date: too early"}} */ });
test("submit is disabled until a place is chosen", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement geocode-search.tsx, use-profiles.ts, chart/new/page.tsx**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): birth data form with geocoding"`

---

### Task 7: Chart wheel and placements

**Files:**
- Create: `web/src/components/chart-wheel.tsx`, `web/src/components/placements.tsx`, `web/src/app/chart/page.tsx`, `web/tests/chart-wheel.test.tsx`, `web/tests/chart-page.test.tsx`

**Interfaces:**
- Produces: `<ChartWheel chart={Chart} size={number} />` — pure SVG, `viewBox 0 0 1000 1000`: outer ring with 12 sign segments (glyphs ♈♉♊♋♌♍♎♏♐♑♒♓, Aries at the 9 o'clock position when no Ascendant; when `ascendant` exists, rotate so the Ascendant's sign cusp is at 9 o'clock — Whole Sign houses coincide with sign segments, numbered 1–12 counter-clockwise from the Ascendant sign), planet glyphs (☉ ☽ ☿ ♀ ♂ ♃ ♄ ♅ ♆ ♇ ☊) at their longitudes with simple collision nudging (≥ 6° apart), an "AC" and "MC" tick when present, and aspect lines between planet points colored by kind (conjunction gold, opposition/square muted red, trine/sextile muted blue), `aria-label` summarising sun/moon/ascendant. Longitude → angle: `angle = 180 - (lon - rotation)` degrees (zodiac runs counter-clockwise). `<Placements chart />` — list "Sun in Taurus 24°, 10th house (retrograde)" per planet in BODIES order, Ascendant/MC lines when present, an aspects list, and a note when `houses_unavailable_reason` is set ("Houses need a birth time" / "Houses aren't computed this far north/south").
- Chart page: `?id=` → `GET /profiles/{id}` → wheel + placements + "Use for readings" link to `/reading/new/?profile=<id>`; without `?id=` → list of profiles (name, place, date) with a "New chart" button; empty state explains why a chart helps.

- [ ] **Step 1: Write the failing tests**

```tsx
test("places the Sun glyph at its longitude and rotates for the Ascendant", () => {
  const chart = fixtureChart({ sun: 54.3 /* Taurus */, ascendant: 110 /* Cancer */ });
  const { container } = render(<ChartWheel chart={chart} size={400} />);
  const sun = container.querySelector('[data-body="sun"]')!;
  // expected angle = 180 - (54.3 - 90) where rotation = start of Cancer (90°)
  expect(Number(sun.getAttribute("data-angle"))).toBeCloseTo(215.7, 1);
  expect(container.querySelectorAll('[data-house]')).toHaveLength(12);
});
test("no ascendant → no house numbers, Aries at 9 o'clock", () => { /* ... */ });
test("draws one aspect line per aspect", () => { /* fixture with 3 aspects → 3 <line data-aspect> */ });
test("placements list reads naturally and flags unknown time", () => {
  render(<Placements chart={fixtureChart({ houses_unavailable_reason: "unknown_time" })} />);
  expect(screen.getByText(/Houses need a birth time/)).toBeInTheDocument();
  expect(screen.getByText(/Sun in Taurus 24°/)).toBeInTheDocument();
});
// chart-page.test.tsx: list state, ?id= state, empty state
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement chart-wheel.tsx (expose `data-angle`, `data-body`, `data-house`, `data-aspect` attributes for tests), placements.tsx, chart/page.tsx**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): SVG chart wheel, placements, chart page"`

---

### Task 8: New reading flow

**Files:**
- Create: `web/src/hooks/use-spreads.ts`, `web/src/components/card-fan.tsx`, `web/src/app/reading/new/page.tsx`, `web/tests/reading-new.test.tsx`

**Interfaces:**
- Produces: `useSpreads()` — `GET /spreads` filtered to `type !== "daily"`. `<CardFan cards={DrawnCard[]} positions={Position[]} revealIndex={number} />` — lays out 3-card in a row and Celtic Cross in the classic cross+staff layout (positions: present center, challenge crossing it rotated 90°, past left, future right, above top, below bottom, then advice/external/hopes_fears/outcome as a vertical staff on the right), each slot labeled with the position name; cards flip face-up as `revealIndex` advances (one every 600 ms after `cards` arrives, instant under reduced motion). Page: spread picker (name, cost in credits, position count), optional question textarea (maxLength 500, counter), "Read through my chart" toggle (shown only when profiles exist; default on; chooses the first profile or the one from `?profile=`), cost line "Costs N credits · you have M"; Begin button → `api.startReading` → `<ReadingStream>` with `<CardFan>` above; 402 → inline "You need N credits" with a Store link; 429 → "Please wait a little before another reading"; `error` event → Retry calls `retryReading(id)`. Navigating away aborts the stream; a "Your reading is being saved to your journal" toast appears if aborted after the first delta.

- [ ] **Step 1: Write the failing tests**

```tsx
test("lists spreads with live costs and starts a chart-informed reading", async () => {
  // MSW: GET /spreads → three_card 1 credit, celtic_cross 3; GET /profiles → one profile p1; GET /me → balance 3
  // choose Celtic Cross, type question, Begin → assert POST /readings body {spread_type:"celtic_cross", question:"Should I…", profile_id:"p1"}
  // SSE cards (10) → 10 labeled slots; delta → text; done → "Saved to your journal"
});
test("402 shows the store prompt instead of a stream", async () => { /* POST /readings → 402 insufficient_credits */ });
test("error event offers retry which calls /readings/{id}/retry", async () => { /* ... */ });
test("unmount mid-stream aborts the request", async () => { /* spy on AbortController.abort via the fetch signal */ });
test("question is capped at 500 characters", async () => { /* textarea maxLength */ });
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement use-spreads.ts, card-fan.tsx, reading/new/page.tsx**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(web): new reading flow with spread layouts and streaming"`

---

### Task 9: Journal

**Files:**
- Create: `web/src/hooks/use-readings.ts`, `web/src/app/journal/page.tsx`, `web/src/app/reading/page.tsx`, `web/tests/journal.test.tsx`

**Interfaces:**
- Produces: `useReadings(limit=50)` — `GET /readings`; `useReading(id)` — `GET /readings/{id}`. Journal: newest first; each row shows date, spread name, up to 3 small face-up cards, excerpt, a status badge for `pending` ("Preparing…") and `failed` ("Didn't complete — retry"); a client-side search box filtering on excerpt/question. Detail (`/reading/?id=`): `<CardFan>` fully revealed, question, full text rendered as paragraphs, a Retry button when `failed` that streams via `retryReading`.

- [ ] **Step 1: Write the failing tests**

```tsx
test("lists readings newest first with status badges", async () => { /* 3 readings: complete, pending, failed → badges */ });
test("search filters by excerpt", async () => { /* ... */ });
test("detail renders cards, question, and paragraphs", async () => { /* GET /readings/r1 */ });
test("failed detail offers retry", async () => { /* click → POST /readings/r1/retry */ });
```

- [ ] **Step 2–5:** fail → implement → pass → `git commit -m "feat(web): journal list and reading detail"`

---

### Task 10: Store and billing provider

**Files:**
- Create: `web/src/billing/provider.ts`, `web/src/billing/revenuecat.ts`, `web/src/billing/mock.ts`, `web/src/components/sign-in-sheet.tsx` (shell only; Google/magic wiring in Task 11), `web/src/app/store/page.tsx`, `web/tests/store.test.tsx`
- Modify: `web/src/components/providers.tsx` (choose provider: `NEXT_PUBLIC_BILLING=mock|revenuecat`, default `revenuecat` when `NEXT_PUBLIC_RC_WEB_KEY` is set, else `mock`)

**Interfaces:**
- Produces: `interface BillingProvider { configure(appUserId: string): Promise<void>; packages(): Promise<Package[]>; purchase(pkg: Package): Promise<{ transactionId: string }>; }` with `Package = { id, productId, title, credits: number, priceString }`. `revenuecat.ts` uses `@revenuecat/purchases-js` (`Purchases.configure(key, appUserId)`, `getOfferings()` → current offering's packages, `purchase({ rcPackage })`); credits are parsed from `productId` suffix (`sh_credits_5` → 5). `mock.ts` returns three packages (5/15/40) and resolves purchases immediately. Store page: package cards; if `me.anon` → open `<SignInSheet>` first (purchases must attach to a signed-in account per spec §6.1); after `purchase()` resolves → "Processing…" and poll `/me` every 2 s up to 30 s until `balance` increases, then success; after 30 s show "Your purchase is being processed — credits will appear shortly" (no error).

- [ ] **Step 1: Write the failing tests**

```tsx
test("anonymous user is asked to sign in before buying", async () => { /* me.anon true → click Buy → sign-in sheet visible, purchase not called */ });
test("purchase then polls /me until balance rises", async () => {
  // me: anon false, balance 0 → mock purchase resolves → GET /me returns 0, 0, 5 → expect "5" and success copy
});
test("slow webhook shows processing note, not an error", async () => { /* /me stays 0; advance 30 s with fake timers */ });
test("packages render RevenueCat titles and prices", async () => { /* mock provider */ });
```

- [ ] **Step 2–5:** fail → implement → pass → `git commit -m "feat(web): store with billing provider abstraction"`

---

### Task 11: Account — sign-in, magic link landing, profiles, delete

**Files:**
- Create: `web/src/app/account/page.tsx`, `web/src/app/auth/magic/page.tsx`, `web/tests/account.test.tsx`, `web/tests/magic.test.tsx`
- Modify: `web/src/components/sign-in-sheet.tsx`, `web/src/lib/auth.ts`

**Interfaces:**
- Produces: `<SignInSheet open onClose />` — Google button via Google Identity Services (`<script src="https://accounts.google.com/gsi/client">` loaded once; `google.accounts.id.initialize({ client_id: NEXT_PUBLIC_GOOGLE_CLIENT_ID, callback })` → `api.google(credential)` → store token → invalidate `/me`); email field → `api.magicRequest(email)` → "Check your email" state (always, regardless of response). Magic landing `/auth/magic/?token=` → `api.magicVerify(token)` sending the current bearer (so the requesting device links its anonymous data) → store token → redirect `/account/`; missing/invalid token → "This link has expired. Request a new one." with a link to `/account/`. Account page: email or "Anonymous — sign in to keep your readings across devices", Sign in / Sign out, profiles list with delete (confirm), Delete account (type DELETE to confirm → `DELETE /account` → clear token → anonymous → `/`).

- [ ] **Step 1: Write the failing tests**

```tsx
test("magic landing verifies with the current bearer and stores the new token", async () => {
  localStorage.setItem("sh.token", "anon1");
  // MSW: POST /auth/magic/verify with Authorization "Bearer anon1" and body {token:"m1"} → {token:"t9", user_id:"u9"}
  render at /auth/magic/?token=m1 → expect localStorage sh.token === "t9" and redirect to /account/
});
test("magic landing without token shows expired copy", async () => { /* ... */ });
test("requesting a magic link always shows check-your-email", async () => { /* 202 and also 429 → same copy? no: 429 shows wait message */ });
test("delete account requires typing DELETE and then re-bootstraps anonymously", async () => { /* ... */ });
test("google credential is posted and /me refreshed", async () => { /* stub window.google */ });
```

- [ ] **Step 2–5:** fail → implement → pass → `git commit -m "feat(web): account page, Google and magic-link sign-in"`

---

### Task 12: Offline shell and PWA manifest

**Files:**
- Create: `web/public/manifest.webmanifest`, `web/public/icons/icon-192.png`, `web/public/icons/icon-512.png`, `web/public/sw.js`, `web/src/components/register-sw.tsx`, `web/tests/sw.test.ts`
- Modify: `web/src/app/layout.tsx` (manifest link, theme-color, `<RegisterSw />`)

**Interfaces:**
- Produces: `sw.js` — install: precache `/deck/back.webp` and the app shell (`/`, `/journal/`, `/chart/`); fetch: cache-first for `/deck/*` and `/_next/static/*`, network-first with cache fallback for navigations; never caches `/api` origins. `register-sw.tsx` registers only in production builds (`process.env.NODE_ENV === "production"`). Manifest: name "Seventh House", `display: standalone`, `background_color #0B0B1F`, `theme_color #0B0B1F`. Icons: generated gold seven-pointed star on indigo via the placeholder script (extend `make-placeholder-deck.mjs` or add `make-icons.mjs`).

- [ ] **Step 1: Write the failing test** — `sw.test.ts` loads `public/sw.js` text and asserts it lists `/deck/back.webp` in the precache array and contains no `localhost:8000`/API URL; `layout` test asserts `<link rel="manifest">`.
- [ ] **Step 2–5:** fail → implement → pass → `git commit -m "feat(web): offline shell, manifest, icons"`

---

### Task 13: Playwright E2E for the three money paths

**Files:**
- Create: `web/playwright.config.ts`, `web/e2e/mocks/api.ts`, `web/e2e/daily.spec.ts`, `web/e2e/reading.spec.ts`, `web/e2e/purchase.spec.ts`
- Modify: `web/package.json` (`e2e` script: `playwright test`; `webServer` runs `next dev -p 3100` with `NEXT_PUBLIC_API_URL=http://api.test`, `NEXT_PUBLIC_BILLING=mock`)

**Interfaces:**
- Produces: `mockApi(page)` installing `page.route("http://api.test/**", …)` handlers for every endpoint with an in-memory state (balance, readings) and an SSE responder that streams 3 deltas with 50 ms gaps. Specs: (1) daily — load `/`, click reveal, see a card and streamed text, reload → same card from cache without a new POST; (2) reading — create a profile via the form, start a chart-informed Celtic Cross, see 10 slots fill and text stream, open the journal and find it; (3) purchase — anonymous → Store → Buy → sign-in sheet → mock magic sign-in (`verify` route) → Buy → balance 0 → 5 after webhook simulation.

- [ ] **Step 1: Write the three specs (they fail without the mocks wired)**
- [ ] **Step 2: Run** — `npm run e2e` → FAIL
- [ ] **Step 3: Implement `mocks/api.ts` and config** (Chromium only; `npx playwright install chromium` is pre-installed in the sandbox — do not reinstall)
- [ ] **Step 4: Run** — `npm run e2e` → 3 passed
- [ ] **Step 5: Commit** — `git commit -m "test(web): playwright money-path e2e with API mocks"`

---

### Task 14: CI, lint, README, deploy config

**Files:**
- Create: `.github/workflows/web.yml`, `web/.env.example`
- Modify: `web/README.md`, root `README.md` (link both READMEs)

**Interfaces:**
- Produces: workflow on `push`/`pull_request` touching `web/**`: Node 22, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test -- --run`, `npm run build`, `npx playwright install --with-deps chromium` + `npm run e2e`. `.env.example` lists `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_RC_WEB_KEY`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_BILLING`. README: run locally against the API (`cd api && uvicorn app.main:app`), env vars, Vercel project root `web/` with framework Next.js and `CORS_ORIGINS` on the API set to the web origin, how to drop in the real deck art (`public/deck/<id>.webp`, 1024×1536), and the Capacitor hand-off (Plan 3): `npm run build` → `out/`.

- [ ] **Step 1: Write the workflow and docs; run `npm run lint && npm run typecheck && npm test -- --run && npm run build` locally** → all pass
- [ ] **Step 2: Commit** — `git commit -m "chore(web): CI workflow, env example, README"`

---

## Self-review notes

- **Spec coverage:** §6 screens Today/Birth chart/New reading/Journal/Store/Account → Tasks 5–11; §6.1 auth flow → Tasks 3, 11; §6.3 visual direction → Task 1; §6.4 deck placeholder → Task 4; §6.2 offline cache of deck and last daily → Tasks 5, 12; §7 error handling (402, 409, 429, slow webhook) → Tasks 5, 8, 10; §8 Playwright money paths → Task 13; §3.1 static export / Capacitor-ready → Tasks 1, 12. Android build and Play submission belong to Plan 3.
- **Type consistency:** `DrawnCard`, `Chart`, `Profile`, `Reading`, `Spread`, `Package`, `BillingProvider`, `ApiError`, `parseSse`, `createApi`, `TokenStore`, `useMe/useProfiles/useSpreads/useReadings/useDaily` are each defined once (Tasks 2, 3, 10) and reused by name.
- **Review Focus:** items 1–5 have tests in Tasks 2, 3, 8, 5, 10 respectively.
- **Decisions the spec left open, made here:** detail pages use `?id=` (static export); card catalogue is copied from `api/` with an equality test; placeholder deck rendered by script so real art replaces files 1:1; billing behind an interface with a mock for tests; Google sign-in via GIS script; E2E uses Playwright route mocks rather than a live API (deterministic, no Anthropic spend); service worker is hand-written and minimal.
- **Proportion:** ~1.5× the spec's frontend sections; code blocks are tests and signatures.
