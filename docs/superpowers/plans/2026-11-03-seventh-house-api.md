# Seventh House API Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the FastAPI backend that owns identity, the natal chart engine, server-side tarot draws, AI reading generation over SSE, the credit ledger, and the RevenueCat webhook — deployable to Vercel's Python runtime.

**Architecture:** One FastAPI app under `api/app/` split into single-purpose packages (`auth`, `astro`, `tarot`, `ledger`, `readings`, `daily`, `charts`, `billing`). All money and model cost live here; the client is untrusted. Postgres (Neon) via SQLAlchemy 2.0 + psycopg 3, migrations via Alembic. Chart math is pure Python on Skyfield + DE440s and never touches I/O after kernel load.

**Tech Stack:** Python 3.12, FastAPI, Pydantic v2, pydantic-settings, SQLAlchemy 2.0 (sync, psycopg 3), Alembic, PyJWT, google-auth, anthropic, skyfield, httpx, resend, pytest, pytest-postgresql (dev), pyswisseph (dev-only, for cross-checking the chart engine — never shipped).

**Spec:** `docs/superpowers/specs/2026-11-02-seventh-house-design.md`

## Global Constraints

- Python 3.12; `api/` is its own Vercel project with `api/index.py` as the entrypoint exposing `app`.
- Skyfield + JPL `de440s.bsp` for positions. No Swiss Ephemeris in runtime dependencies (AGPL). `pyswisseph` is allowed in `requirements-dev.txt` only.
- Tropical zodiac. Whole Sign houses only. Planets: Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, Pluto, Mean North Node.
- Aspects: conjunction 0°, opposition 180°, trine 120°, square 90°, sextile 60°. Orbs: 8° if Sun or Moon involved, 6° otherwise, 3° for sextiles.
- Spreads: `daily` (1 position), `three_card` (3), `celtic_cross` (10). Reversal probability 0.5 per card.
- Credit ledger is append-only; balance = `SUM(delta)`; `reference_id` is unique.
- Debit and reading insert happen in one transaction with `SELECT ... FOR UPDATE` on the user row.
- Failed generation always refunds with `reference_id = f"{reading_id}:refund"`.
- Models from config: `MODEL_PAID` (default `claude-sonnet-4-5`), `MODEL_DAILY` (default `claude-haiku-4-5`). Confirm current model ids at build time.
- Reading guardrails: reflective not predictive; no medical, legal, financial, or pregnancy predictions; no claims about third parties; readings end with the fixed footer `For reflection and entertainment.`
- User `question` max 500 characters; it is wrapped in `<question>` tags in the prompt and never interpolated into the system prompt.
- JWT: HS256, `sub` = user id, `anon` bool, 30-day expiry.
- All timestamps stored UTC. Birth datetime stored as UTC plus the IANA tz it was entered in.
- Tests run against the Postgres at `TEST_DATABASE_URL` (a Neon branch in CI, or local Postgres). Anthropic, Resend, Google, and OpenCage are mocked in tests.

## Review Focus

1. **Ambiguous or nonexistent local birth times** (DST fall-back hour, spring-forward gap) — must convert deterministically (fold=0) and never raise. Test in Task 7.
2. **Birth latitude ≥ 66.5° or exactly ±90°** — Ascendant formula degenerates; API must return a chart with `ascendant = null` and `time_known` effectively false rather than NaN or 500. Test in Task 8.
3. **Client disconnects mid-stream** — the reading must end `failed` with a refund, never stay `pending` with a debit. Test in Task 13.
4. **RevenueCat webhook replayed, out of order, or for an unknown product id** — exactly one credit per transaction id; unknown products are logged and acknowledged with 200 (so RevenueCat stops retrying) but credit nothing. Test in Task 15.
5. **Daily card across a timezone change** — a user who draws in `America/New_York` then sends `Asia/Tokyo` the same UTC day may get a second card; this is accepted, but an invalid tz string must 422, not 500. Test in Task 14.

---

## File Structure

```
api/
  index.py                      # Vercel entrypoint: `from app.main import app`
  vercel.json                   # python runtime, maxDuration 300, includeFiles for de440s.bsp
  requirements.txt
  requirements-dev.txt
  alembic.ini
  alembic/env.py, versions/0001_initial.py
  app/
    main.py                     # create_app(): routers, CORS, error handlers
    config.py                   # Settings (pydantic-settings)
    db.py                       # engine, SessionLocal, get_db dependency, Base
    models.py                   # all SQLAlchemy models
    errors.py                   # AppError hierarchy → HTTP mapping
    auth/jwt.py                 # mint/verify
    auth/deps.py                # current_user dependency
    auth/router.py              # /auth/*, /me, DELETE /account
    auth/google.py              # verify Google id_token
    auth/magic.py               # magic-link token issue/verify + email send
    astro/ephemeris.py          # Skyfield loader + planet longitudes
    astro/angles.py             # Ascendant, MC
    astro/houses.py             # Whole Sign assignment
    astro/aspects.py            # aspect detection
    astro/chart.py              # compute_chart() → ChartData
    astro/time.py               # local → UTC, Julian date
    tarot/data/cards.json       # 78 cards
    tarot/cards.py              # load/validate catalogue
    tarot/spreads.py            # spread definitions
    tarot/draw.py               # draw()
    ledger/service.py           # balance, credit, debit_for_reading, refund
    readings/prompts.py         # build_messages()
    readings/generator.py       # stream_reading() around anthropic
    readings/service.py         # start_reading(), run_generation(), retry
    readings/router.py          # POST /readings (SSE), GET, retry
    daily/service.py            # get_or_create_daily()
    daily/router.py             # POST /daily (SSE)
    charts/geocode.py           # OpenCage client
    charts/router.py            # /profiles, /geocode
    billing/revenuecat.py       # event parsing, product map
    billing/router.py           # POST /billing/revenuecat
    ratelimit.py                # per-user / per-IP checks backed by Postgres
  tests/
    conftest.py                 # app, db session, auth helpers, fakes
    test_<module>.py per task
```

---

### Task 1: Project scaffold and health endpoint

