import logging
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.billing.revenuecat import NoUsableUser, parse_event
from app.config import Settings, get_settings
from app.db import get_db
from app.ledger.service import balance
from app.main import create_app
from app.models import CreditLedger

SECRET = "rc-test-secret"
URL = "/billing/revenuecat"


def rc_event(
    user_id,
    product_id,
    transaction_id,
    *,
    type="NON_RENEWING_PURCHASE",
    environment="PRODUCTION",
    **event_overrides,
):
    event = {
        "type": type,
        "id": f"evt-{transaction_id}",
        "app_user_id": str(user_id),
        "original_app_user_id": str(user_id),
        "aliases": [str(user_id)],
        "product_id": product_id,
        "transaction_id": transaction_id,
        "original_transaction_id": transaction_id,
        "store": "PLAY_STORE",
        "environment": environment,
        "event_timestamp_ms": 1762128000000,
    }
    event.update(event_overrides)
    return {"api_version": "1.0", "event": event}


def rc_auth(secret=SECRET):
    return {"Authorization": f"Bearer {secret}"}


@pytest.fixture
def settings():
    return Settings(env="test", revenuecat_webhook_secret=SECRET)


@pytest.fixture
def make_client(db, settings):
    clients = []

    def make(**overrides):
        s = settings.model_copy(update=overrides)
        app = create_app()
        app.dependency_overrides[get_db] = lambda: db
        app.dependency_overrides[get_settings] = lambda: s
        c = TestClient(app)
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.close()


@pytest.fixture
def client(make_client):
    return make_client()


def ledger_rows(db):
    db.rollback()
    return db.query(CreditLedger).count()


def test_rejects_bad_secret(client):
    r = client.post(URL, json={}, headers=rc_auth("wrong"))
    assert r.status_code == 401


def test_rejects_missing_header(client, user):
    assert client.post(URL, json=rc_event(user.id, "sh_credits_5", "tx0")).status_code == 401


def test_empty_secret_is_always_401(make_client, user):
    c = make_client(revenuecat_webhook_secret="")
    body = rc_event(user.id, "sh_credits_5", "tx0")
    assert c.post(URL, json=body, headers={"Authorization": "Bearer "}).status_code == 401
    assert c.post(URL, json=body, headers={"Authorization": "Bearer"}).status_code == 401
    assert c.post(URL, json=body).status_code == 401


def test_credits_purchase(client, db, user):
    r = client.post(URL, json=rc_event(user.id, "sh_credits_5", "tx1"), headers=rc_auth())
    assert r.status_code == 200
    assert r.json() == {"credited": True, "reason": "ok"}
    assert balance(db, user.id) == 5


def test_credits_amount_per_product(client, db, user):
    client.post(URL, json=rc_event(user.id, "sh_credits_15", "tx15"), headers=rc_auth())
    client.post(URL, json=rc_event(user.id, "sh_credits_40", "tx40"), headers=rc_auth())
    assert balance(db, user.id) == 55


def test_replay_is_noop(client, db, user):
    results = [
        client.post(URL, json=rc_event(user.id, "sh_credits_5", "tx1"), headers=rc_auth())
        for _ in range(3)
    ]
    assert [r.json()["reason"] for r in results] == ["ok", "duplicate", "duplicate"]
    assert [r.json()["credited"] for r in results] == [True, False, False]
    assert balance(db, user.id) == 5
    assert ledger_rows(db) == 1


def test_unknown_product_200_no_credit(client, db, user):
    r = client.post(URL, json=rc_event(user.id, "mystery", "tx9"), headers=rc_auth())
    assert r.status_code == 200
    assert r.json() == {"credited": False, "reason": "unknown_product"}
    assert balance(db, user.id) == 0
    assert ledger_rows(db) == 0


