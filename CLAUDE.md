# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo state

Seventh House: tarot readings interpreted through a birth chart (Android + web). Only `api/` (FastAPI backend, Plan 1 of 3) exists so far. `web/` (Next.js static export + Capacitor) and `deck/` are planned but not yet in the repo. Design spec and plans are in `docs/superpowers/`; `docs/status-*.md` lists known gaps and owner deploy steps. `api/README.md` has the env-var table, rate limits, SSE/refund semantics and deploy steps, so read it before changing those areas.

## Commands (run from `api/`)

```bash
pip install -r requirements-dev.txt
alembic upgrade head                 # DATABASE_URL selects target DB
alembic revision -m "message"
uvicorn app.main:app --reload
pytest -W error                      # CI runs this; warnings are errors
pytest tests/test_ledger.py::test_name -W error   # single test
ruff check api/                      # line length 110, rules E,F,I (run from repo root as CI does, or `ruff check .` in api/)
```

Tests need Postgres at `TEST_DATABASE_URL` (default `postgresql+psycopg://sh:sh@localhost:5432/seventh_house_test`). In a fresh container start it with `pg_ctlcluster 16 main start`. `tests/conftest.py` runs migrations once per session, then truncates every table except `spread_prices` and `alembic_version` after each test, so seeded price data survives.

## Architecture

`app/main.py:create_app` wires one router per domain package: `auth`, `charts`, `readings`, `daily`, `billing`. `index.py` is the Vercel entrypoint (Python 3.12, `maxDuration` 300, bundles `app/astro/de440s.bsp`). Errors are normalized in `app/errors.py` to `{"error": {"code", ...}}`.

Cross-cutting design that spans several files:

- **Auth is anonymous-first.** Clients mint an anonymous JWT, then link Google or a magic-link email later (`auth/linking.py`). Linking to an identity that already belongs to another account merges the anonymous user's data into it in one transaction (with the anonymous row locked) and deletes the anonymous user. Magic-link verify is device-bound: it links only if the bearer matches the requesting device.
- **Credit ledger (`ledger/service.py`) is append-only.** Debits take `FOR UPDATE`, credits are idempotent, and a refund is keyed on the specific debit row, so it returns exactly what that attempt took even if the price has since changed. A spread priced at 0 takes no debit.
- **Reading lifecycle (`readings/service.py`, `router.py`, `generator.py`):** debit, then server-side CSPRNG draw, then stream Claude output as SSE (`cards`, `delta`, `done`/`error`), then complete. A disconnect before any text, a generation error, a truncated paid reading, or the 220 s deadline all mark the reading `failed` and refund it. A disconnect after text was sent drains the generation and completes it, keeping the debit. `pending` readings older than 6 minutes are swept (failed and refunded) lazily on `GET /me`, `POST /readings` and retry. Retries reuse the same cards.
- **Daily card (`daily/`)** is one per user per local day, enforced by the DB. A concurrent request returns 409 `generation_in_progress`. It uses a cheaper model (`MODEL_DAILY`).
- **Rate limits (`ratelimit.py`) live in Postgres** (`ip_events`, `generation_events`), not memory, because the deployment is serverless. Generation events are recorded before Claude is called, so abandoned streams still count.
- **Astro engine (`app/astro/`)**: Skyfield + JPL DE440s, Whole Sign houses, major aspects, Asc/MC. Birth dates are limited to 1850-01-01 to 2149-12-31 (the kernel's span). `readings/prompts.py` weaves the chart into the prompt and isolates the user's question against injection.
- **Billing:** RevenueCat webhook (`billing/`) authenticates with a bearer secret and credits only `NON_RENEWING_PURCHASE`, mapped via the `CREDIT_PRODUCTS` env JSON. Other event types are ignored by design.
- **Config (`config.py`)** is a pydantic `Settings` that reads env or `api/.env`. With `ENV=prod` it refuses to start on a weak `JWT_SECRET`.
- All user foreign keys cascade on delete; `DELETE /account` depends on that, so new user-owned tables need `ON DELETE CASCADE` and must also be handled in account merge.
- Snapshot tests in `tests/snapshots/` pin the prompt text; update them deliberately when changing `prompts.py`.