**Files:**
- Create: `api/index.py`, `api/vercel.json`, `api/requirements.txt`, `api/requirements-dev.txt`, `api/app/__init__.py`, `api/app/main.py`, `api/app/config.py`, `api/app/errors.py`, `api/tests/conftest.py`, `api/tests/test_health.py`, `api/pytest.ini`, `.gitignore`

**Interfaces:**
- Produces: `create_app() -> FastAPI` in `app/main.py`; `Settings` in `app/config.py` with fields `database_url`, `test_database_url`, `jwt_secret`, `anthropic_api_key`, `revenuecat_webhook_secret`, `resend_api_key`, `google_client_id`, `opencage_api_key`, `cors_origins: list[str]`, `model_paid`, `model_daily`, `app_base_url`, `ephemeris_path` (default `app/astro/de440s.bsp`); `get_settings()` cached. `AppError(status_code, code, message)` base with subclasses `NotFound`, `Unauthorized`, `InsufficientCredits` (402), `RateLimited` (429), `ValidationFailed` (422); handler returns `{"error": {"code", "message"}}`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_health.py
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}

def test_app_error_shape(client):
    r = client.get("/_test/raise-not-found")  # test-only route registered in conftest
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "nope"}}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/test_health.py -v`
Expected: FAIL (ImportError on `app.main`)

- [ ] **Step 3: Implement scaffold**

`requirements.txt`: fastapi, uvicorn, pydantic, pydantic-settings, sqlalchemy>=2.0, psycopg[binary], alembic, pyjwt, google-auth, anthropic, skyfield, httpx, resend. `requirements-dev.txt`: pytest, pytest-postgresql, pyswisseph, freezegun. `conftest.py` builds the app with `create_app()`, registers a `/_test/raise-not-found` route that raises `NotFound("nope")`, and yields a `TestClient`. `vercel.json`: `{"functions": {"index.py": {"runtime": "python3.12", "maxDuration": 300, "includeFiles": "app/astro/de440s.bsp"}}}` — verify the runtime key against current Vercel docs when deploying.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && pytest tests/test_health.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api .gitignore
git commit -m "feat(api): scaffold FastAPI app, settings, error handling"
```

---

### Task 2: Database models and initial migration

**Files:**
- Create: `api/app/db.py`, `api/app/models.py`, `api/alembic.ini`, `api/alembic/env.py`, `api/alembic/versions/0001_initial.py`, `api/tests/test_models.py`
- Modify: `api/tests/conftest.py` (add `db` fixture: creates schema via Alembic on `TEST_DATABASE_URL`, truncates between tests)

**Interfaces:**
- Produces: `get_db()` FastAPI dependency yielding a `Session`; models `User(id: UUID, email: str|None, auth_provider: str|None, auth_subject: str|None, created_at)`, `BirthProfile(id, user_id, name, birth_datetime_utc, birth_tz, lat, lon, place_label, time_known, created_at)`, `Chart(id, birth_profile_id unique, data: dict, engine_version: str, computed_at)`, `Reading(id, user_id, spread_type, cards: list, question, chart_id, text, model, token_usage: dict, status: 'pending'|'complete'|'failed', created_at)`, `CreditLedger(id, user_id, delta, reason, reference_id unique, created_at)`, `DailyDraw(user_id, local_date, card: dict, reading_id; pk(user_id, local_date))`, `SpreadPrice(spread_type pk, credits)`, `IpEvent(id, ip, kind, created_at)`.
- Migration seeds `spread_prices`: `daily=0`, `three_card=1`, `celtic_cross=3`.

- [ ] **Step 1: Write the failing tests**

```python
def test_tables_exist(db):
    names = set(sqlalchemy.inspect(db.get_bind()).get_table_names())
    assert {"users","birth_profiles","charts","readings","credit_ledger","daily_draws","spread_prices","ip_events"} <= names

def test_spread_prices_seeded(db):
    rows = {r.spread_type: r.credits for r in db.query(SpreadPrice)}
    assert rows == {"daily": 0, "three_card": 1, "celtic_cross": 3}

def test_ledger_reference_unique(db, user):
    db.add(CreditLedger(user_id=user.id, delta=5, reason="purchase", reference_id="tx1")); db.commit()
    db.add(CreditLedger(user_id=user.id, delta=5, reason="purchase", reference_id="tx1"))
    with pytest.raises(IntegrityError): db.commit()
```

- [ ] **Step 2: Run tests to verify they fail** — `pytest tests/test_models.py -v` → FAIL (no models)

- [ ] **Step 3: Implement models, `db.py`, Alembic env, migration 0001**

Use `sqlalchemy.dialects.postgresql.JSONB` for json columns and `UUID(as_uuid=True)` with `uuid4` defaults. `conftest.py` `db` fixture runs `alembic upgrade head` once per session and `TRUNCATE ... CASCADE` all tables except `spread_prices` after each test. `user` fixture inserts an anonymous `User`.

- [ ] **Step 4: Run tests to verify they pass** — `pytest tests/test_models.py -v` → PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(api): models and initial migration"`

---

### Task 3: Credit ledger service

**Files:**
- Create: `api/app/ledger/__init__.py`, `api/app/ledger/service.py`, `api/tests/test_ledger.py`

**Interfaces:**
- Produces: `balance(db, user_id) -> int`; `credit(db, user_id, amount: int, reason: str, reference_id: str) -> bool` (returns False and changes nothing if `reference_id` already exists); `debit_for_reading(db, user_id, cost: int, reading_id: UUID) -> None` (locks user row `FOR UPDATE`, raises `InsufficientCredits` if balance < cost, inserts `delta=-cost, reason='reading', reference_id=str(reading_id)`; does NOT commit — caller owns the transaction); `refund_reading(db, user_id, cost, reading_id) -> bool` (idempotent via `f"{reading_id}:refund"`).

- [ ] **Step 1: Write the failing tests**

