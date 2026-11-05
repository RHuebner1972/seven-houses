# Seventh House web

Next.js static export (`output: 'export'`, `trailingSlash: true`) frontend for the Seventh House API in `../api`.

```bash
npm install
npm run dev        # local dev server on http://localhost:3000
npm test           # vitest, single run
npm run lint
npm run typecheck
npm run build      # static export to out/
```

## Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | API base URL (default `http://localhost:8000`). |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Google OAuth web client id for the sign-in button. Unset: the sheet shows "Google sign-in isn't configured" and only the magic link works. |
| `NEXT_PUBLIC_BILLING` / `NEXT_PUBLIC_RC_WEB_KEY` | Billing backend selection (`mock` or `revenuecat`) and the RevenueCat web key. |

All `NEXT_PUBLIC_*` values are inlined at build time; rebuild after changing them.
