import anthropic
import httpx
from freezegun import freeze_time

from app.ledger.service import balance
from app.models import DailyDraw, Reading
from tests.conftest import auth_headers
from tests.sse import parse_sse

NY = {"tz": "America/New_York"}


def _post(client, user, body=NY):
    with client.stream("POST", "/daily", json=body, headers=auth_headers(user)) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        return parse_sse(r.iter_lines())


def test_first_daily_streams(client, db, user, fake_anthropic):
    fake_anthropic.chunks = ["Your", " card"]
    before = balance(db, user.id)
    events = _post(client, user)

    assert [e["event"] for e in events] == ["cards", "delta", "delta", "done"]
    assert events[0]["data"]["cost"] == 0
    assert len(events[0]["data"]["cards"]) == 1
    reading = db.query(Reading).one()
    db.refresh(reading)
    assert reading.spread_type == "daily"
    assert reading.status == "complete" and reading.text == "Your card"
    assert db.query(DailyDraw).count() == 1
    assert balance(db, user.id) == before


def test_second_daily_same_day_returns_existing(client, db, user, fake_anthropic):
    fake_anthropic.chunks = ["Once"]
    events = _post(client, user)
    reading_id = events[0]["data"]["reading_id"]

    r = client.post("/daily", json=NY, headers=auth_headers(user))
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    body = r.json()["reading"]
    assert body["id"] == reading_id
    assert body["text"] == "Once" and body["status"] == "complete"
    assert body["cards"] == events[0]["data"]["cards"]
    assert db.query(DailyDraw).count() == 1 and db.query(Reading).count() == 1


def test_invalid_tz_422(client, db, user):
    r = client.post("/daily", json={"tz": "Nope/Nope"}, headers=auth_headers(user))
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"
    assert db.query(DailyDraw).count() == 0 and db.query(Reading).count() == 0


def test_new_local_day_new_card(client, db, user, fake_anthropic):
    fake_anthropic.chunks = ["a"]
    with freeze_time("2026-11-03 23:00:00"):  # 18:00 New York, Nov 3
        first = _post(client, user)
    with freeze_time("2026-11-04 05:30:00"):  # 00:30 New York, Nov 4
        second = _post(client, user)

    assert first[0]["data"]["reading_id"] != second[0]["data"]["reading_id"]
    assert db.query(DailyDraw).count() == 2
    assert db.query(Reading).count() == 2


def test_failed_daily_regenerates_without_redraw(client, db, user, fake_anthropic):
    before = balance(db, user.id)
    fake_anthropic.raise_on_stream = anthropic.APIConnectionError(
        request=httpx.Request("POST", "https://api.anthropic.com")
    )
    events = _post(client, user)
    assert events[-1]["event"] == "error"
    db.expire_all()
    failed = db.query(Reading).one()
    assert failed.status == "failed"
    cards = failed.cards

    fake_anthropic.raise_on_stream = None
    fake_anthropic.chunks = ["Fine"]
    events = _post(client, user)

    assert [e["event"] for e in events] == ["cards", "delta", "done"]
    assert events[0]["data"]["reading_id"] == str(failed.id)
    assert events[0]["data"]["cards"] == cards
    db.expire_all()
    reading = db.query(Reading).one()
    assert reading.status == "complete" and reading.text == "Fine"
    assert db.query(DailyDraw).count() == 1
    assert balance(db, user.id) == before
