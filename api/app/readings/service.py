"""Reading lifecycle: debit -> draw -> generate -> complete, or fail -> refund.

Invariant: every debit for a reading is matched by exactly one refund unless that
generation attempt completed. Debit references are `str(reading.id)` for the first
attempt and f"{reading.id}:retry{n}" for retry n; the matching refund reference is
the debit reference plus ":refund". Both are unique in the ledger, so refunds are
idempotent.
"""

from collections.abc import Iterator
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.astro.chart import ChartData
from app.config import get_settings
from app.errors import InsufficientCredits, NotFound, ValidationFailed
from app.ledger.service import debit_for_reading, refund_reading
from app.models import BirthProfile, Chart, Reading, SpreadPrice, User
from app.readings.generator import stream_reading
from app.readings.prompts import QUESTION_MAX_CHARS, build_messages
from app.tarot.draw import DrawnCard, draw
from app.tarot.spreads import SPREADS

PERSIST_EVERY_CHUNKS = 20
# A pending reading not written for this long has no live stream behind it (the
# generation deadline is well inside it); it may be failed and refunded.
STALE_PENDING = timedelta(minutes=6)


def _cost(db: Session, spread_type: str) -> int:
    return db.get(SpreadPrice, spread_type).credits


def _retries(reading: Reading) -> int:
    return (reading.token_usage or {}).get("retries", 0)


def current_attempt(reading: Reading) -> int:
    """The generation attempt a reading is on: 0 for the first, n for retry n."""
    return _retries(reading)


def _debit_reference(reading_id: UUID, retry: int) -> str:
    return f"{reading_id}:retry{retry}" if retry else str(reading_id)


def start_reading(
    db: Session,
    user: User,
    spread_type: str,
    question: str | None,
    profile_id: UUID | None,
) -> Reading:
    """Validate, draw, create a pending reading and debit its cost in one transaction."""
    if spread_type not in SPREADS or spread_type == "daily":
        raise ValidationFailed(f"spread_type: unknown or not purchasable: {spread_type!r}")
    question = (question or "").strip() or None
    if question is not None and len(question) > QUESTION_MAX_CHARS:
        raise ValidationFailed(f"question: must be at most {QUESTION_MAX_CHARS} characters")

    chart_id = None
    if profile_id is not None:
        profile = db.scalar(
            select(BirthProfile).where(
                BirthProfile.id == profile_id, BirthProfile.user_id == user.id
            )
        )
        if profile is None:
            raise NotFound("Birth profile not found")
        chart_id = db.scalar(select(Chart.id).where(Chart.birth_profile_id == profile.id))

    cost = _cost(db, spread_type)
    reading = Reading(
        user_id=user.id,
        spread_type=spread_type,
        cards=[c.model_dump() for c in draw(spread_type)],
        question=question,
        chart_id=chart_id,
        status="pending",
    )
    try:
        db.add(reading)
        db.flush()
        debit_for_reading(db, user.id, cost, reading.id)
    except InsufficientCredits:
        db.rollback()
        raise
    db.commit()
    return reading


def run_generation(
    db: Session, reading: Reading, model: str | None = None, max_tokens: int = 2000
) -> Iterator[str]:
    """Stream the reading text. On completion mark it complete; on any failure
    (including the caller closing the generator) mark it failed and refund."""
    if reading.status != "pending":
        raise ValidationFailed(f"reading is {reading.status}, not pending")
    settings = get_settings()
    if model is None:
        model = settings.model_daily if reading.spread_type == "daily" else settings.model_paid
    buffer = ""
    stream = None
    try:
        chart = None
        if reading.chart_id is not None:
            row = db.get(Chart, reading.chart_id)
            if row is not None:
                chart = ChartData.model_validate(row.data)
        cards = [DrawnCard.model_validate(c) for c in reading.cards]
        messages = build_messages(reading.spread_type, cards, reading.question, chart)

        stream = stream_reading(model, messages, max_tokens)
        count = 0
        while True:
            try:
                chunk = next(stream)
            except StopIteration as stop:
                usage = stop.value
                break
            buffer += chunk
            count += 1
            yield chunk
            if count % PERSIST_EVERY_CHUNKS == 0:
                reading.text = buffer
                db.commit()

        token_usage = {"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens}
        if _retries(reading):
            token_usage["retries"] = _retries(reading)
        reading.text = buffer
        reading.status = "complete"
        reading.model = model
        reading.token_usage = token_usage
        db.commit()
    except GeneratorExit:
        # Client disconnected; a generator must not yield after GeneratorExit.
        _close(stream)
        _fail_and_refund(db, reading, buffer)
        return
    except Exception:
        # GenerationError and anything unexpected: never keep credits for an
        # undelivered reading.
        _close(stream)
        _fail_and_refund(db, reading, buffer)
        raise


def _close(stream) -> None:
    if stream is not None:
        stream.close()


def _fail_and_refund(db: Session, reading: Reading, partial_text: str = "") -> None:
    db.rollback()  # the session may be mid-transaction
    reading.status = "failed"
    if len(partial_text) > len(reading.text or ""):
        reading.text = partial_text
    cost = _cost(db, reading.spread_type)
    if cost > 0:
        retry = _retries(reading)
        refund_reading(
            db,
            reading.user_id,
            cost,
            reading.id,
            reference_id=f"{_debit_reference(reading.id, retry)}:refund",
        )
    db.commit()


def fail_if_pending(db: Session, reading_id: UUID, attempt: int | None = None) -> bool:
    """Fail and refund the reading if it is still pending; return whether it did.

    A safety net for streams that end before `run_generation` started (its own
    failure handling only exists once the generator is running). Rolls back first
    and re-reads the row, so it is safe after an aborted transaction. When `attempt`
    (the retry count the caller started) is given, a reading that has since moved
    on to a later attempt is left alone.
    """
    db.rollback()
    reading = db.get(Reading, reading_id, populate_existing=True)
    if reading is None or reading.status != "pending":
        return False
    if attempt is not None and _retries(reading) != attempt:
        return False
    _fail_and_refund(db, reading)
    return True


def retry_reading(db: Session, user: User, reading_id: UUID) -> Reading:
    """Re-debit a failed reading and reset it to pending, keeping its cards."""
    reading = db.scalar(
        select(Reading).where(Reading.id == reading_id, Reading.user_id == user.id)
    )
    if reading is None:
        raise NotFound("Reading not found")
    if reading.spread_type == "daily":
        raise ValidationFailed("daily readings cannot be retried; request the daily card again")
    if reading.status != "failed":
        raise ValidationFailed(f"reading is {reading.status}; only failed readings can be retried")

    retry = _retries(reading) + 1
    cost = _cost(db, reading.spread_type)
    try:
        if cost > 0:
            debit_for_reading(
                db, user.id, cost, reading.id, reference_id=_debit_reference(reading.id, retry)
            )
    except InsufficientCredits:
        db.rollback()
        raise
    reading.text = ""
    reading.status = "pending"
    reading.model = None
    reading.token_usage = {**(reading.token_usage or {}), "retries": retry}
    db.commit()
    return reading
