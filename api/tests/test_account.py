from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.config import Settings
from app.main import create_app
from app.models import (
    BirthProfile,
    CreditLedger,
    DailyDraw,
    MagicToken,
    Reading,
    User,
)
from tests.conftest import auth_headers


def _count(db, model, user_id):
    return db.scalar(select(func.count()).select_from(model).where(model.user_id == user_id))


def test_delete_account_cascades(client, db, user, other_user, user_with_credits, profile, fake_anthropic):
    from datetime import UTC, datetime, timedelta

    user_with_credits(5)
    fake_anthropic.chunks = ["x"]
    client.post("/readings", json={"spread_type": "three_card", "profile_id": str(profile.id)}, headers=auth_headers(user))
    client.post("/daily", json={"tz": "UTC"}, headers=auth_headers(user))
    db.add(MagicToken(token_hash="h", email="a@x.io", user_id=user.id, expires_at=datetime.now(UTC) + timedelta(hours=1)))
    db.add(Reading(user_id=other_user.id, spread_type="three_card", cards=[], status="complete"))
    db.add(MagicToken(token_hash="h2", email="b@x.io", user_id=other_user.id, expires_at=datetime.now(UTC) + timedelta(hours=1)))
    db.commit()
    uid, oid = user.id, other_user.id
    for model in (Reading, CreditLedger, BirthProfile, DailyDraw, MagicToken):
        assert _count(db, model, uid) > 0, model

    r = client.delete("/account", headers=auth_headers(user))
    assert r.status_code == 204 and r.content == b""

    db.expire_all()
    assert db.get(User, uid) is None
    for model in (Reading, CreditLedger, BirthProfile, DailyDraw, MagicToken):
        assert _count(db, model, uid) == 0, model
    assert db.get(User, oid) is not None
    assert _count(db, Reading, oid) == 1 and _count(db, MagicToken, oid) == 1


def test_delete_account_requires_auth(client):
    assert client.delete("/account").status_code == 401


def test_deleted_user_token_is_rejected(client, user):
    headers = auth_headers(user)
    assert client.delete("/account", headers=headers).status_code == 204
    assert client.get("/me", headers=headers).status_code == 401


def test_cors_allows_configured_origin(db):
    app = create_app(Settings(cors_origins=["https://seventhhouse.app"]))
    with TestClient(app) as c:
        r = c.options(
            "/me",
            headers={"Origin": "https://seventhhouse.app", "Access-Control-Request-Method": "GET"},
        )
        assert r.headers["access-control-allow-origin"] == "https://seventhhouse.app"
        assert "access-control-allow-credentials" not in r.headers
        r = c.options(
            "/me",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"},
        )
        assert "access-control-allow-origin" not in r.headers