def test_non_purchase_event_ignored(client, db, user):
    for t in ("TEST", "INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "TRANSFER"):
        r = client.post(
            URL, json=rc_event(user.id, "sh_credits_5", f"tx-{t}", type=t), headers=rc_auth()
        )
        assert r.status_code == 200
        assert r.json() == {"credited": False, "reason": "ignored_event_type"}
    assert ledger_rows(db) == 0


def test_unknown_user_200_no_credit(client, db):
    r = client.post(URL, json=rc_event(uuid4(), "sh_credits_5", "tx3"), headers=rc_auth())
    assert r.status_code == 200
    assert r.json() == {"credited": False, "reason": "unknown_user"}
    assert ledger_rows(db) == 0


def test_non_uuid_app_user_id_is_unknown_user(client, db):
    body = rc_event(
        "$RCAnonymousID:abc",
        "sh_credits_5",
        "tx4",
        original_app_user_id="$RCAnonymousID:abc",
        aliases=["$RCAnonymousID:abc"],
    )
    r = client.post(URL, json=body, headers=rc_auth())
    assert r.json() == {"credited": False, "reason": "unknown_user"}
    assert ledger_rows(db) == 0


def test_original_app_user_id_fallback_credits_right_user(client, db, user, other_user):
    body = rc_event(
        user.id, "sh_credits_5", "tx5", app_user_id="$RCAnonymousID:abc", aliases=[]
    )
    r = client.post(URL, json=body, headers=rc_auth())
    assert r.json() == {"credited": True, "reason": "ok"}
    assert balance(db, user.id) == 5
    assert balance(db, other_user.id) == 0


def test_alias_fallback_credits_right_user(client, db, user):
    body = rc_event(
        user.id,
        "sh_credits_5",
        "tx6",
        app_user_id="$RCAnonymousID:abc",
        original_app_user_id="$RCAnonymousID:def",
        aliases=["$RCAnonymousID:abc", str(user.id)],
    )
    assert client.post(URL, json=body, headers=rc_auth()).json()["reason"] == "ok"
    assert balance(db, user.id) == 5


def test_sandbox_rejected_in_prod(make_client, db, user):
    c = make_client(env="prod", jwt_secret="x" * 32)
    r = c.post(
        URL,
        json=rc_event(user.id, "sh_credits_5", "tx7", environment="SANDBOX"),
        headers=rc_auth(),
    )
    assert r.status_code == 200
    assert r.json() == {"credited": False, "reason": "sandbox"}
    assert ledger_rows(db) == 0


def test_production_accepted_in_prod(make_client, db, user):
    c = make_client(env="prod", jwt_secret="x" * 32)
    r = c.post(URL, json=rc_event(user.id, "sh_credits_5", "tx7"), headers=rc_auth())
    assert r.json() == {"credited": True, "reason": "ok"}


def test_sandbox_accepted_in_test_env(client, db, user):
    r = client.post(
        URL,
        json=rc_event(user.id, "sh_credits_5", "tx8", environment="SANDBOX"),
        headers=rc_auth(),
    )
    assert r.json() == {"credited": True, "reason": "ok"}


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"api_version": "1.0"},
        {"event": "nope"},
        {"event": {"type": "NON_RENEWING_PURCHASE"}},
        [1, 2],
    ],
)
def test_malformed_payload_200(client, db, body):
    r = client.post(URL, json=body, headers=rc_auth())
    assert r.status_code == 200
    assert r.json() == {"credited": False, "reason": "malformed"}
    assert ledger_rows(db) == 0


def test_non_json_body_is_malformed(client):
    r = client.post(URL, content=b"not json", headers=rc_auth())
    assert r.status_code == 200
    assert r.json() == {"credited": False, "reason": "malformed"}


def test_missing_environment_is_malformed_and_not_credited(client, db, user):
    body = rc_event(user.id, "sh_credits_5", "tx10")
    del body["event"]["environment"]
    r = client.post(URL, json=body, headers=rc_auth())
    assert r.json() == {"credited": False, "reason": "malformed"}
    assert ledger_rows(db) == 0


def test_non_credited_outcomes_log_warning(client, user, caplog):
    with caplog.at_level(logging.WARNING, logger="app.billing.router"):
        client.post(URL, json=rc_event(user.id, "mystery", "tx11"), headers=rc_auth())
    msg = caplog.records[-1].getMessage()
    assert "unknown_product" in msg and "evt-tx11" in msg and "mystery" in msg


def test_parse_event_unit():
    uid = uuid4()
    ev = parse_event(rc_event(uid, "sh_credits_5", "t"))
    assert ev.app_user_id == uid and ev.transaction_id == "t" and ev.store == "PLAY_STORE"
    assert parse_event(rc_event(uid, "sh_credits_5", "t", type="TEST")) is None
    with pytest.raises(NoUsableUser):
        parse_event(rc_event("x", "p", "t", original_app_user_id="y", aliases=["z"]))
