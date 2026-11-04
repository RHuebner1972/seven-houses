from datetime import timedelta

import pytest

from app.errors import RateLimited
from app.models import IpEvent, Reading
from app.ratelimit import check_ip_rate, check_user_rate
from tests.conftest import auth_headers

XFF = {"X-Forwarded-For": "1.2.3.4"}
HOUR = timedelta(hours=1)


def test_anonymous_mint_rate_limited(client):
    for _ in range(10):
        assert client.post("/auth/anonymous", headers=XFF).status_code == 201
    r = client.post("/auth/anonymous", headers=XFF)
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"


def test_anonymous_mint_limit_is_per_ip(client):
    for _ in range(11):
        client.post("/auth/anonymous", headers=XFF)
    assert client.post("/auth/anonymous", headers={"X-Forwarded-For": "5.6.7.8"}).status_code == 201


def test_forwarded_for_uses_first_hop(client, db):
    client.post("/auth/anonymous", headers={"X-Forwarded-For": "9.9.9.9, 10.0.0.1"})
    assert db.query(IpEvent).one().ip == "9.9.9.9"


def test_magic_request_rate_limited(client, user, fake_resend):
    body = {"email": "a@x.io"}
    for _ in range(5):
        r = client.post("/auth/magic/request", json=body, headers={**auth_headers(user), **XFF})
        assert r.status_code == 202
    r = client.post("/auth/magic/request", json=body, headers={**auth_headers(user), **XFF})
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


def test_reading_rate_limited(client, db, user_with_credits, fake_anthropic):
    user = user_with_credits(30)
    fake_anthropic.chunks = ["x"]
    for _ in range(20):
        r = client.post("/readings", json={"spread_type": "three_card"}, headers=auth_headers(user))
        assert r.status_code == 200
    r = client.post("/readings", json={"spread_type": "three_card"}, headers=auth_headers(user))
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


def _events(db, user, kind, n, minutes_ago=0):
    from datetime import UTC, datetime

    from app.models import GenerationEvent

    at = datetime.now(UTC) - timedelta(minutes=minutes_ago)
    for _ in range(n):
        db.add(GenerationEvent(user_id=user.id, kind=kind, created_at=at))
    db.commit()


def _post_and_disconnect(client, url, user, json=None):
    with client.stream("POST", url, json=json, headers=auth_headers(user)) as r:
        assert r.status_code == 200


def test_retry_rate_limited(client, db, user_with_credits, fake_anthropic):
    """Every paid stream (new or retry) records a generation event, even one the
    client abandoned before any text: disconnect-and-retry cannot dodge the limit."""
    user = user_with_credits(30)
    fake_anthropic.chunks = ["x"] * 50
    _events(db, user, "reading", 18)
    _post_and_disconnect(client, "/readings", user, {"spread_type": "three_card"})  # 19
    db.expire_all()
    reading = db.query(Reading).one()
    assert reading.status == "failed"
    _post_and_disconnect(client, f"/readings/{reading.id}/retry", user)  # 20
    db.expire_all()
    assert db.get(Reading, reading.id).status == "failed"
    r = client.post(f"/readings/{reading.id}/retry", headers=auth_headers(user))
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


def test_daily_rate_limited(client, db, user, fake_anthropic):
    """Ten failed daily generations (each a regeneration of the same reading) use
    up the hour's daily budget; the 11th attempt is refused before Claude is called."""
    import anthropic
    import httpx

    fake_anthropic.raise_on_stream = anthropic.APIConnectionError(
        request=httpx.Request("POST", "https://api.anthropic.com")
    )
    for _ in range(10):
        with client.stream("POST", "/daily", json={"tz": "UTC"}, headers=auth_headers(user)) as r:
            assert r.status_code == 200
            list(r.iter_lines())
    assert db.query(Reading).count() == 1
    fake_anthropic.last_kwargs = None
    r = client.post("/daily", json={"tz": "UTC"}, headers=auth_headers(user))
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert fake_anthropic.last_kwargs is None


def test_completed_daily_still_returned_when_rate_limited(client, db, user, fake_anthropic):
    fake_anthropic.chunks = ["Once"]
    with client.stream("POST", "/daily", json={"tz": "UTC"}, headers=auth_headers(user)) as r:
        list(r.iter_lines())
    _events(db, user, "daily", 10)
    r = client.post("/daily", json={"tz": "UTC"}, headers=auth_headers(user))
    assert r.status_code == 200 and r.json()["reading"]["text"] == "Once"


def test_user_rate_ignores_old_and_other_users(db, user, other_user):
    _events(db, user, "reading", 3, minutes_ago=120)
    _events(db, other_user, "reading", 3)
    check_user_rate(db, user.id, "reading", 1, HOUR)  # old + other's rows don't count
    _events(db, user, "reading", 1)
    with pytest.raises(RateLimited):
        check_user_rate(db, user.id, "reading", 1, HOUR)
    check_user_rate(db, user.id, "daily", 1, HOUR)  # daily counted separately


def test_record_generation_inserts_event(db, user):
    from app.models import GenerationEvent
    from app.ratelimit import record_generation

    record_generation(db, user.id, "daily")
    db.expire_all()
    row = db.query(GenerationEvent).one()
    assert (row.user_id, row.kind) == (user.id, "daily") and row.created_at is not None


def test_ip_rate_records_attempt_before_raising(db):
    for _ in range(2):
        check_ip_rate(db, "1.1.1.1", "k", 2, HOUR)
    with pytest.raises(RateLimited):
        check_ip_rate(db, "1.1.1.1", "k", 2, HOUR)
    db.rollback()
    assert db.query(IpEvent).filter_by(ip="1.1.1.1").count() == 3
