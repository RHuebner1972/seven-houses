# Seventh House API

FastAPI backend for Seventh House (tarot readings interpreted through a birth chart). Postgres via SQLAlchemy and Alembic; deployed on the Vercel Python runtime.

## Environment variables

Read by `app/config.py` (`Settings`), from the environment or an `api/.env` file.

| Variable | Default | Purpose |
|---|---|---|
| `ENV` | `dev` | `dev`, `test`, or `prod`. `prod` refuses to start with an empty, default, or shorter-than-32-character `JWT_SECRET`. |
| `DATABASE_URL` | empty | SQLAlchemy URL of the app database, e.g. `postgresql+psycopg://user:pass@host/db`. |
| `TEST_DATABASE_URL` | empty | Database used by the test suite (falls back to `postgresql+psycopg://sh:sh@localhost:5432/seventh_house_test`). |
| `JWT_SECRET` | dev placeholder | HMAC secret for bearer tokens. Must be set (32 bytes or more) when `ENV=prod`. |
| `ANTHROPIC_API_KEY` | empty | Anthropic API key for reading generation. |
| `REVENUECAT_WEBHOOK_SECRET` | empty | Shared secret; RevenueCat must send `Authorization: Bearer <secret>` on the webhook. Requests are rejected with 401 otherwise. |
| `RESEND_API_KEY` | empty | Resend key for magic-link emails. |
| `RESEND_FROM` | `Seventh House <no-reply@seventhhouse.app>` | From address. For local testing before a domain is verified, use `Seventh House <beth.t@example.com>` (Resend will only deliver to the account owner's inbox). |
| `GOOGLE_CLIENT_ID` | empty | Same OAuth 2.0 Web client ID as `NEXT_PUBLIC_GOOGLE_CLIENT_ID` on the web app. Google Identity Services ID tokens are rejected unless they were issued for this client. |
| `OPENCAGE_API_KEY` | empty | OpenCage key for birthplace geocoding and timezone lookup. |
| `CORS_ORIGINS` | `["http://localhost:3000"]` | Allowed browser origins: comma-separated or a JSON list. The Android (Capacitor) app's WebView origin is `https://localhost`, so include it in production. |
| `MODEL_PAID` | `claude-sonnet-4-5` | Model for paid spreads. |
| `MODEL_DAILY` | `claude-haiku-4-5` | Model for the free daily card. |
| `APP_BASE_URL` | `http://localhost:3000` | Web app base URL used to build magic-link URLs. |
| `EPHEMERIS_PATH` | `app/astro/de440s.bsp` | Path to the JPL ephemeris file, relative to `api/`. |
| `CREDIT_PRODUCTS` | `{"sh_credits_5":5,"sh_credits_15":15,"sh_credits_40":40}` | JSON map of store product ID to credits granted. Every amount must be positive. |

## Run locally

From `api/`, after `api/.env` exists (at least `DATABASE_URL`) and Postgres is up:

```powershell
powershell -File .\run.ps1
```

That uses `.venv` (creates it and installs `requirements-dev.txt` if needed), runs
`alembic upgrade head`, and starts uvicorn with reload on http://127.0.0.1:8000.

Manual equivalent:

```bash
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg://sh:sh@localhost:5432/seventh_house
alembic upgrade head
uvicorn app.main:app --reload
```

Health check: `GET /health`.

### Google sign-in (local)

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create (or pick) a project, configure the **OAuth consent screen** (External, add your Google account as a test user).
2. Create an **OAuth 2.0 Client ID** of type **Web application**.
3. Authorized JavaScript origins: `http://localhost:3000`. No redirect URI is required for the GIS button.
4. Paste the client ID (`….apps.googleusercontent.com`) into both `GOOGLE_CLIENT_ID` in `api/.env` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in `web/.env.local`. Restart the API and `next dev`.

### Resend magic links (local)

`RESEND_API_KEY` is already required. Until `seventhhouse.app` is verified in Resend, set:

```
RESEND_FROM=Seventh House <beth.t@example.com>
```

Resend will only deliver that onboarding sender to the inbox of the Resend account owner. After you verify the domain: add the DNS records Resend shows, then switch `RESEND_FROM` to `Seventh House <no-reply@seventhhouse.app>` and restart the API. `APP_BASE_URL` must be the web origin the link should open (`http://localhost:3000` locally).

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
| `POST /readings`, `POST /readings/{id}/retry` | 20 generations per hour per user |
| `POST /daily` | 10 generations per hour per user |
| `GET /geocode` | 60 calls per hour per user |

Per-user limits count rows in `generation_events`: one per started stream (new reading, retry, daily card, daily regeneration), recorded before Claude is called, so a stream the client abandons still counts. Returning an already-completed daily card does not count.

The client IP is the first entry of `X-Forwarded-For` (set by Vercel).

## Reading streams

`POST /readings`, `POST /readings/{id}/retry` and `POST /daily` stream Server-Sent Events: `cards`, then `delta` events, then `done` (or `error` with code `generation_failed`, in which case the credits have been refunded and the reading can be retried).

- **Disconnects (drain-and-complete).** If the client goes away before any text was sent, the reading is marked `failed` and refunded. Once text has been sent, the server finishes the generation without streaming, stores the reading as `complete` and keeps the debit; the client finds it in `GET /readings/{id}`. If that drain fails or exceeds the generation deadline, the reading is `failed` and refunded.
- **Deadline.** A generation has 220 s of wall-clock time, checked between chunks; with the 60 s per-read client timeout the worst case stays inside Vercel's 300 s `maxDuration`; past that it fails and is refunded. A paid reading cut off at the token limit also fails and is refunded; a truncated daily card is completed with its footer line.
- **Stale pending readings.** A reading still `pending` 6 minutes after its last write has no live stream behind it. It is failed and refunded on the user's next `GET /me`, `POST /readings` or retry, and can then be retried.
- **Daily card in progress.** `POST /daily` while today's card is still being generated returns `409` with `{"error": {"code": "generation_in_progress", ...}}`; retry after a few seconds. A failed (or stale) daily card is regenerated with the same card. Daily readings cannot be retried through `/readings/{id}/retry` (422).
- **Prices.** A refund returns exactly what the attempt's debit took, even if the spread price has changed since. A spread priced at 0 credits takes no debit.

## Accounts

- `POST /auth/magic/verify` links the email to the device that requested the link only when the verify call carries that device's bearer token. Without a bearer it signs in as the email's existing owner, or creates a new email user; a bearer for any other user is rejected with 401.
- When an anonymous user signs in to an identity that already belongs to another account (Google or magic link), the anonymous user's profiles, readings, daily draws, rate-limit history and remaining credits move to that account, and the anonymous user is deleted, in one transaction.

## Deploy to Vercel

1. Create a Vercel project with **Root Directory** `api/`. `vercel.json` and `.python-version` (3.12) are in that directory; `index.py` is the entrypoint.
2. Set env vars in the project: `ENV=prod`, `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, `REVENUECAT_WEBHOOK_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID`, `OPENCAGE_API_KEY`, `CORS_ORIGINS`, `APP_BASE_URL`, plus optionally `MODEL_PAID`, `MODEL_DAILY`, `EPHEMERIS_PATH`, `CREDIT_PRODUCTS`. `JWT_SECRET` must be a random secret of at least 32 characters (for example `openssl rand -hex 32`).
3. Create the Neon database. Point `DATABASE_URL` at Neon's **pooled** host (the hostname containing `-pooler`), e.g. `postgresql+psycopg://user:pass@ep-xxx-pooler.region.aws.neon.tech/db?sslmode=require`: serverless instances open many short-lived connections and the pooler keeps them within Neon's limits. The engine uses `pool_pre_ping=True`, so connections dropped while a function was frozen are replaced transparently; if connection counts are still a problem, switch `create_engine` in `app/db.py` to `poolclass=NullPool` (one connection per request, pooled by Neon).
4. Run `alembic upgrade head` locally with `DATABASE_URL` pointed at it, before the first deploy and after any migration.
5. Set `CORS_ORIGINS` to the web app origin(s) and the Capacitor origin, e.g. `https://seventhhouse.app,https://localhost`.
6. Deploy with `vercel --prod` from `api/`.
7. Smoke test (`URL` is the deployment URL):
   - `curl $URL/health` returns `{"status":"ok"}`
   - `curl -X POST $URL/auth/anonymous` returns 201
   - `curl $URL/spreads` returns the three spreads
8. In RevenueCat, set the webhook URL to `$URL/billing/revenuecat` with the header `Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>`.
9. Send a test event from the RevenueCat dashboard and confirm the response is `{"credited": false, "reason": "ignored_event_type"}` (TEST events are ignored by design).

Function size: the JPL kernel `de440s.bsp` is bundled via `includeFiles`. If the deployment exceeds Vercel's function size limit, move the file to Vercel Blob, download it at cold start, and cache it under `/tmp` (set `EPHEMERIS_PATH` accordingly).

Birth dates are accepted from 1850-01-01 to 2149-12-31, the span the bundled de440s kernel covers.
