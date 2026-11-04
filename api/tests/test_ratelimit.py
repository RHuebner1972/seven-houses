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


def test_retry_rate_limited(client, db, user_with_credits, fake_anthropic):
    user = user_with_credits(30)
    fake_anthropic.chunks = ["x"]
    client.post("/readings", json={"spread_type": "three_card"}, headers=auth_headers(user))
    reading = db.query(Reading).one()
    for _ in range(19):
        db.add(Reading(user_id=user.id, spread_type="three_card", cards=[], status="complete"))
    db.commit()
    r = client.post(f"/readings/{reading.id}/retry", headers=auth_headers(user))
    assert r.status_code == 429


def test_daily_rate_limited(client, db, user, fake_anthropic):
    for _ in range(10):
        db.add(Reading(user_id=user.id, spread_type="daily", cards=[], status="complete"))
    db.commit()
    r = client.post("/daily", json={"tz": "UTC"}, headers=auth_headers(user))
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


def test_user_rate_ignores_old_and_other_users(db, user, other_user):
    from datetime import UTC, datetime

    old = datetime.now(UTC) - timedelta(hours=2)
    for _ in range(3):
        db.add(Reading(user_id=user.id, spread_type="three_card", cards=[], status="complete", created_at=old))
        db.add(Reading(user_id=other_user.id, spread_type="three_card", cards=[], status="complete"))
    db.commit()
    check_user_rate(db, user.id, "reading", 1, HOUR)  # old + other's rows don't count
    db.add(Reading(user_id=user.id, spread_type="three_card", cards=[], status="complete"))
    db.commit()
    with pytest.raises(RateLimited):
        check_user_rate(db, user.id, "reading", 1, HOUR)
    check_user_rate(db, user.id, "daily", 1, HOUR)  # daily counted separately


def test_ip_rate_records_attempt_before_raising(db):
    for _ in range(2):
        check_ip_rate(db, "1.1.1.1", "k", 2, HOUR)
    with pytest.raises(RateLimited):
        check_ip_rate(db, "1.1.1.1", "k", 2, HOUR)
    db.rollback()
    assert db.query(IpEvent).filter_by(ip="1.1.1.1").count() == 3
