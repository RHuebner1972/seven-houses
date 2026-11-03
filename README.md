# Seventh House

Tarot readings interpreted through your birth chart. Android + web.

Nantasket Analytics, LLC.

## Layout

```
api/    FastAPI backend (identity, chart engine, readings, credit ledger, billing webhook) — Vercel Python runtime
web/    Next.js static export, wrapped with Capacitor for Android
deck/   78-card deck + back (WebP)
docs/   Design spec and implementation plans
```

## Docs

- Design spec: `docs/superpowers/specs/2026-11-02-seventh-house-design.md`
- Plan 1 of 3 (API): `docs/superpowers/plans/2026-11-03-seventh-house-api.md`
