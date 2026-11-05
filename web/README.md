# Seventh House web

## Overview

Next.js 16 static export (`output: 'export'`, `trailingSlash: true`) + React 19 + Tailwind 4 +
TanStack Query, talking to the FastAPI backend in `../api`. The `out/` directory is served by
Vercel on the web and becomes the Capacitor `webDir` for Android (Plan 3).

## Run locally

API (see `../api/README.md` for the database and env setup):

```bash
cd api && uvicorn app.main:app --reload     # http://localhost:8000
```

Web:

```bash
cd web
cp .env.example .env.local                  # optional; defaults target http://localhost:8000 with mock billing
npm install
npm run dev                                 # http://localhost:3000
```

The API's default `CORS_ORIGINS` already includes `http://localhost:3000`.

Google sign-in needs the same OAuth **Web** client ID in `web/.env.local`
(`NEXT_PUBLIC_GOOGLE_CLIENT_ID`) and `api/.env` (`GOOGLE_CLIENT_ID`). Authorized
JavaScript origin in Google Cloud: `http://localhost:3000`. Restart `next dev`
after changing `NEXT_PUBLIC_*` values — they are inlined at startup.

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | API base URL, no trailing slash (default `http://localhost:8000`). In production, the origin of the API's Vercel deployment. |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth web client id for the sign-in button. Unset: the sheet shows "Google sign-in isn't configured" and only the magic link works. |
| `NEXT_PUBLIC_BILLING` | Billing backend: `mock` or `revenuecat`. Unset: `revenuecat` when `NEXT_PUBLIC_RC_WEB_KEY` is set, else `mock`. `revenuecat` without a key logs an error and degrades to `mock`. |
| `NEXT_PUBLIC_RC_WEB_KEY` | RevenueCat Web Billing public key. |

`.env.example` lists all four. All `NEXT_PUBLIC_*` values are inlined at build time; rebuild
(or redeploy) after changing them.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `next dev` on :3000 |
| `npm run build` | `prebuild` chain, then `next build` → static export in `out/` |
| `npm test` | vitest, single run (`npm run test:watch` to watch) |
| `npm run e2e` / `e2e:ui` | Playwright money-path specs (see [Testing](#testing)) |
| `npm run lint` | eslint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run placeholder-deck` | regenerate the placeholder deck in `public/deck/` |

`prebuild` runs automatically before `build`: `sync-cards` (copies `api/app/tarot/data/cards.json`
to `src/data/cards.json`) → `make-icons` (PWA icons to `public/icons/`) → `make-sw` (stamps a
build id into `public/sw.js` from `scripts/sw.src.js`). The build id is the first 8 chars of
`VERCEL_GIT_COMMIT_SHA` or `GITHUB_SHA` when set, otherwise time-based, so every deploy gets a
fresh service-worker cache. `public/sw.js` is generated and git-ignored.

## Deploy to Vercel

1. Create a Vercel project from the repo with **Root Directory** `web/` and framework **Next.js**.
   The build command is `npm run build`; the output is the static export in `out/` (Vercel
   detects `output: 'export'`).
2. Set the env vars above for Production (and Preview): `NEXT_PUBLIC_API_URL` = the API
   deployment origin, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, `NEXT_PUBLIC_RC_WEB_KEY`, and
   `NEXT_PUBLIC_BILLING=revenuecat`. Previews can leave billing on `mock`.
3. On the **API** project, add the web origin(s) to `CORS_ORIGINS` (comma-separated or JSON list),
   e.g. `https://seventhhouse.app,https://localhost`; `https://localhost` is the Capacitor WebView
   origin.
4. The Google OAuth client must list the web origin under Authorized JavaScript origins.

Vercel sets `VERCEL_GIT_COMMIT_SHA`, so the service-worker cache name rolls on every deploy.
The owner's full go-live checklist (API side) is in `../docs/status-2026-11-03-api-complete.md`.

## Replacing the placeholder deck

The 79 files in `public/deck/` are generated placeholders (`npm run placeholder-deck`). Real art
replaces them 1:1:

- One file per card: `public/deck/<card id>.webp`, where the id comes from `src/data/cards.json`
  (e.g. `major-00-fool`, `cups-01`, `wands-14-king`), plus `public/deck/back.webp`.
- Dimensions: **1024 × 1536** pixels (2:3 portrait), WebP. The placeholder script encodes at
  `quality: 82`; any WebP encoding works, but keep the 2:3 ratio since `components/card.tsx`
  renders fixed 2:3 boxes (72×108, 160×240, 240×360).

No code changes are needed; the service worker caches the deck by URL and the build id rolls the
cache on the next deploy.

## Capacitor hand-off (Plan 3)

`npm run build` produces `out/`, which is the Capacitor `webDir`. The app is already shaped for
it: static export only (no server routes), detail pages take `?id=` query params instead of
dynamic segments, and `trailingSlash: true` so every route is a directory with an `index.html`.
Point `NEXT_PUBLIC_API_URL` at the production API when building for the app bundle, and make sure
the API's `CORS_ORIGINS` includes `https://localhost`.

## Testing

Unit and component tests: `npm test` (vitest + Testing Library + msw). End-to-end: see below.

### End-to-end tests

`npm run e2e` runs the three money paths (daily card, chart-informed reading, purchase) in
Chromium with Playwright. `playwright.config.ts` starts `next dev -p 3100` with
`NEXT_PUBLIC_API_URL=http://api.test` and `NEXT_PUBLIC_BILLING=mock`; every API call is
answered in-process by `e2e/mocks/api.ts` (`page.route`), so no API, database, or model
spend is needed. Streams are fulfilled as one body (Playwright cannot trickle SSE frames).

Browsers: `npx playwright install chromium` once. If browsers live outside the default
cache, point `PLAYWRIGHT_BROWSERS_PATH` at that directory (the sandbox uses
`/opt/pw-browsers`). `npm run e2e:ui` opens the Playwright UI.

CI (`.github/workflows/web.yml`) runs lint, typecheck, unit tests, build, and E2E on every push
or PR touching `web/`, and uploads `playwright-report/` when E2E fails.
