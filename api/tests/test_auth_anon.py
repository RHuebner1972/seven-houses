from uuid import uuid4

import pytest
from freezegun import freeze_time

from app.auth.jwt import mint_token, verify_token
from app.errors import Unauthorized
from app.ledger.service import credit
from app.models import User
from tests.conftest import auth_headers


def test_anonymous_creates_user_and_token(client, db):
    r = client.post("/auth/anonymous")
    assert r.status_code == 201
    claims = verify_token(r.json()["token"])
    assert claims.anon is True
    assert str(claims.user_id) == r.json()["user_id"]
    created = db.get(User, claims.user_id)
    assert created is not None
    assert created.email is None


def test_me_requires_auth(client):
    r = client.get("/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_me_rejects_malformed_header_and_garbage_token(client):
    assert client.get("/me", headers={"Authorization": "Basic abc"}).status_code == 401
    assert client.get("/me", headers={"Authorization": "Bearer not-a-jwt"}).status_code == 401


def test_me_rejects_token_for_unknown_user(client):
    token = mint_token(uuid4(), True)
    r = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_me_returns_balance(client, db, user):
    credit(db, user.id, 2, "grant", "g1")
    db.commit()
    r = client.get("/me", headers=auth_headers(user))
    assert r.status_code == 200
    assert r.json() == {"user_id": str(user.id), "email": None, "anon": True, "balance": 2}


def test_me_reports_non_anonymous_user(client, db):
    u = User(email="a@example.com")
    db.add(u)
    db.commit()
    r = client.get("/me", headers=auth_headers(u))
    assert r.json()["anon"] is False
    assert r.json()["email"] == "a@example.com"


def test_expired_token_rejected():
    with freeze_time("2026-01-01"):
        t = mint_token(uuid4(), True)
    with freeze_time("2026-01-30"):
        verify_token(t)
    with freeze_time("2026-02-15"):
        with pytest.raises(Unauthorized):
            verify_token(t)


def test_tampered_token_rejected():
    t = mint_token(uuid4(), True)
    with pytest.raises(Unauthorized):
        verify_token(t[:-2] + ("AA" if not t.endswith("AA") else "BB"))


def test_non_uuid_sub_rejected():
    import jwt

    from app.config import get_settings

    t = jwt.encode({"sub": "nope", "anon": True}, get_settings().jwt_secret, algorithm="HS256")
    with pytest.raises(Unauthorized):
        verify_token(t)


def test_refresh_returns_new_token(client, db, user):
    with freeze_time("2026-01-01"):
        headers = auth_headers(user)
    with freeze_time("2026-01-10"):
        r = client.post("/auth/refresh", headers=headers)
    assert r.status_code == 200
    new = r.json()["token"]
    assert new != headers["Authorization"].removeprefix("Bearer ")
    with freeze_time("2026-01-10"):
        claims = verify_token(new)
    assert claims.user_id == user.id and claims.anon is True


def test_refresh_requires_auth(client):
    assert client.post("/auth/refresh").status_code == 401
