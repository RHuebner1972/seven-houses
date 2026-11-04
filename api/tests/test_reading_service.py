from uuid import uuid4

import anthropic
import httpx
import pytest
from sqlalchemy import func, select

from app.errors import InsufficientCredits, NotFound, ValidationFailed
from app.ledger.service import balance
from app.models import CreditLedger, Reading
from app.readings.generator import GenerationError
from app.readings.service import retry_reading, run_generation, start_reading


def _conn_error() -> anthropic.APIConnectionError:
    return anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))


def _ledger(db, user):
    """(reason, delta, reference_id) rows for `user`, grants excluded, in insertion order."""
    rows = db.execute(
        select(CreditLedger.reason, CreditLedger.delta, CreditLedger.reference_id)
        .where(CreditLedger.user_id == user.id, CreditLedger.reason != "grant")
        .order_by(CreditLedger.id)
    ).all()
    return [tuple(r) for r in rows]


def _fail_once(db, user, fake_anthropic, spread="three_card"):
    fake_anthropic.raise_on_stream = _conn_error()
    r = start_reading(db, user, spread, None, None)
    with pytest.raises(GenerationError):
        list(run_generation(db, r))
    fake_anthropic.raise_on_stream = None
    return r


# --- start_reading ---------------------------------------------------------


def test_start_debits_and_draws(db, user, user_with_credits):
    user_with_credits(3)
    r = start_reading(db, user, "celtic_cross", None, None)
    assert r.status == "pending" and len(r.cards) == 10 and balance(db, user.id) == 0
    assert _ledger(db, user) == [("reading", -3, str(r.id))]
    assert {c["position"] for c in r.cards} >= {"present", "outcome"}
    assert r.chart_id is None and r.question is None


def test_start_insufficient_402(db, user):
    with pytest.raises(InsufficientCredits):
        start_reading(db, user, "three_card", None, None)
    assert db.scalar(select(func.count()).select_from(Reading)) == 0
    assert _ledger(db, user) == []


def test_start_insufficient_leaves_session_usable(db, user, user_with_credits):
    user_with_credits(1)
    with pytest.raises(InsufficientCredits):
        start_reading(db, user, "celtic_cross", None, None)
    assert db.scalar(select(func.count()).select_from(Reading)) == 0
    r = start_reading(db, user, "three_card", None, None)
    assert r.status == "pending" and balance(db, user.id) == 0


def test_start_rejects_daily(db, user, user_with_credits):
    user_with_credits(1)
    with pytest.raises(ValidationFailed):
        start_reading(db, user, "daily", None, None)
    assert balance(db, user.id) == 1


def test_start_rejects_unknown_spread(db, user, user_with_credits):
    user_with_credits(1)
    with pytest.raises(ValidationFailed):
        start_reading(db, user, "horseshoe", None, None)


def test_start_question_stripped_and_blank_is_none(db, user, user_with_credits):
    user_with_credits(2)
    r1 = start_reading(db, user, "three_card", "  will it work?  ", None)
    r2 = start_reading(db, user, "three_card", "   ", None)
    assert r1.question == "will it work?" and r2.question is None


def test_start_rejects_long_question(db, user, user_with_credits):
    user_with_credits(1)
    with pytest.raises(ValidationFailed):
        start_reading(db, user, "three_card", "x" * 501, None)
    assert balance(db, user.id) == 1
    r = start_reading(db, user, "three_card", "x" * 500, None)
    assert len(r.question) == 500


def test_start_with_profile_sets_chart(db, user, user_with_credits, profile):
    user_with_credits(1)
    r = start_reading(db, user, "three_card", None, profile.id)
    assert r.chart_id is not None


def test_start_rejects_other_users_profile(db, other_user, user_with_credits, profile):
    user_with_credits(1)
    from app.ledger.service import credit

    credit(db, other_user.id, 1, "grant", "g-other")
    db.commit()
    with pytest.raises(NotFound):
        start_reading(db, other_user, "three_card", None, profile.id)
    with pytest.raises(NotFound):
        start_reading(db, other_user, "three_card", None, uuid4())
    assert balance(db, other_user.id) == 1