```python
def test_balance_zero_for_new_user(db, user): assert balance(db, user.id) == 0
def test_credit_then_balance(db, user):
    assert credit(db, user.id, 5, "purchase", "tx1") is True; db.commit()
    assert balance(db, user.id) == 5
def test_credit_idempotent(db, user):
    credit(db, user.id, 5, "purchase", "tx1"); db.commit()
    assert credit(db, user.id, 5, "purchase", "tx1") is False
    assert balance(db, user.id) == 5
def test_debit_insufficient_raises(db, user):
    with pytest.raises(InsufficientCredits): debit_for_reading(db, user.id, 1, uuid4())
def test_refund_idempotent(db, user):
    credit(db, user.id, 1, "purchase", "tx1"); rid = uuid4(); debit_for_reading(db, user.id, 1, rid); db.commit()
    assert refund_reading(db, user.id, 1, rid) is True; db.commit()
    assert refund_reading(db, user.id, 1, rid) is False
    assert balance(db, user.id) == 1
def test_concurrent_debit_only_one_wins(db_url, user):
    # balance 1; two threads each open their own session and call debit_for_reading then commit
    # assert exactly one succeeded and final balance == 0
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL (ImportError)

- [ ] **Step 3: Implement `ledger/service.py`**

`debit_for_reading` does `db.execute(select(User).where(User.id == user_id).with_for_update())` first, then sums deltas. `credit` catches `IntegrityError` on flush via a savepoint (`db.begin_nested()`) and returns False.

- [ ] **Step 4: Run tests to verify they pass** → PASS (including the thread test)

- [ ] **Step 5: Commit** — `git commit -m "feat(api): credit ledger service with atomic debit"`

---

### Task 4: JWT, anonymous users, `/me`

**Files:**
- Create: `api/app/auth/__init__.py`, `api/app/auth/jwt.py`, `api/app/auth/deps.py`, `api/app/auth/router.py`, `api/tests/test_auth_anon.py`
- Modify: `api/app/main.py` (include router), `api/tests/conftest.py` (add `auth_headers(user)` helper)

**Interfaces:**
- Produces: `mint_token(user_id: UUID, anon: bool) -> str`; `verify_token(token) -> TokenClaims(user_id, anon)` raising `Unauthorized`; dependency `current_user(db, authorization header) -> User`; routes `POST /auth/anonymous -> {token, user_id}`, `POST /auth/refresh -> {token}`, `GET /me -> {user_id, email, anon, balance}`.

- [ ] **Step 1: Write the failing tests**

```python
def test_anonymous_creates_user_and_token(client, db):
    r = client.post("/auth/anonymous"); assert r.status_code == 201
    claims = verify_token(r.json()["token"]); assert claims.anon is True
    assert db.get(User, claims.user_id) is not None
def test_me_requires_auth(client): assert client.get("/me").status_code == 401
def test_me_returns_balance(client, db, user):
    credit(db, user.id, 2, "grant", "g1"); db.commit()
    r = client.get("/me", headers=auth_headers(user)); assert r.json()["balance"] == 2
def test_expired_token_rejected():
    with freeze_time("2026-01-01"): t = mint_token(uuid4(), True)
    with freeze_time("2026-02-15"):
        with pytest.raises(Unauthorized): verify_token(t)
def test_refresh_returns_new_token(client, user):
    r = client.post("/auth/refresh", headers=auth_headers(user)); assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement jwt.py (PyJWT HS256, `exp` = now + 30 days), deps.py, router.py**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): anonymous auth, JWT, /me"`

---

### Task 5: Google sign-in and magic-link linking

**Files:**
- Create: `api/app/auth/google.py`, `api/app/auth/magic.py`, `api/tests/test_auth_link.py`
- Modify: `api/app/auth/router.py`, `api/app/models.py` + migration `0002_magic_tokens.py` (table `magic_tokens(token_hash pk, email, user_id, expires_at, used_at)`)

**Interfaces:**
- Produces: `verify_google_id_token(id_token: str) -> GoogleIdentity(subject, email)` (wraps `google.oauth2.id_token.verify_oauth2_token` with `settings.google_client_id`); `issue_magic_link(db, email, user_id) -> str` (returns the raw token; stores sha256; expiry 15 min; sends email via Resend with `f"{app_base_url}/auth/magic?token=..."`); `consume_magic_token(db, token) -> User`. Routes: `POST /auth/google {id_token}`, `POST /auth/magic/request {email}` (always 202), `POST /auth/magic/verify {token} -> {token, user_id}`. Linking rule: if the identity (provider+subject or email) already belongs to another user, the caller's anonymous user is abandoned and the token returned is for the existing user (its ledger/readings win). Otherwise the current user row is updated in place.

- [ ] **Step 1: Write the failing tests**

```python
def test_google_links_current_user(client, db, user, fake_google):   # fake_google patches verify to return subject "g1", email "a@x.io"
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.status_code == 200; db.refresh(user)
    assert (user.email, user.auth_provider, user.auth_subject) == ("a@x.io", "google", "g1")
    assert verify_token(r.json()["token"]).anon is False
def test_google_existing_identity_returns_existing_user(client, db, user, other_user_google_g1, fake_google):
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.json()["user_id"] == str(other_user_google_g1.id)
def test_magic_request_sends_email(client, user, fake_resend):
    assert client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user)).status_code == 202
    assert fake_resend.sent[0]["to"] == "a@x.io"
def test_magic_verify_links_and_is_single_use(client, db, user, fake_resend):
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    token = fake_resend.extract_token()
    assert client.post("/auth/magic/verify", json={"token": token}).status_code == 200
    assert client.post("/auth/magic/verify", json={"token": token}).status_code == 401
def test_magic_token_expires(client, db, user, fake_resend):
    # request at T, verify at T+16min → 401
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement google.py, magic.py, migration 0002, router additions**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): google and magic-link sign-in linking"`

---

### Task 6: Tarot catalogue, spreads, and draw

**Files:**
- Create: `api/app/tarot/__init__.py`, `api/app/tarot/data/cards.json`, `api/app/tarot/cards.py`, `api/app/tarot/spreads.py`, `api/app/tarot/draw.py`, `api/tests/test_tarot.py`

