import hashlib
from datetime import timedelta

import pytest
from freezegun import freeze_time
from sqlalchemy import select

from app.auth import google, linking, magic
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
    db.expire_all()
    assert db.get(User, user.id) is None  # anonymous user merged into the owner and removed


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
    assert row.token_hash == hashlib.sha256(fake_resend.extract_token().encode()).hexdigest()
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
    r = client.post("/auth/magic/verify", json={"token": token}, headers=auth_headers(user))
    assert r.status_code == 200
    assert r.json()["user_id"] == str(user.id)
    assert verify_token(r.json()["token"]).anon is False
    db.refresh(user)
    assert (user.email, user.auth_provider, user.auth_subject) == ("a@x.io", "email", None)
    assert client.post("/auth/magic/verify", json={"token": token}).status_code == 401


def test_magic_verify_without_bearer_creates_new_user_not_requester(client, db, user, fake_resend):
    """Pre-signup takeover guard: someone who obtains the link but not the
    requesting device's token must not be linked into the requester's account."""
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    r = client.post("/auth/magic/verify", json={"token": fake_resend.extract_token()})
    assert r.status_code == 200
    new_id = r.json()["user_id"]
    assert new_id != str(user.id)
    new = db.get(User, verify_token(r.json()["token"]).user_id)
    assert (new.email, new.auth_provider, new.auth_subject) == ("a@x.io", "email", None)
    db.refresh(user)
    assert user.email is None
    me = client.get("/me", headers=auth_headers(user)).json()
    assert me["user_id"] == str(user.id) and me["anon"] is True and me["email"] is None


def test_magic_verify_with_other_users_bearer_is_401_and_unspent(
    client, db, user, other_user, fake_resend
):
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    token = fake_resend.extract_token()
    r = client.post("/auth/magic/verify", json={"token": token}, headers=auth_headers(other_user))
    assert r.status_code == 401
    db.refresh(other_user)
    db.refresh(user)
    assert other_user.email is None and user.email is None
    r = client.post("/auth/magic/verify", json={"token": token}, headers=auth_headers(user))
    assert r.status_code == 200 and r.json()["user_id"] == str(user.id)


def test_magic_verify_with_invalid_bearer_is_401(client, user, fake_resend):
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    r = client.post(
        "/auth/magic/verify",
        json={"token": fake_resend.extract_token()},
        headers={"Authorization": "Bearer nope"},
    )
    assert r.status_code == 401


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


def test_google_changed_email_owned_by_other_returns_owner(client, db, fake_google):
    linked = User(email="old@x.io", auth_provider="google", auth_subject="g1")
    owner = User(email="a@x.io")
    db.add_all([linked, owner])
    db.commit()
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(linked))
    assert r.status_code == 200
    assert r.json()["user_id"] == str(owner.id)
    db.refresh(linked)
    assert linked.email == "old@x.io"


def test_google_changed_email_free_updates_in_place(client, db, fake_google):
    linked = User(email="old@x.io", auth_provider="google", auth_subject="g1")
    db.add(linked)
    db.commit()
    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(linked))
    assert r.json()["user_id"] == str(linked.id)
    db.refresh(linked)
    assert linked.email == "a@x.io"


def test_commit_race_resolves_to_email_owner(db, engine, user, monkeypatch):
    from sqlalchemy.orm import sessionmaker

    real = linking._find_owner
    calls = []

    def racing(*args):
        result = real(*args)
        if not calls:  # competitor commits after our lookup, before our commit
            with sessionmaker(engine)() as other:
                other.add(User(email="a@x.io"))
                other.commit()
        calls.append(1)
        return result

    monkeypatch.setattr(linking, "_find_owner", racing)
    result = linking.link_and_commit(db, user, "email", None, "a@x.io")
    assert result.id != user.id
    assert result.email == "a@x.io"


def test_linked_user_not_overwritten_by_other_identity(client, db, fake_resend):
    g = User(email="g@x.io", auth_provider="google", auth_subject="g9")
    db.add(g)
    db.commit()
    client.post("/auth/magic/request", json={"email": "other@x.io"}, headers=auth_headers(g))
    r = client.post(
        "/auth/magic/verify", json={"token": fake_resend.extract_token()}, headers=auth_headers(g)
    )
    assert r.status_code == 422
    db.refresh(g)
    assert (g.email, g.auth_provider, g.auth_subject) == ("g@x.io", "google", "g9")


def test_magic_send_failure_still_202_and_no_row(client, db, user, monkeypatch, caplog):
    def boom(to, link):
        raise RuntimeError("resend down")

    monkeypatch.setattr(magic, "send_magic_link_email", boom)
    r = client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    assert r.status_code == 202
    assert db.scalars(select(MagicToken)).all() == []
    assert "Failed to send magic link email" in caplog.text


# --- merging anonymous data on link -----------------------------------------


