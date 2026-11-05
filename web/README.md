# Seventh House web

Next.js static export (`output: 'export'`, `trailingSlash: true`) frontend for the Seventh House API in `../api`.

```bash
npm install
npm run dev        # local dev server on http://localhost:3000
npm test           # vitest, single run
npm run e2e        # playwright money-path specs (Chromium) against next dev + route mocks
npm run lint
npm run typecheck
npm run build      # static export to out/
```

## End-to-end tests

`npm run e2e` runs the three money paths (daily card, chart-informed reading, purchase) in
Chromium with Playwright. `playwright.config.ts` starts `next dev -p 3100` with
`NEXT_PUBLIC_API_URL=http://api.test` and `NEXT_PUBLIC_BILLING=mock`; every API call is
answered in-process by `e2e/mocks/api.ts` (`page.route`), so no API, database, or model
spend is needed. Streams are fulfilled as one body (Playwright cannot trickle SSE frames).

Browsers: `npx playwright install chromium` once. If browsers live outside the default
cache, point `PLAYWRIGHT_BROWSERS_PATH` at that directory (the sandbox uses
`/opt/pw-browsers`). `npm run e2e:ui` opens the Playwright UI.

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | API base URL (default `http://localhost:8000`). |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth web client id for the sign-in button. Unset: the sheet shows "Google sign-in isn't configured" and only the magic link works. |
| `NEXT_PUBLIC_BILLING` / `NEXT_PUBLIC_RC_WEB_KEY` | Billing backend selection (`mock` or `revenuecat`) and the RevenueCat web key. |

All `NEXT_PUBLIC_*` values are inlined at build time; rebuild after changing them.