**Interfaces:**
- Produces: `Card(id: str, name: str, arcana: 'major'|'minor', suit: str|None, number: int, upright: list[str], reversed: list[str], image: str)`; `CARDS: list[Card]` (78, ids like `major-00-fool`, `wands-01`, `cups-11-page`; image = `f"/deck/{id}.webp"`); `Spread(type, positions: list[Position(key, name, meaning)])`; `SPREADS: dict[str, Spread]` for `daily`, `three_card` (past/present/future), `celtic_cross` (present, challenge, past, future, above, below, advice, external, hopes_fears, outcome); `draw(spread_type, rng=None) -> list[DrawnCard(position: str, card_id: str, reversed: bool)]` using `secrets.SystemRandom()` by default.
- `cards.json` content: 22 majors and 56 minors with 3–5 original upright and reversed keywords each (write them; do not copy from any published deck text).

- [ ] **Step 1: Write the failing tests**

```python
def test_catalogue_has_78_unique_cards():
    assert len(CARDS) == 78 and len({c.id for c in CARDS}) == 78
    assert sum(c.arcana == "major" for c in CARDS) == 22
def test_every_card_has_keywords():
    assert all(3 <= len(c.upright) <= 5 and 3 <= len(c.reversed) <= 5 for c in CARDS)
def test_spread_position_counts():
    assert [len(SPREADS[k].positions) for k in ("daily","three_card","celtic_cross")] == [1,3,10]
def test_draw_unique_cards_and_positions():
    d = draw("celtic_cross"); assert len({x.card_id for x in d}) == 10
    assert [x.position for x in d] == [p.key for p in SPREADS["celtic_cross"].positions]
def test_reversal_rate_near_half():
    rng = random.Random(42); n = sum(x.reversed for _ in range(500) for x in draw("three_card", rng))
    assert 650 < n < 850
def test_unknown_spread_raises():
    with pytest.raises(KeyError): draw("nope")
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement cards.json, cards.py (load + Pydantic validate at import), spreads.py, draw.py**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): tarot catalogue, spreads, server-side draw"`

---

### Task 7: Astro time conversion and planet longitudes