# --- run_generation --------------------------------------------------------


def test_generation_completes(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    fake_anthropic.chunks = ["a", "b"]
    fake_anthropic.usage = (11, 22)
    r = start_reading(db, user, "three_card", None, None)
    assert "".join(run_generation(db, r)) == "ab"
    db.refresh(r)
    assert r.status == "complete" and r.text == "ab"
    assert r.model == "claude-sonnet-4-5"
    assert r.token_usage == {"input_tokens": 11, "output_tokens": 22}
    assert fake_anthropic.last_kwargs["model"] == "claude-sonnet-4-5"
    assert fake_anthropic.last_kwargs["max_tokens"] == 2000
    assert balance(db, user.id) == 0
    assert _ledger(db, user) == [("reading", -1, str(r.id))]


def test_generation_uses_given_model_and_max_tokens(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    fake_anthropic.chunks = ["a"]
    r = start_reading(db, user, "three_card", None, None)
    list(run_generation(db, r, model="claude-x", max_tokens=600))
    assert fake_anthropic.last_kwargs["model"] == "claude-x"
    assert fake_anthropic.last_kwargs["max_tokens"] == 600
    db.refresh(r)
    assert r.model == "claude-x"


def test_daily_reading_uses_daily_model_and_never_refunds(db, user, fake_anthropic):
    from app.tarot.draw import draw

    r = Reading(
        user_id=user.id,
        spread_type="daily",
        cards=[c.model_dump() for c in draw("daily")],
        status="pending",
    )
    db.add(r)
    db.commit()
    fake_anthropic.chunks = ["a"]
    list(run_generation(db, r, max_tokens=600))
    assert fake_anthropic.last_kwargs["model"] == "claude-haiku-4-5"
    fake_anthropic.raise_on_stream = _conn_error()
    r.status = "pending"
    db.commit()
    with pytest.raises(GenerationError):
        list(run_generation(db, r, max_tokens=600))
    db.refresh(r)
    assert r.status == "failed" and _ledger(db, user) == []


def test_generation_passes_question_and_cards(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    fake_anthropic.chunks = ["a"]
    r = start_reading(db, user, "three_card", "my question", None)
    list(run_generation(db, r))
    content = fake_anthropic.last_messages[0]["content"]
    assert "<question>my question</question>" in content
    assert "Natal chart:" not in content


def test_generation_persists_partial_text_every_20_chunks(
    db, engine, user, user_with_credits, fake_anthropic
):
    from sqlalchemy.orm import Session

    user_with_credits(1)
    fake_anthropic.chunks = ["x"] * 45
    r = start_reading(db, user, "three_card", None, None)
    g = run_generation(db, r)
    seen = []
    for _ in range(21):
        next(g)
    with Session(engine) as other:
        seen.append(other.get(Reading, r.id).text)
    for _ in range(20):
        next(g)
    with Session(engine) as other:
        seen.append(other.get(Reading, r.id).text)
    rest = list(g)
    assert seen == ["x" * 20, "x" * 40] and len(rest) == 4
    db.refresh(r)
    assert r.text == "x" * 45 and r.status == "complete"


def test_generation_failure_refunds(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    r = _fail_once(db, user, fake_anthropic)
    db.refresh(r)
    assert r.status == "failed" and balance(db, user.id) == 1
    assert _ledger(db, user) == [("reading", -1, str(r.id)), ("refund", 1, f"{r.id}:refund")]


def test_generation_midstream_failure_keeps_partial_text(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    fake_anthropic.chunks = ["a", "b", "c"]
    fake_anthropic.raise_after_chunks = 2
    fake_anthropic.error = _conn_error()
    r = start_reading(db, user, "three_card", None, None)
    got = []
    with pytest.raises(GenerationError):
        for chunk in run_generation(db, r):
            got.append(chunk)
    assert got == ["a", "b"]
    db.refresh(r)
    assert r.status == "failed" and r.text == "ab" and balance(db, user.id) == 1


def test_client_disconnect_refunds(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    fake_anthropic.chunks = ["a"] * 100
    r = start_reading(db, user, "three_card", None, None)
    g = run_generation(db, r)
    next(g)
    g.close()  # simulates disconnect
    db.refresh(r)
    assert r.status == "failed" and balance(db, user.id) == 1
    assert r.text == "a"
    assert _ledger(db, user) == [("reading", -1, str(r.id)), ("refund", 1, f"{r.id}:refund")]


def test_unexpected_error_also_refunds(db, user, user_with_credits, fake_anthropic, monkeypatch):
    from app.readings import service

    def boom(*a, **kw):
        raise RuntimeError("bug")

    monkeypatch.setattr(service, "build_messages", boom)
    user_with_credits(1)
    r = start_reading(db, user, "three_card", None, None)
    with pytest.raises(RuntimeError):
        list(run_generation(db, r))
    db.refresh(r)
    assert r.status == "failed" and balance(db, user.id) == 1


def test_chart_informed_reading_uses_chart(db, user, user_with_credits, profile, fake_anthropic):
    user_with_credits(1)
    fake_anthropic.chunks = ["a"]
    r = start_reading(db, user, "three_card", None, profile.id)
    list(run_generation(db, r))
    content = fake_anthropic.last_messages[0]["content"]
    assert "Ascendant" in content
    assert "Natal chart:" in content and "\nAscendant: " in content


# --- retry_reading ---------------------------------------------------------


def test_retry_keeps_cards_and_debits(db, user, user_with_credits, fake_anthropic):
    # 1 credit: debit -> refund on failure -> re-debit on retry leaves 0
    user_with_credits(1)
    r = _fail_once(db, user, fake_anthropic)
    cards = list(r.cards)
    r2 = retry_reading(db, user, r.id)
    assert r2.id == r.id and r2.cards == cards
    assert r2.status == "pending" and r2.text == "" and balance(db, user.id) == 0
    assert r2.token_usage["retries"] == 1
    assert _ledger(db, user)[-1] == ("reading", -1, f"{r.id}:retry1")


def test_retry_then_success(db, user, user_with_credits, fake_anthropic):
    user_with_credits(2)
    r = _fail_once(db, user, fake_anthropic)
    r = retry_reading(db, user, r.id)
    fake_anthropic.chunks = ["ok"]
    fake_anthropic.usage = (1, 2)
    assert "".join(run_generation(db, r)) == "ok"
    db.refresh(r)
    assert r.status == "complete" and r.text == "ok"
    assert r.token_usage == {"input_tokens": 1, "output_tokens": 2, "retries": 1}
    assert balance(db, user.id) == 1
    assert _ledger(db, user) == [
        ("reading", -1, str(r.id)),
        ("refund", 1, f"{r.id}:refund"),
        ("reading", -1, f"{r.id}:retry1"),
    ]


def test_retry_then_failure_refunds_again(db, user, user_with_credits, fake_anthropic):
    user_with_credits(2)
    r = _fail_once(db, user, fake_anthropic)
    r = retry_reading(db, user, r.id)
    fake_anthropic.raise_on_stream = _conn_error()
    with pytest.raises(GenerationError):
        list(run_generation(db, r))
    db.refresh(r)
    assert r.status == "failed" and balance(db, user.id) == 2
    assert _ledger(db, user) == [
        ("reading", -1, str(r.id)),
        ("refund", 1, f"{r.id}:refund"),
        ("reading", -1, f"{r.id}:retry1"),
        ("refund", 1, f"{r.id}:retry1:refund"),
    ]
    # a second retry uses a fresh reference
    r = retry_reading(db, user, r.id)
    assert r.token_usage["retries"] == 2
    assert _ledger(db, user)[-1] == ("reading", -1, f"{r.id}:retry2")


def test_retry_disconnect_refunds_retry_reference(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    r = _fail_once(db, user, fake_anthropic)
    r = retry_reading(db, user, r.id)
    fake_anthropic.chunks = ["a"] * 5
    g = run_generation(db, r)
    next(g)
    g.close()
    assert balance(db, user.id) == 1
    assert _ledger(db, user)[-1] == ("refund", 1, f"{r.id}:retry1:refund")


def test_retry_insufficient_credits_leaves_reading_failed(db, user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    r = _fail_once(db, user, fake_anthropic)
    db.execute(CreditLedger.__table__.delete().where(CreditLedger.reason == "refund"))
    db.commit()
    with pytest.raises(InsufficientCredits):
        retry_reading(db, user, r.id)
    db.refresh(r)
    assert r.status == "failed" and not (r.token_usage or {}).get("retries")


def test_retry_rejects_non_failed(db, user, user_with_credits, fake_anthropic):
    user_with_credits(2)
    fake_anthropic.chunks = ["a"]
    r = start_reading(db, user, "three_card", None, None)
    with pytest.raises(ValidationFailed):
        retry_reading(db, user, r.id)  # pending
    list(run_generation(db, r))
    with pytest.raises(ValidationFailed):
        retry_reading(db, user, r.id)  # complete
    assert balance(db, user.id) == 1


def test_retry_other_users_reading_not_found(db, user, other_user, user_with_credits, fake_anthropic):
    user_with_credits(1)
    r = _fail_once(db, user, fake_anthropic)
    with pytest.raises(NotFound):
        retry_reading(db, other_user, r.id)
    with pytest.raises(NotFound):
        retry_reading(db, user, uuid4())


def test_generation_refuses_non_pending_reading_without_refund(
    db, user, user_with_credits, fake_anthropic
):
    user_with_credits(1)
    fake_anthropic.chunks = ["a"]
    r = start_reading(db, user, "three_card", None, None)
    list(run_generation(db, r))
    with pytest.raises(ValidationFailed):
        list(run_generation(db, r))
    db.refresh(r)
    assert r.status == "complete" and balance(db, user.id) == 0


def test_fail_if_pending_fails_and_refunds_pending(db, user_with_credits):
    from app.readings.service import fail_if_pending

    user = user_with_credits(1)
    r = start_reading(db, user, "three_card", None, None)
    assert fail_if_pending(db, r.id) is True
    db.expire_all()
    assert db.get(Reading, r.id).status == "failed" and balance(db, user.id) == 1
    assert fail_if_pending(db, r.id) is False
    assert balance(db, user.id) == 1


def test_fail_if_pending_leaves_completed_reading_alone(db, user_with_credits, fake_anthropic):
    from app.readings.service import fail_if_pending

    user = user_with_credits(1)
    fake_anthropic.chunks = ["done"]
    r = start_reading(db, user, "three_card", None, None)
    assert "".join(run_generation(db, r)) == "done"
    before = _ledger(db, user)
    assert fail_if_pending(db, r.id) is False
    db.expire_all()
    row = db.get(Reading, r.id)
    assert row.status == "complete" and row.text == "done"
    assert _ledger(db, user) == before and balance(db, user.id) == 0


def test_fail_if_pending_ignores_a_later_attempt(db, user_with_credits, fake_anthropic):
    """A stale cleanup for attempt 0 must not fail a retry that is now pending."""
    from app.readings.service import fail_if_pending

    user = user_with_credits(2)
    r = start_reading(db, user, "three_card", None, None)
    fail_if_pending(db, r.id)
    retry_reading(db, user, r.id)
    assert fail_if_pending(db, r.id, attempt=0) is False
    db.expire_all()
    assert db.get(Reading, r.id).status == "pending" and balance(db, user.id) == 1
    assert fail_if_pending(db, r.id, attempt=1) is True
    assert balance(db, user.id) == 2


def test_fail_if_pending_unknown_id(db):
    from app.readings.service import fail_if_pending

    assert fail_if_pending(db, uuid4()) is False
