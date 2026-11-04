# Seventh House — Status: Plan 1 (API) complete

**Date:** 2026-11-03
**Repo:** github.com/RHuebner1972/seven-houses — `main` at 773b50a (= `feature/api` b928e17)
**Tests:** 272 passing under `pytest -W error`; `ruff check api/` clean; CI workflow at `.github/workflows/api-tests.yml`

## What shipped

FastAPI backend under `api/` (see `api/README.md` for env vars, local run, deploy):

- Anonymous-first JWT auth; Google and magic-link linking (device-bound verify; anonymous data merged into the existing account on link)
- Append-only credit ledger with `FOR UPDATE` debits, idempotent credits, refunds keyed on the debit row
- Natal chart engine: Skyfield + JPL DE440s, Whole Sign houses, major aspects, Asc/MC (cross-checked vs Swiss Ephemeris in dev tests to <0.01°); birth dates 1850–2149
- 78-card tarot catalogue with original keywords; server-side CSPRNG draws; daily / 3-card / Celtic Cross
- Prompt builder with chart weaving and injection-safe question block; Claude streaming over SSE
- Reading lifecycle: debit → draw → stream → complete; disconnect after text was delivered drains and completes (debit kept); disconnect before any text, generation error, truncation, or deadline (220 s) → failed + refunded; stale `pending` readings swept after 6 min; retries keep cards
- Free daily card, one per user per local day (DB-enforced), 409 while a generation is in progress
- RevenueCat webhook (`POST /billing/revenuecat`, bearer secret) crediting `NON_RENEWING_PURCHASE` idempotently; sandbox ignored in prod
- Rate limits (DB-backed `generation_events`): readings 20/h, daily 10/h, geocode 60/h per user; anon mint 10/h, magic request 5/h per IP
- `DELETE /account` with full cascade

## Owner actions before the first deploy (Task 17, steps 1–4)

1. Vercel project with root directory `api/`; set every env var in `api/README.md` (`ENV=prod`, `JWT_SECRET` ≥ 32 bytes).
2. Neon database (use the **pooled** host); `alembic upgrade head` locally against `DATABASE_URL`.
3. `vercel --prod`; smoke `GET /health`, `POST /auth/anonymous`, `GET /spreads`.
4. RevenueCat webhook → `https://<api>/billing/revenuecat` with `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`; a TEST event returns `{"credited": false, "reason": "ignored_event_type"}` by design.
5. Google Play **organization** developer account (D-U-N-S) — the long pole for Plan 3.

## Known gaps carried into the backlog

- A RevenueCat purchase delivered late for an anonymous user that has since been merged is skipped (needs a merged-user redirect or moving all ledger rows on merge).
- RevenueCat refunds/chargebacks (`CANCELLATION`) do not claw back credits — not in spec.
- `ip_events` / `generation_events` / `magic_tokens` have no pruning job.
- SSE has no heartbeat before the first token; Anthropic connection is held between stream start and first commit.
- Vercel-specific behaviours (runtime key, whether client disconnects reach ASGI) are only verifiable at deploy.

## Next

Plan 2 of 3: Next.js web app (static export) consuming this API. Plan 3: Capacitor Android build + store submission.