**Files:**
- Create: `api/app/astro/__init__.py`, `api/app/astro/time.py`, `api/app/astro/ephemeris.py`, `api/app/astro/de440s.bsp` (download once via Skyfield's loader into this path; add to git-lfs or commit directly, ~32 MB), `api/tests/test_astro_positions.py`

**Interfaces:**
- Produces: `to_utc(local: datetime, tz: str) -> datetime` (naive local + IANA tz → aware UTC; nonexistent/ambiguous times resolved with `fold=0`); `BODIES = ["sun","moon","mercury","venus","mars","jupiter","saturn","uranus","neptune","pluto","north_node"]`; `longitudes(utc: datetime) -> dict[str, float]` (apparent geocentric ecliptic longitude in degrees [0,360) for each body; `north_node` is the mean node, computed analytically from Meeus's formula, not from the kernel); `get_ephemeris()` cached loader using `settings.ephemeris_path`.

- [ ] **Step 1: Write the failing tests**

```python
def test_sun_at_march_2000_equinox():
    lon = longitudes(datetime(2000,3,20,7,35,tzinfo=UTC))["sun"]; assert abs(lon) < 0.02 or abs(lon-360) < 0.02
def test_sun_at_june_2000_solstice():
    assert abs(longitudes(datetime(2000,6,21,1,48,tzinfo=UTC))["sun"] - 90.0) < 0.02
def test_all_bodies_match_swisseph():   # dev-only cross-check
    import swisseph as swe
    for utc in [datetime(1985,7,4,14,30,tzinfo=UTC), datetime(2024,11,3,3,0,tzinfo=UTC)]:
        ours = longitudes(utc); jd = swe.julday(...)
        for body, swe_id in [("sun",swe.SUN),("moon",swe.MOON),...,("pluto",swe.PLUTO),("north_node",swe.MEAN_NODE)]:
            assert abs(angdiff(ours[body], swe.calc_ut(jd, swe_id)[0][0])) < 0.05
def test_to_utc_dst_gap_does_not_raise():
    assert to_utc(datetime(2024,3,10,2,30), "America/New_York").tzinfo is not None
def test_to_utc_dst_fold_uses_first_occurrence():
    assert to_utc(datetime(2024,11,3,1,30), "America/New_York") == datetime(2024,11,3,5,30,tzinfo=UTC)
def test_to_utc_bad_tz_raises_validation():
    with pytest.raises(ValidationFailed): to_utc(datetime(2024,1,1,0,0), "Mars/Olympus")
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement time.py and ephemeris.py**

Use `zoneinfo.ZoneInfo`; Skyfield `earth.at(t).observe(body).apparent().ecliptic_latlon(epoch='date')` for longitude of date (tropical). Moon from `de440s` `moon`; use barycenters for Jupiter–Pluto. Mean node: `125.0445479 - 1934.1362891*T + 0.0020754*T² + T³/467441 - T⁴/60616000` with T in Julian centuries from J2000.

- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): ephemeris positions and local-time conversion"`

---

### Task 8: Ascendant, MC, Whole Sign houses, aspects, chart assembly

**Files:**
- Create: `api/app/astro/angles.py`, `api/app/astro/houses.py`, `api/app/astro/aspects.py`, `api/app/astro/chart.py`, `api/tests/test_astro_chart.py`

**Interfaces:**
- Produces: `ascendant_mc(utc, lat, lon) -> tuple[float, float] | None` (None when `abs(lat) > 66.0`); `sign_of(lon) -> str` (12 names) and `degree_in_sign(lon) -> float`; `whole_sign_house(lon, asc_lon) -> int` (1–12); `find_aspects(positions: dict[str,float]) -> list[Aspect(a, b, kind, orb: float)]` with the Global Constraints orbs; `compute_chart(utc, lat, lon, time_known: bool) -> ChartData` (Pydantic: `engine_version="1"`, `planets: dict[str, Placement(longitude, sign, degree, house: int|None, retrograde: bool)]`, `ascendant: Placement|None`, `mc: Placement|None`, `aspects: list[Aspect]`, `time_known`). When `time_known` is False or `ascendant_mc` returns None: `ascendant`, `mc`, and all `house` values are None. Retrograde = longitude decreasing over ±1 hour (Sun, Moon, node never retrograde).

- [ ] **Step 1: Write the failing tests**

```python
def test_asc_mc_match_swisseph():
    import swisseph as swe
    utc = datetime(1990,5,15,9,15,tzinfo=UTC); asc, mc = ascendant_mc(utc, 42.30, -70.91)
    cusps, ascmc = swe.houses(swe.julday(...), 42.30, -70.91, b"W")
    assert abs(angdiff(asc, ascmc[0])) < 0.05 and abs(angdiff(mc, ascmc[1])) < 0.05
def test_polar_latitude_returns_none(): assert ascendant_mc(datetime(2000,1,1,tzinfo=UTC), 80.0, 0.0) is None
def test_whole_sign_houses():
    assert whole_sign_house(5.0, 3.0) == 1     # both Aries
    assert whole_sign_house(35.0, 3.0) == 2    # Taurus planet, Aries asc
    assert whole_sign_house(350.0, 3.0) == 12
def test_aspect_orbs():
    a = find_aspects({"sun": 0.0, "mars": 7.5, "venus": 65.0, "saturn": 185.0, "jupiter": 277.0})
    kinds = {(x.a, x.b): x.kind for x in a}
    assert kinds[("sun","mars")] == "conjunction"     # 7.5°, within 8° because Sun is involved
    assert ("sun","venus") not in kinds               # 65°: 5° off sextile, sextile orb is 3°
    assert kinds[("sun","saturn")] == "opposition"    # 185°: 5° off, within 8°
    assert kinds[("mars","saturn")] == "opposition"   # 177.5°: 2.5° off, within 6°
    assert kinds[("venus","saturn")] == "trine"       # exactly 120°
    assert kinds[("mars","venus")] == "sextile"       # 57.5°: 2.5° off, within 3°
    assert kinds[("sun","jupiter")] == "square"       # 277° is 83° the short way: 7° off, within 8°
    assert ("venus","jupiter") not in kinds           # 148° the short way: nothing within orb
def test_compute_chart_unknown_time_has_no_houses():
    c = compute_chart(datetime(1990,5,15,12,0,tzinfo=UTC), 42.3, -70.9, time_known=False)
    assert c.ascendant is None and all(p.house is None for p in c.planets.values())
def test_compute_chart_known_time_has_houses():
    c = compute_chart(datetime(1990,5,15,9,15,tzinfo=UTC), 42.3, -70.9, time_known=True)
    assert c.ascendant is not None and all(1 <= p.house <= 12 for p in c.planets.values())
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement angles.py (LST via Skyfield `t.gmst` + longitude; mean obliquity; standard Asc/MC formulas), houses.py, aspects.py, chart.py**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): angles, whole-sign houses, aspects, chart assembly"`

---

### Task 9: Geocoding client and birth profile endpoints

**Files:**
- Create: `api/app/charts/__init__.py`, `api/app/charts/geocode.py`, `api/app/charts/router.py`, `api/tests/test_charts_api.py`
- Modify: `api/app/main.py`

**Interfaces:**
- Produces: `geocode(q: str) -> list[Place(label, lat, lon, tz)]` (OpenCage forward geocode, `limit=5`, uses the `annotations.timezone.name` field; results cached in-process by `q`); routes `GET /geocode?q=` (auth required, min 2 chars), `POST /profiles` body `{name, birth_date: "YYYY-MM-DD", birth_time: "HH:MM"|null, tz, lat, lon, place_label}` → 201 `{profile, chart}` (computes and stores the chart; `time_known = birth_time is not None`; when null, uses 12:00 local), `GET /profiles`, `GET /profiles/{id}` → `{profile, chart}`, `DELETE /profiles/{id}`.

- [ ] **Step 1: Write the failing tests**

```python
def test_geocode_proxies_opencage(client, user, fake_opencage):
    r = client.get("/geocode", params={"q": "Hull, MA"}, headers=auth_headers(user))
    assert r.json()[0] == {"label": "Hull, MA, USA", "lat": 42.30, "lon": -70.91, "tz": "America/New_York"}
def test_create_profile_returns_chart(client, user):
    r = client.post("/profiles", json=PROFILE_BODY, headers=auth_headers(user))
    assert r.status_code == 201 and r.json()["chart"]["planets"]["sun"]["sign"] == "Taurus"
def test_create_profile_unknown_time(client, user):
    r = client.post("/profiles", json={**PROFILE_BODY, "birth_time": None}, headers=auth_headers(user))
    assert r.json()["chart"]["ascendant"] is None
def test_future_birth_date_422(client, user):
    r = client.post("/profiles", json={**PROFILE_BODY, "birth_date": "2999-01-01"}, headers=auth_headers(user)); assert r.status_code == 422
def test_profile_belongs_to_user(client, user, other_user):
    pid = client.post("/profiles", json=PROFILE_BODY, headers=auth_headers(user)).json()["profile"]["id"]
    assert client.get(f"/profiles/{pid}", headers=auth_headers(other_user)).status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement geocode.py (httpx, 5 s timeout) and router.py**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): geocoding and birth profiles with charts"`

---

### Task 10: Prompt builder

**Files:**
- Create: `api/app/readings/__init__.py`, `api/app/readings/prompts.py`, `api/tests/test_prompts.py`, `api/tests/snapshots/celtic_cross_with_chart.txt`, `api/tests/snapshots/daily.txt`

**Interfaces:**
- Produces: `SYSTEM_PROMPT: str` (guardrails from Global Constraints, instruction to write in second person, 2–4 short paragraphs for daily, one paragraph per position plus a synthesis for spreads, end with the fixed footer); `build_messages(spread_type, cards: list[DrawnCard], question: str|None, chart: ChartData|None) -> list[dict]` returning Anthropic `messages` (one user message) whose content includes: spread name and each position's name + meaning; each card's name, orientation, and the orientation's keywords; the `<question>…</question>` block only when present; and, when `chart` is given, a compact chart block (each planet: sign, degree, house if any; ascendant; aspects list) followed by `WEAVING_GUIDANCE` (relate *present/self* to Sun and Ascendant, *hopes_fears* to Moon and 12th house, *outcome* to the ruler of the Ascendant sign; when houses are null, say the birth time is unknown and do not infer houses).

- [ ] **Step 1: Write the failing tests**

```python
def test_question_is_tagged_and_capped():
    m = build_messages("three_card", three_cards(), "x"*600, None)
    assert "<question>" in m[0]["content"] and "x"*501 not in m[0]["content"]
def test_no_chart_omits_weaving(): assert "Ascendant" not in build_messages("three_card", three_cards(), None, None)[0]["content"]
def test_unknown_time_chart_states_it():
    assert "birth time is unknown" in build_messages("celtic_cross", cc_cards(), None, chart_unknown_time())[0]["content"]
def test_snapshot_celtic_cross_with_chart(snapshot):
    assert build_messages("celtic_cross", cc_cards(), "Should I change jobs?", chart_known())[0]["content"] == snapshot("celtic_cross_with_chart.txt")
def test_system_prompt_has_footer_and_guardrails():
    assert "For reflection and entertainment." in SYSTEM_PROMPT and "medical" in SYSTEM_PROMPT
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement prompts.py; generate snapshots on first run (`--update-snapshots` flag in conftest)**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): reading prompt builder with snapshots"`

---

### Task 11: Streaming generator around the Anthropic SDK

**Files:**
- Create: `api/app/readings/generator.py`, `api/tests/test_generator.py`
- Modify: `api/tests/conftest.py` (add `fake_anthropic` fixture that patches `anthropic.Anthropic` with a stub whose `messages.stream()` yields configured text chunks or raises)

**Interfaces:**
- Produces: `stream_reading(model: str, messages: list[dict]) -> Iterator[str]` yielding text deltas; after exhaustion, `stream_reading.usage` is not used — instead the function is a generator that returns `Usage(input_tokens, output_tokens)` via `StopIteration.value`. Raises `GenerationError(str)` on any SDK error or timeout (`timeout=120`, `max_tokens=2000` for paid, `600` for daily — pass `max_tokens` as a parameter).

- [ ] **Step 1: Write the failing tests**

```python
def test_yields_chunks_and_returns_usage(fake_anthropic):
    fake_anthropic.chunks = ["Hel", "lo"]; fake_anthropic.usage = (100, 20)
    gen = stream_reading("m", [], max_tokens=600); out = []
    try:
        while True: out.append(next(gen))
    except StopIteration as s: usage = s.value
    assert out == ["Hel","lo"] and (usage.input_tokens, usage.output_tokens) == (100, 20)
def test_sdk_error_becomes_generation_error(fake_anthropic):
    fake_anthropic.raise_on_stream = anthropic.APIStatusError(...)
    with pytest.raises(GenerationError): list(stream_reading("m", [], max_tokens=600))
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement generator.py using `client.messages.stream(...)` and `stream.text_stream`, reading `stream.get_final_message().usage`**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): anthropic streaming wrapper"`

---

### Task 12: Reading service — start, generate, refund, retry

**Files:**
- Create: `api/app/readings/service.py`, `api/tests/test_reading_service.py`

**Interfaces:**
- Consumes: `debit_for_reading`, `refund_reading`, `draw`, `build_messages`, `stream_reading`, `SpreadPrice`.
- Produces: `start_reading(db, user, spread_type, question, profile_id) -> Reading` (one transaction: validates spread ≠ `daily`, question ≤ 500, profile belongs to user if given; loads chart; `cost = SpreadPrice`; creates `Reading(status='pending', cards=draw(...))`; `debit_for_reading`; commits); `run_generation(db, reading: Reading, model: str | None = None, max_tokens: int = 2000) -> Iterator[str]` (builds messages; model defaults to `MODEL_PAID`, or `MODEL_DAILY` when `spread_type == 'daily'`; yields chunks, appends to `reading.text` every 20 chunks and on finish, sets `complete` + `model` + `token_usage`; on `GenerationError` or `GeneratorExit`/cancellation sets `failed`, refunds `cost`, re-raises for `GenerationError`); `retry_reading(db, user, reading_id) -> Reading` (only for `failed` readings owned by the user; debits again with `reference_id = f"{reading_id}:retry{n}"`, resets `text=""`, `status='pending'`, keeps `cards`).

- [ ] **Step 1: Write the failing tests**

```python
def test_start_debits_and_draws(db, user_with_credits(3)):
    r = start_reading(db, user, "celtic_cross", None, None)
    assert r.status == "pending" and len(r.cards) == 10 and balance(db, user.id) == 0
def test_start_insufficient_402(db, user): 
    with pytest.raises(InsufficientCredits): start_reading(db, user, "three_card", None, None)
def test_start_rejects_daily(db, user_with_credits(1)):
    with pytest.raises(ValidationFailed): start_reading(db, user, "daily", None, None)
def test_generation_completes(db, user_with_credits(1), fake_anthropic):
    fake_anthropic.chunks = ["a","b"]; r = start_reading(db, user, "three_card", None, None)
    assert "".join(run_generation(db, r)) == "ab"; db.refresh(r); assert r.status == "complete" and r.text == "ab"
def test_generation_failure_refunds(db, user_with_credits(1), fake_anthropic):
    fake_anthropic.raise_on_stream = ...; r = start_reading(db, user, "three_card", None, None)
    with pytest.raises(GenerationError): list(run_generation(db, r))
    db.refresh(r); assert r.status == "failed" and balance(db, user.id) == 1
def test_client_disconnect_refunds(db, user_with_credits(1), fake_anthropic):
    fake_anthropic.chunks = ["a"]*100; r = start_reading(db, user, "three_card", None, None)
    g = run_generation(db, r); next(g); g.close()          # simulates disconnect
    db.refresh(r); assert r.status == "failed" and balance(db, user.id) == 1
def test_retry_keeps_cards_and_debits(db, user_with_credits(2), fake_anthropic):
    # fail once, retry, assert same cards, balance 0, status pending
def test_chart_informed_reading_uses_chart(db, user_with_credits(1), profile, fake_anthropic):
    r = start_reading(db, user, "three_card", None, profile.id); list(run_generation(db, r))
    assert "Ascendant" in fake_anthropic.last_messages[0]["content"]
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement service.py** — wrap the body of `run_generation` in `try/except GeneratorExit` and `except GenerationError`, both calling a private `_fail_and_refund(db, reading)`.
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): reading service with debit, refund, retry"`

---

### Task 13: Reading SSE endpoints

**Files:**
- Create: `api/app/readings/router.py`, `api/tests/test_readings_api.py`
- Modify: `api/app/main.py`

**Interfaces:**
- Produces: `POST /readings` body `{spread_type, question?, profile_id?}` → `text/event-stream` with events in order: `event: cards` (`{reading_id, cost, cards:[{position, card_id, reversed}]}`), repeated `event: delta` (`{text}`), then `event: done` (`{reading_id}`) or `event: error` (`{code, message}`); 402 as a normal JSON error before any stream starts if credits are insufficient. `POST /readings/{id}/retry` → same stream. `GET /readings` → list (newest first, 50 max, fields: id, spread_type, cards, question, status, created_at, excerpt = first 160 chars). `GET /readings/{id}` → full. `GET /spreads` → `[{type, credits, positions}]` (public, no auth).

- [ ] **Step 1: Write the failing tests**

```python
def test_post_reading_streams_events(client, user_with_credits(1), fake_anthropic):
    fake_anthropic.chunks = ["Hi"]
    with client.stream("POST", "/readings", json={"spread_type":"three_card"}, headers=auth_headers(user)) as r:
        events = parse_sse(r.iter_lines())
    assert [e["event"] for e in events] == ["cards","delta","done"]
def test_post_reading_402_before_stream(client, user):
    r = client.post("/readings", json={"spread_type":"three_card"}, headers=auth_headers(user))
    assert r.status_code == 402 and r.json()["error"]["code"] == "insufficient_credits"
def test_generation_error_emits_error_event(client, user_with_credits(1), fake_anthropic): ...
def test_disconnect_marks_failed_and_refunds(client, db, user_with_credits(1), fake_anthropic):
    fake_anthropic.chunks = ["a"]*200
    with client.stream("POST", "/readings", json={"spread_type":"three_card"}, headers=auth_headers(user)) as r:
        next(r.iter_lines()); # read one line then exit the context → closes the response
    reading = db.query(Reading).one(); assert reading.status == "failed" and balance(db, user.id) == 1
def test_list_and_get(client, ...): ...
def test_spreads_public(client): assert client.get("/spreads").status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement router.py** — `StreamingResponse(media_type="text/event-stream")` with headers `Cache-Control: no-cache`, `X-Accel-Buffering: no`; the generator function calls `start_reading` *before* returning the response so 402 is a plain HTTP error.
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): reading SSE endpoints"`

---

### Task 14: Daily card

**Files:**
- Create: `api/app/daily/__init__.py`, `api/app/daily/service.py`, `api/app/daily/router.py`, `api/tests/test_daily.py`
- Modify: `api/app/main.py`

**Interfaces:**
- Produces: `get_or_create_daily(db, user, tz: str) -> tuple[Reading, bool]` (local date = `now_utc.astimezone(ZoneInfo(tz)).date()`; invalid tz → `ValidationFailed`; inserts `DailyDraw` + `Reading(spread_type='daily', status='pending')` inside a savepoint; on `IntegrityError` loads the existing draw and returns `(existing_reading, True)`); `POST /daily` body `{tz}` → if `already_drawn` and reading complete: JSON 200 `{reading}`; otherwise SSE identical to `/readings` (`cards`, `delta`, `done`) using `MODEL_DAILY`, `max_tokens=600`, and no debit. A daily reading whose generation failed is regenerated on the next call the same day (no new draw).

- [ ] **Step 1: Write the failing tests**

```python
def test_first_daily_streams(client, user, fake_anthropic): ...  # events cards, delta, done; balance unchanged
def test_second_daily_same_day_returns_existing(client, db, user, fake_anthropic):
    ...; r = client.post("/daily", json={"tz":"America/New_York"}, headers=auth_headers(user))
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
def test_invalid_tz_422(client, user): assert client.post("/daily", json={"tz":"Nope/Nope"}, headers=auth_headers(user)).status_code == 422
def test_new_local_day_new_card(client, db, user, fake_anthropic):
    with freeze_time("2026-11-03 23:00:00"): first = ...
    with freeze_time("2026-11-04 05:30:00"): second = ...   # 00:30 New York
    assert first_card != second_card or db.query(DailyDraw).count() == 2
def test_failed_daily_regenerates_without_redraw(client, db, user, fake_anthropic): ...
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement service.py and router.py, reusing `run_generation(db, reading, max_tokens=600)` from Task 12**
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): daily card"`

---

### Task 15: RevenueCat webhook

**Files:**
- Create: `api/app/billing/__init__.py`, `api/app/billing/revenuecat.py`, `api/app/billing/router.py`, `api/tests/test_billing.py`
- Modify: `api/app/main.py`, `api/app/config.py` (add `credit_products: dict[str,int]` default `{"sh_credits_5": 5, "sh_credits_15": 15, "sh_credits_40": 40}`)

**Interfaces:**
- Produces: `parse_event(payload: dict) -> PurchaseEvent(transaction_id, app_user_id: UUID, product_id, event_type) | None` (returns None for event types other than `NON_RENEWING_PURCHASE`; uses `event.transaction_id`, `event.app_user_id`, `event.product_id`); route `POST /billing/revenuecat` requiring header `Authorization: Bearer {revenuecat_webhook_secret}` (401 otherwise) → always 200 `{credited: bool, reason: str}` for valid auth: credits `credit_products[product_id]` via `credit(reason="purchase", reference_id=transaction_id)`; unknown product → `credited=false, reason="unknown_product"`; unknown user → `credited=false, reason="unknown_user"`; duplicate → `credited=false, reason="duplicate"`.

- [ ] **Step 1: Write the failing tests**

```python
def test_rejects_bad_secret(client): assert client.post("/billing/revenuecat", json={}, headers={"Authorization":"Bearer wrong"}).status_code == 401
def test_credits_purchase(client, db, user):
    r = client.post("/billing/revenuecat", json=rc_event(user.id, "sh_credits_5", "tx1"), headers=rc_auth())
    assert r.json() == {"credited": True, "reason": "ok"} and balance(db, user.id) == 5
def test_replay_is_noop(client, db, user):
    for _ in range(3): client.post(..., json=rc_event(user.id, "sh_credits_5", "tx1"), headers=rc_auth())
    assert balance(db, user.id) == 5
def test_unknown_product_200_no_credit(client, db, user):
    r = client.post(..., json=rc_event(user.id, "mystery", "tx9"), headers=rc_auth())
    assert r.status_code == 200 and r.json()["reason"] == "unknown_product" and balance(db, user.id) == 0
def test_non_purchase_event_ignored(client, db, user):
    r = client.post(..., json={**rc_event(user.id,"sh_credits_5","tx2"), "event": {..., "type": "TEST"}}, headers=rc_auth())
    assert r.json()["reason"] == "ignored_event_type"
def test_unknown_user_200_no_credit(client): ...
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement revenuecat.py and router.py** — verify the exact JSON shape against RevenueCat's current webhook docs before writing `parse_event`; adjust field paths if they differ, keeping the `PurchaseEvent` interface.
- [ ] **Step 4: Run tests to verify they pass** → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): revenuecat webhook crediting"`

---

### Task 16: Rate limiting, account deletion, CORS, deploy config

**Files:**
- Create: `api/app/ratelimit.py`, `api/tests/test_ratelimit.py`, `api/tests/test_account.py`, `api/README.md`
- Modify: `api/app/auth/router.py` (`DELETE /account`), `api/app/readings/router.py`, `api/app/daily/router.py`, `api/app/main.py` (CORS from `settings.cors_origins`)

**Interfaces:**
- Produces: `check_user_rate(db, user_id, kind: str, limit: int, window: timedelta)` raising `RateLimited` — counts `readings` rows for `kind='reading'` (limit 20/hour) and `daily` requests (limit 10/hour); `check_ip_rate(db, ip, kind, limit, window)` using `ip_events` — `POST /auth/anonymous` limited to 10/hour/IP and `POST /auth/magic/request` to 5/hour/IP. `DELETE /account` → 204; deletes the user and cascades profiles, charts, readings, daily draws, ledger (Play requires in-app deletion). README documents env vars, local run (`uvicorn app.main:app`), tests, Alembic, and Vercel deploy.

- [ ] **Step 1: Write the failing tests**

```python
def test_anonymous_mint_rate_limited(client):
    for _ in range(10): assert client.post("/auth/anonymous", headers={"X-Forwarded-For":"1.2.3.4"}).status_code == 201
    assert client.post("/auth/anonymous", headers={"X-Forwarded-For":"1.2.3.4"}).status_code == 429
def test_reading_rate_limited(client, db, user_with_credits(30), fake_anthropic):
    for _ in range(20): client.post("/readings", json={"spread_type":"three_card"}, headers=auth_headers(user))
    assert client.post("/readings", json={"spread_type":"three_card"}, headers=auth_headers(user)).status_code == 429
def test_delete_account_cascades(client, db, user, profile, reading):
    assert client.delete("/account", headers=auth_headers(user)).status_code == 204
    assert db.get(User, user.id) is None and db.query(Reading).count() == 0 and db.query(CreditLedger).count() == 0
def test_cors_allows_configured_origin(client):
    r = client.options("/me", headers={"Origin":"https://seventhhouse.app","Access-Control-Request-Method":"GET"})
    assert r.headers["access-control-allow-origin"] == "https://seventhhouse.app"
```

- [ ] **Step 2: Run tests to verify they fail** → FAIL
- [ ] **Step 3: Implement ratelimit.py, DELETE /account (set `ondelete="CASCADE"` on all user FKs in a migration `0003_cascades.py` if 0001 did not), CORS middleware, README**
- [ ] **Step 4: Run the full suite** — `cd api && pytest -v` → all PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(api): rate limits, account deletion, CORS, deploy docs"`

---

### Task 17: Deploy to Vercel and smoke test

**Files:**
- Create: `api/.vercelignore` (exclude `tests/`, `requirements-dev.txt`), `.github/workflows/api-tests.yml` (runs pytest against a Neon branch created per run; secrets `NEON_API_KEY`, `NEON_PROJECT_ID`)

**Interfaces:**
- Produces: a live `https://<api-project>.vercel.app/health` returning `{"status":"ok"}`; Alembic migrations applied to the production Neon database; env vars set in Vercel for every `Settings` field.

- [ ] **Step 1: Create the Vercel project from the `api/` root directory, set env vars, run `alembic upgrade head` against the production DATABASE_URL from a local shell**
- [ ] **Step 2: Deploy** — `vercel --prod` from `api/`; Expected: deployment URL printed, build succeeds, function size under Vercel's limit with the 32 MB kernel (if over, move `de440s.bsp` to Vercel Blob and load it from URL at cold start, caching in `/tmp`).
- [ ] **Step 3: Smoke** — `curl $URL/health` → `{"status":"ok"}`; `curl -X POST $URL/auth/anonymous` → 201; `curl $URL/spreads` → three spreads.
- [ ] **Step 4: Point the RevenueCat webhook at `$URL/billing/revenuecat` with the bearer secret; send a test event from the RevenueCat dashboard; confirm a ledger row appears.**
- [ ] **Step 5: Commit** — `git commit -m "chore(api): CI workflow and vercel ignore"`

---

## Self-review notes

- **Spec coverage:** §3.2 modules → Tasks 3–16; §4 data model → Task 2 (+0002, 0003); §4.1 debit rule → Tasks 3 and 12; §5.1–5.5 → Tasks 6–8, 10–12; §6.1 auth → Tasks 4–5; §7 error handling → Tasks 12–16; §8 testing → each task; §9 deployment → Task 17. §6 screens, §6.2 Android, §10 launch steps belong to Plans 2 and 3.
- **Type consistency:** `DrawnCard`, `ChartData`, `Reading`, `GenerationError`, `InsufficientCredits`, `ValidationFailed`, `RateLimited` are defined once (Tasks 1, 6, 8, 11, 2) and used by name thereafter. `run_generation` carries `model`/`max_tokens` parameters from Task 12 so Task 14 needs no signature change.
- **Review Focus:** items 1–5 have tests in Tasks 7, 8, 12/13, 15, 14 respectively.
- **Proportion:** plan is ~1.3× the spec; code blocks are tests and signatures, not bodies.
