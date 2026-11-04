from datetime import UTC, datetime, timedelta
from uuid import uuid4

import anthropic
import httpx
import pytest

from app.db import get_db
from app.ledger.service import balance
from app.models import Reading
from tests.conftest import auth_headers
from tests.sse import parse_sse


def _conn_error() -> anthropic.APIConnectionError:
    return anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))


def _stream(client, url, user, json=None):
    with client.stream("POST", url, json=json, headers=auth_headers(user)) as r:
        assert r.status_code == 200
        return r, parse_sse(r.iter_lines())


def _reading(db) -> Reading:
    db.expire_all()
    return db.query(Reading).one()


def test_post_reading_streams_events(client, db, user_with_credits, fake_anthropic):
    user = user_with_credits(1)
    fake_anthropic.chunks = ["Hi", " there"]
    r, events = _stream(client, "/readings", user, {"spread_type": "three_card", "question": "Q?"})

    assert [e["event"] for e in events] == ["cards", "delta", "delta", "done"]
    reading = _reading(db)
    cards = events[0]["data"]
    assert cards["reading_id"] == str(reading.id) and cards["cost"] == 1
    assert [c["position"] for c in cards["cards"]] == ["past", "present", "future"]
    assert set(cards["cards"][0]) == {"position", "card_id", "reversed"}
    assert [e["data"]["text"] for e in events[1:3]] == ["Hi", " there"]
    assert events[3]["data"] == {"reading_id": str(reading.id)}
    assert reading.status == "complete" and reading.text == "Hi there"
    assert balance(db, user.id) == 0


def test_post_reading_sse_headers(client, user_with_credits, fake_anthropic):
    user = user_with_credits(1)
    fake_anthropic.chunks = ["Hi"]
    r, _ = _stream(client, "/readings", user, {"spread_type": "three_card"})
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["x-accel-buffering"] == "no"
    assert r.headers["connection"] == "keep-alive"


def test_post_reading_402_before_stream(client, db, user):
    r = client.post("/readings", json={"spread_type": "three_card"}, headers=auth_headers(user))
    assert r.status_code == 402 and r.json()["error"]["code"] == "insufficient_credits"
    assert r.headers["content-type"].startswith("application/json")
    assert db.query(Reading).count() == 0


def test_post_reading_validation_and_profile_errors_are_json(client, user_with_credits):
    user = user_with_credits(5)
    r = client.post("/readings", json={"spread_type": "daily"}, headers=auth_headers(user))
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"
    r = client.post(
        "/readings",
        json={"spread_type": "three_card", "profile_id": str(uuid4())},
        headers=auth_headers(user),
    )
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_post_reading_requires_auth(client):
    r = client.post("/readings", json={"spread_type": "three_card"})
    assert r.status_code == 401


def test_generation_error_emits_error_event(client, db, user_with_credits, fake_anthropic):
    user = user_with_credits(1)
    fake_anthropic.chunks = ["a", "b"]
    fake_anthropic.raise_after_chunks = 1
    fake_anthropic.error = _conn_error()
    _, events = _stream(client, "/readings", user, {"spread_type": "three_card"})

    assert [e["event"] for e in events] == ["cards", "delta", "error"]
    assert events[2]["data"]["code"] == "generation_failed"
    assert events[2]["data"]["message"]
    reading = _reading(db)
    assert reading.status == "failed" and balance(db, user.id) == 1


def test_disconnect_marks_failed_and_refunds(client, db, user_with_credits, fake_anthropic):
    user = user_with_credits(1)
    fake_anthropic.chunks = ["a"] * 200
    with client.stream(
        "POST", "/readings", json={"spread_type": "three_card"}, headers=auth_headers(user)
    ) as r:
        assert next(r.iter_lines()) == "event: cards"
    # Exiting the context closes the response; TestClient cancels the app task and
    # waits for it to finish, so the reading's final state is already persisted.
    reading = _reading(db)
    assert reading.status == "failed"
    assert balance(db, user.id) == 1


def test_stream_runs_before_db_dependency_is_closed(client, db, user_with_credits, fake_anthropic):
    """The request's session must stay open for the whole stream."""
    user = user_with_credits(1)
    state = {"closed": False, "seen_closed": []}

    def tracked_get_db():
        try:
            yield db
        finally:
            state["closed"] = True

    def chunks():
        for text in ["x", "y"]:
            state["seen_closed"].append(state["closed"])
            yield text

    client.app.dependency_overrides[get_db] = tracked_get_db
    fake_anthropic.chunks = chunks()
    _, events = _stream(client, "/readings", user, {"spread_type": "three_card"})

    assert [e["event"] for e in events][-1] == "done"
    assert state["seen_closed"] == [False, False]
    assert state["closed"] is True
    assert _reading(db).status == "complete"


def _failed_reading(client, db, user, fake_anthropic) -> Reading:
    fake_anthropic.raise_on_stream = _conn_error()
    _, events = _stream(client, "/readings", user, {"spread_type": "three_card"})
    assert events[-1]["event"] == "error"
    fake_anthropic.raise_on_stream = None
    return _reading(db)


def test_retry_streams_same_events(client, db, user_with_credits, fake_anthropic):
    user = user_with_credits(1)
    failed = _failed_reading(client, db, user, fake_anthropic)
    assert balance(db, user.id) == 1

    fake_anthropic.chunks = ["Again"]
    _, events = _stream(client, f"/readings/{failed.id}/retry", user)

    assert [e["event"] for e in events] == ["cards", "delta", "done"]
    assert events[0]["data"]["reading_id"] == str(failed.id)
    assert events[0]["data"]["cards"] == failed.cards
    reading = _reading(db)
    assert reading.status == "complete" and reading.text == "Again"
    assert balance(db, user.id) == 0


