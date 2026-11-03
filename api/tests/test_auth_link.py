from datetime import timedelta

import pytest
from freezegun import freeze_time
from sqlalchemy import select

from app.auth import google
from app.auth.jwt import verify_token
from app.errors import Unauthorized
from app.models import MagicToken, User
from tests.conftest import auth_headers


def test_google_links_current_user(client, db, user, fake_google):
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.status_code == 200
    db.refresh(user)
    assert (user.email, user.auth_provider, user.auth_subject) == ("a@x.io", "google", "g1")
    claims = verify_token(r.json()["token"])
    assert claims.anon is False
    assert r.json()["user_id"] == str(user.id)


def test_google_existing_identity_returns_existing_user(
    client, db, user, other_user_google_g1, fake_google
):
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.status_code == 200
    assert r.json()["user_id"] == str(other_user_google_g1.id)
    assert verify_token(r.json()["token"]).user_id == other_user_google_g1.id
    db.refresh(user)
    assert user.email is None  # abandoned, untouched


def test_google_existing_email_returns_existing_user(client, db, user, fake_google):
    existing = User(email="a@x.io")
    db.add(existing)
    db.commit()
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.json()["user_id"] == str(existing.id)


def test_google_requires_auth(client, fake_google):
    assert client.post("/auth/google", json={"id_token": "x"}).status_code == 401


def test_google_invalid_token_is_401(client, user, monkeypatch):
    def boom(*a):
        raise ValueError("bad")

    monkeypatch.setattr(google, "_verify_oauth2_token", boom)
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.status_code == 401


def test_google_unverified_email_rejected(monkeypatch):
    monkeypatch.setattr(
        google,
        "_verify_oauth2_token",
        lambda *a: {"sub": "g1", "email": "a@x.io", "email_verified": False},
    )
    with pytest.raises(Unauthorized):
        google.verify_google_id_token("x")


def test_magic_request_sends_email(client, db, user, fake_resend):
    r = client.post(
        "/auth/magic/request", json={"email": "A@X.io"}, headers=auth_headers(user)
    )
    assert r.status_code == 202
    assert r.json() == {}
    assert fake_resend.sent[0]["to"] == "a@x.io"
    assert "/auth/magic?token=" in fake_resend.sent[0]["link"]
    row = db.scalars(select(MagicToken)).one()
    assert row.token_hash != fake_resend.extract_token()
    assert row.user_id == user.id


def test_magic_request_invalid_email_still_202_no_send(client, db, user, fake_resend):
    r = client.post(
        "/auth/magic/request", json={"email": "not-an-email"}, headers=auth_headers(user)
    )
    assert r.status_code == 202
    assert fake_resend.sent == []
    assert db.scalars(select(MagicToken)).all() == []


def test_magic_request_requires_auth(client, fake_resend):
    r = client.post("/auth/magic/request", json={"email": "a@x.io"})
    assert r.status_code == 401


def test_magic_verify_links_and_is_single_use(client, db, user, fake_resend):
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    token = fake_resend.extract_token()
    r = client.post("/auth/magic/verify", json={"token": token})
    assert r.status_code == 200
    assert r.json()["user_id"] == str(user.id)
    assert verify_token(r.json()["token"]).anon is False
    db.refresh(user)
    assert (user.email, user.auth_provider, user.auth_subject) == ("a@x.io", "email", None)
    assert client.post("/auth/magic/verify", json={"token": token}).status_code == 401


def test_magic_verify_unknown_token(client):
    assert client.post("/auth/magic/verify", json={"token": "nope"}).status_code == 401


def test_magic_verify_existing_email_returns_existing_user(client, db, user, fake_resend):
    existing = User(email="a@x.io")
    db.add(existing)
    db.commit()
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    r = client.post("/auth/magic/verify", json={"token": fake_resend.extract_token()})
    assert r.json()["user_id"] == str(existing.id)


@pytest.mark.parametrize("minutes,status", [(14, 200), (16, 401)])
def test_magic_token_expiry(client, user, fake_resend, minutes, status):
    with freeze_time("2026-11-03 12:00:00") as frozen:
        client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
        token = fake_resend.extract_token()
        frozen.tick(timedelta(minutes=minutes))
        r = client.post("/auth/magic/verify", json={"token": token})
    assert r.status_code == status