def _anon_with_data(db, user, profile, fake_anthropic):
    """`user` (anonymous) with a profile, a completed paid reading (1 debited), 3
    credits left, and daily draws on 2026-11-01 and 2026-11-02."""
    from datetime import date
    from uuid import uuid4

    from app.ledger.service import credit
    from app.models import DailyDraw, Reading
    from app.readings.service import run_generation, start_reading

    credit(db, user.id, 4, "grant", f"grant-{uuid4()}")
    db.commit()
    fake_anthropic.chunks = ["ok"]
    reading = start_reading(db, user, "three_card", None, profile.id)
    list(run_generation(db, reading))
    card = {"position": "today", "card_id": "the_fool", "reversed": False}
    for day in (1, 2):
        daily = Reading(user_id=user.id, spread_type="daily", cards=[card], status="complete")
        db.add(daily)
        db.flush()
        db.add(DailyDraw(user_id=user.id, local_date=date(2026, 11, day), card=card, reading_id=daily.id))
    db.commit()
    return reading


def test_google_link_merges_anonymous_data_into_existing_owner(
    client, db, user, profile, other_user_google_g1, fake_google, fake_anthropic
):
    from datetime import date
    from uuid import uuid4

    from sqlalchemy import func

    from app.ledger.service import balance, credit
    from app.models import BirthProfile, CreditLedger, DailyDraw, GenerationEvent, Reading
    from app.ratelimit import record_generation

    owner = other_user_google_g1
    reading = _anon_with_data(db, user, profile, fake_anthropic)
    record_generation(db, user.id, "reading")
    credit(db, owner.id, 2, "grant", f"grant-{uuid4()}")
    card = {"position": "today", "card_id": "the_sun", "reversed": False}
    db.add(DailyDraw(user_id=owner.id, local_date=date(2026, 11, 1), card=card))
    db.commit()
    assert balance(db, user.id) == 3
    total_before = db.scalar(select(func.sum(CreditLedger.delta)))

    r = client.post("/auth/google", json={"id_token": "x"}, headers=auth_headers(user))
    assert r.status_code == 200 and r.json()["user_id"] == str(owner.id)

    db.expire_all()
    assert db.get(User, user.id) is None
    assert db.get(BirthProfile, profile.id).user_id == owner.id
    assert db.get(Reading, reading.id).user_id == owner.id
    assert db.query(Reading).filter_by(user_id=owner.id).count() == 3  # paid + 2 daily
    assert db.query(GenerationEvent).one().user_id == owner.id
    assert balance(db, owner.id) == 2 + 3
    assert db.scalar(select(func.sum(CreditLedger.delta))) == total_before
    assert db.query(CreditLedger).filter_by(reference_id=str(reading.id)).one().user_id == owner.id
    transfer_in = db.query(CreditLedger).filter_by(reason="transfer_in").one()
    assert (transfer_in.delta, transfer_in.reference_id) == (4, f"transfer:{user.id}:in")
    draws = {(d.local_date.day, d.card["card_id"]) for d in db.query(DailyDraw).filter_by(user_id=owner.id)}
    assert draws == {(1, "the_sun"), (2, "the_fool")}  # owner's Nov 1 kept, anon's Nov 2 moved
    assert client.get("/me", headers=auth_headers(user)).status_code == 401


def test_merge_failure_leaves_both_users_untouched(
    db, engine, user, profile, other_user_google_g1, fake_anthropic, monkeypatch
):
    from sqlalchemy.orm import Session

    from app.ledger.service import balance
    from app.models import BirthProfile, Reading

    reading = _anon_with_data(db, user, profile, fake_anthropic)

    def boom(*a, **kw):
        raise RuntimeError("mid-merge failure")

    monkeypatch.setattr(linking, "balance", boom)  # after profiles/readings were re-pointed
    with pytest.raises(RuntimeError):
        linking.link_and_commit(db, user, "google", "g1", "a@x.io")
    with Session(engine) as other:
        assert other.get(User, user.id) is not None
        assert other.get(BirthProfile, profile.id).user_id == user.id
        assert other.get(Reading, reading.id).user_id == user.id
        assert balance(other, user.id) == 3 and balance(other, other_user_google_g1.id) == 0


def test_magic_verify_with_bearer_merges_into_existing_owner(
    client, db, user, profile, fake_resend
):
    from app.models import BirthProfile

    existing = User(email="a@x.io", auth_provider="email")
    db.add(existing)
    db.commit()
    client.post("/auth/magic/request", json={"email": "a@x.io"}, headers=auth_headers(user))
    token = fake_resend.extract_token()
    r = client.post("/auth/magic/verify", json={"token": token}, headers=auth_headers(user))
    assert r.status_code == 200 and r.json()["user_id"] == str(existing.id)
    db.expire_all()
    assert db.get(User, user.id) is None
    assert db.get(BirthProfile, profile.id).user_id == existing.id
    assert client.post("/auth/magic/verify", json={"token": token}).status_code == 401