def test_retry_errors_are_json(client, db, user_with_credits, other_user, fake_anthropic):
    user = user_with_credits(1)
    r = client.post(f"/readings/{uuid4()}/retry", headers=auth_headers(user))
    assert r.status_code == 404

    failed = _failed_reading(client, db, user, fake_anthropic)
    r = client.post(f"/readings/{failed.id}/retry", headers=auth_headers(other_user))
    assert r.status_code == 404

    fake_anthropic.chunks = ["ok"]
    _stream(client, f"/readings/{failed.id}/retry", user)
    r = client.post(f"/readings/{failed.id}/retry", headers=auth_headers(user))
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"


def _make_reading(db, user, minutes_ago: int, text: str = "", status: str = "complete"):
    r = Reading(
        user_id=user.id,
        spread_type="three_card",
        cards=[{"position": "past", "card_id": "the_fool", "reversed": False}],
        question=f"q{minutes_ago}",
        text=text,
        status=status,
        created_at=datetime.now(UTC) - timedelta(minutes=minutes_ago),
    )
    db.add(r)
    db.commit()
    return r


def test_list_and_get(client, db, user, other_user):
    old = _make_reading(db, user, 10, text="x" * 300)
    new = _make_reading(db, user, 1, text="short")
    _make_reading(db, other_user, 5)

    r = client.get("/readings", headers=auth_headers(user))
    assert r.status_code == 200
    items = r.json()
    assert [i["id"] for i in items] == [str(new.id), str(old.id)]
    assert set(items[0]) == {
        "id", "spread_type", "cards", "question", "status", "created_at", "excerpt"
    }
    assert items[1]["excerpt"] == "x" * 160
    assert items[0]["excerpt"] == "short"

    r = client.get("/readings?limit=1", headers=auth_headers(user))
    assert [i["id"] for i in r.json()] == [str(new.id)]
    assert client.get("/readings?limit=51", headers=auth_headers(user)).status_code == 422
    assert client.get("/readings?limit=0", headers=auth_headers(user)).status_code == 422

    r = client.get(f"/readings/{old.id}", headers=auth_headers(user))
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == str(old.id) and body["text"] == "x" * 300
    assert body["cards"] == old.cards and body["status"] == "complete"

    assert client.get(f"/readings/{old.id}", headers=auth_headers(other_user)).status_code == 404
    assert client.get(f"/readings/{uuid4()}", headers=auth_headers(user)).status_code == 404


def test_list_default_limit_is_20(client, db, user):
    for i in range(25):
        _make_reading(db, user, i)
    assert len(client.get("/readings", headers=auth_headers(user)).json()) == 20
    assert len(client.get("/readings?limit=50", headers=auth_headers(user)).json()) == 25


def test_spreads_public(client):
    r = client.get("/spreads")
    assert r.status_code == 200
    spreads = {s["type"]: s for s in r.json()}
    assert set(spreads) == {"daily", "three_card", "celtic_cross"}
    three = spreads["three_card"]
    assert set(three) == {"type", "name", "credits", "positions"}
    assert three["credits"] == 1 and three["name"] == "Three Card"
    assert three["positions"][0] == {
        "key": "past",
        "name": "Past",
        "meaning": "The background and earlier events that shaped the situation.",
    }
    assert spreads["daily"]["credits"] == 0


def test_disconnect_before_any_line_marks_failed_and_refunds(
    client, db, user_with_credits, fake_anthropic
):
    """Closing before the first event is read leaves run_generation unstarted;
    the response-level cleanup must still fail and refund the reading."""
    user = user_with_credits(1)
    fake_anthropic.chunks = ["a"] * 200
    with client.stream(
        "POST", "/readings", json={"spread_type": "three_card"}, headers=auth_headers(user)
    ) as r:
        assert r.status_code == 200
    reading = _reading(db)
    assert reading.status == "failed"
    assert balance(db, user.id) == 1


def test_cancel_at_next_await_still_closes_generator(
    db, user_with_credits, fake_anthropic, monkeypatch
):
    """Cancellation delivered at event_stream's `await` on the threadpool `next`
    (anyio's pre-thread checkpoint; the thread call itself is shielded, so a cancel
    issued mid-`next` lands at the following checkpoint instead). The shielded
    finally must still close run_generation, which fails and refunds."""
    import anyio

    from app.readings import router
    from app.readings.router import _stream
    from app.readings.service import run_generation, start_reading

    # Keep the inner generator referenced so CPython's refcount finalisation cannot
    # close it for us: only the shielded finally may.
    held = []
    monkeypatch.setattr(
        router, "run_generation", lambda *a, **k: held.append(run_generation(*a, **k)) or held[-1]
    )
    user = user_with_credits(1)
    fake_anthropic.chunks = ["a", "b", "c"]
    reading = start_reading(db, user, "three_card", None, None)
    agen = _stream(db, reading, 1).body_iterator

    async def main():
        assert (await agen.__anext__()).startswith("event: cards")
        assert (await agen.__anext__()).startswith("event: delta")
        with anyio.CancelScope() as scope:
            scope.cancel()
            await agen.__anext__()
        assert scope.cancelled_caught
        with pytest.raises(StopAsyncIteration):
            await agen.__anext__()  # the generator finished during cancellation

    anyio.run(main)
    db.expire_all()
    assert db.get(Reading, reading.id).status == "failed"
    assert balance(db, user.id) == 1
    assert held[0].gi_frame is None  # closed, not merely abandoned
