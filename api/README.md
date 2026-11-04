# Seventh House API

FastAPI backend for Seventh House (tarot readings interpreted through a birth chart). Postgres via SQLAlchemy and Alembic; deployed on the Vercel Python runtime.

## Environment variables

Read by `app/config.py` (`Settings`), from the environment or an `api/.env` file.

| Variable | Default | Purpose |
|---|---|---|
| `ENV` | `dev` | `dev`, `test`, or `prod`. `prod` refuses to start with an empty or default `JWT_SECRET`. |
| `DATABASE_URL` | empty | SQLAlchemy URL of the app database, e.g. `postgresql+psycopg://user:pass@host/db`. |
| `TEST_DATABASE_URL` | empty | Database used by the test suite (falls back to `postgresql+psycopg://sh:sh@localhost:5432/seventh_house_test`). |
| `JWT_SECRET` | dev placeholder | HMAC secret for bearer tokens. Must be set (32 bytes or more) when `ENV=prod`. |
| `ANTHROPIC_API_KEY` | empty | Anthropic API key for reading generation. |
| `REVENUECAT_WEBHOOK_SECRET` | empty | Shared secret; RevenueCat must send `Authorization: Bearer <secret>` on the webhook. Requests are rejected with 401 otherwise. |
| `RESEND_API_KEY` | empty | Resend key for magic-link emails. |
| `GOOGLE_CLIENT_ID` | empty | OAuth client ID that Google ID tokens must be issued for. |
| `OPENCAGE_API_KEY` | empty | OpenCage key for birthplace geocoding and timezone lookup. |
| `CORS_ORIGINS` | `["http://localhost:3000"]` | Allowed browser origins: comma-separated or a JSON list. |
| `MODEL_PAID` | `claude-sonnet-4-5` | Model for paid spreads. |
| `MODEL_DAILY` | `claude-haiku-4-5` | Model for the free daily card. |
| `APP_BASE_URL` | `http://localhost:3000` | Web app base URL used to build magic-link URLs. |
| `EPHEMERIS_PATH` | `app/astro/de440s.bsp` | Path to the JPL ephemeris file, relative to `api/`. |
| `CREDIT_PRODUCTS` | `{"sh_credits_5":5,"sh_credits_15":15,"sh_credits_40":40}` | JSON map of store product ID to credits granted. |

## Run locally

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg://sh:sh@localhost:5432/seventh_house
alembic upgrade head
uvicorn app.main:app --reload
```

Health check: `GET /health`.

## Tests

Tests need Postgres at `TEST_DATABASE_URL`. If the local cluster is not running (for example in a fresh container), start it first with `pg_ctlcluster 16 main start`.

```bash
cd api
pytest -W error
```

## Migrations

```bash
cd api
alembic upgrade head          # apply all migrations
alembic revision -m "message" # new migration
```

`DATABASE_URL` selects the target database. All user foreign keys cascade on delete, which is what `DELETE /account` relies on.

## Rate limits

Enforced in Postgres, so they hold across serverless instances. Exceeding one returns `429` with `{"error": {"code": "rate_limited", ...}}`.

| Scope | Limit |
|---|---|
| `POST /auth/anonymous` | 10 per hour per IP |
| `POST /auth/magic/request` | 5 per hour per IP |
| `POST /readings`, `POST /readings/{id}/retry` | 20 per hour per user |
| `POST /daily` | 10 per hour per user |

The client IP is the first entry of `X-Forwarded-For` (set by Vercel).

## Deploy to Vercel

1. Create a Vercel project with **Root Directory** `api/`. `vercel.json` and `.python-version` (3.12) are in that directory; `index.py` is the entrypoint.
2. Set every variable above in the project environment. `ENV=prod` is required, and `JWT_SECRET` must be a random secret of at least 32 bytes (for example `openssl rand -hex 32`).
3. Point `DATABASE_URL` at a managed Postgres and run `alembic upgrade head` against it before the first deploy and after any migration.
4. Set `CORS_ORIGINS` to the web app origin(s), e.g. `https://seventhhouse.app`.
5. In RevenueCat, set the webhook URL to `https://<your-api-host>/billing/revenuecat` with the authorization header value `Bearer <REVENUECAT_WEBHOOK_SECRET>`.

### First deploy checklist

1. Create the Vercel project with Root Directory `api/`.
2. Set env vars in the project: `ENV=prod`, `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `REVENUECAT_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, `OPENCAGE_API_KEY`, `CORS_ORIGINS`, `APP_BASE_URL`, plus optionally `MODEL_PAID`, `MODEL_DAILY`, `EPHEMERIS_PATH`, `CREDIT_PRODUCTS`.
3. Create the Neon database and run `alembic upgrade head` locally with `DATABASE_URL` pointed at it.
4. Deploy with `vercel --prod` from `api/`.
5. Smoke test (`URL` is the deployment URL):
   - `curl $URL/health` returns `{"status":"ok"}`
   - `curl -X POST $URL/auth/anonymous` returns 201
   - `curl $URL/spreads` returns the three spreads
6. In RevenueCat, point the webhook at `$URL/billing/revenuecat` with the header `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`.
7. Send a test event from the RevenueCat dashboard and confirm the response is `{"credited": false, "reason": "ignored_event_type"}` (TEST events are ignored by design).

Function size: the JPL kernel `de440s.bsp` is bundled via `includeFiles`. If the deployment exceeds Vercel's function size limit, move the file to Vercel Blob, download it at cold start, and cache it under `/tmp` (set `EPHEMERIS_PATH` accordingly).
