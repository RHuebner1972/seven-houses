# Seventh House

[![api-tests](https://github.com/RHuebner1972/seven-houses/actions/workflows/api-tests.yml/badge.svg)](https://github.com/RHuebner1972/seven-houses/actions/workflows/api-tests.yml)
[![web](https://github.com/RHuebner1972/seven-houses/actions/workflows/web.yml/badge.svg)](https://github.com/RHuebner1972/seven-houses/actions/workflows/web.yml)

Tarot readings interpreted through your birth chart. A FastAPI backend computes the natal chart,
draws the spread, and streams a Claude-written interpretation; a Next.js static-export frontend
serves the daily card, chart, readings, journal, and credit store on the web and, wrapped with
Capacitor, on Android. Nantasket Analytics, LLC.

## Layout

```
api/    FastAPI backend (identity, chart engine, readings, credit ledger, billing webhook) — Vercel Python runtime
web/    Next.js static export (out/) — Vercel on the web, Capacitor webDir for Android
docs/   Design spec, implementation plans, status notes
```

## Docs

- API: [`api/README.md`](api/README.md) — env vars, run locally, tests, deploy to Vercel
- Web: [`web/README.md`](web/README.md) — env vars, scripts, deploy, replacing the deck art, Capacitor hand-off
- Design spec: [`docs/superpowers/specs/2026-11-02-seventh-house-design.md`](docs/superpowers/specs/2026-11-02-seventh-house-design.md)
- Plan 1 of 3 (API): [`docs/superpowers/plans/2026-11-03-seventh-house-api.md`](docs/superpowers/plans/2026-11-03-seventh-house-api.md)
- Plan 2 of 3 (web): [`docs/superpowers/plans/2026-11-03-seventh-house-web.md`](docs/superpowers/plans/2026-11-03-seventh-house-web.md)
- Status / owner deploy checklist: [`docs/status-2026-11-03-api-complete.md`](docs/status-2026-11-03-api-complete.md)
