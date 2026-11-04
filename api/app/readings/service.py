"""Reading lifecycle: debit -> draw -> generate -> complete, or fail -> refund.

Invariant: every debit for a reading is matched by exactly one refund unless that
generation attempt completed. Debit references are `str(reading.id)` for the first
attempt and f"{reading.id}:retry{n}" for retry n; the matching refund reference is
the debit reference plus ":refund". Both are unique in the ledger, so refunds are
idempotent.
"""

import logging
import time
from collections.abc import Iterator
from datetime import timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.astro.chart import ChartData
from app.config import get_settings
from app.errors import InsufficientCredits, NotFound, ValidationFailed
from app.ledger.service import debit_for_reading, refund_reading
from app.models import BirthProfile, Chart, Reading, SpreadPrice, User
from app.readings.generator import GenerationError, stream_reading
from app.readings.prompts import QUESTION_MAX_CHARS, build_messages
from app.tarot.draw import DrawnCard, draw
from app.tarot.spreads import SPREADS

logger = logging.getLogger(__name__)

PERSIST_EVERY_CHUNKS = 20
# Wall-clock budget for one generation, including a drain after disconnect; kept
# under Vercel's 300 s maxDuration so a stream can never pin the function past it.
GENERATION_DEADLINE_SECONDS = 240.0
_clock = time.monotonic
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
    """Stream the reading text; on completion mark it complete (the debit is kept).

    Failure policy:
    - A generation error or any unexpected exception: mark failed and refund.
    - The caller closing the generator (client disconnect), "drain-and-complete":
      if no chunk had been handed out yet, fail and refund; otherwise finish the
      generation without yielding, persist it as complete and keep the debit, so
      the user finds the full reading in their history. The drain honours the
      generation deadline; if it fails or runs out of time, fail and refund with
      the partial text.
    """
    if reading.status != "pending":
        raise ValidationFailed(f"reading is {reading.status}, not pending")
    settings = get_settings()
    if model is None:
        model = settings.model_daily if reading.spread_type == "daily" else settings.model_paid
    deadline = _clock() + GENERATION_DEADLINE_SECONDS
    buffer = ""
    delivered = 0
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
        while True:
            try:
                chunk = next(stream)
            except StopIteration as stop:
                usage = stop.value
                break
            buffer += chunk
            delivered += 1
            yield chunk
            if delivered % PERSIST_EVERY_CHUNKS == 0:
                reading.text = buffer
                db.commit()

        _complete(db, reading, buffer, model, usage)
    except GeneratorExit:
        # Client disconnected; a generator must not yield after GeneratorExit.
        if delivered == 0:
            _close(stream)
            _fail_and_refund(db, reading, buffer)
            return
        try:
            while True:
                if _clock() > deadline:
                    raise GenerationError("generation deadline exceeded")
                try:
                    buffer += next(stream)
                except StopIteration as stop:
                    usage = stop.value
                    break
            _complete(db, reading, buffer, model, usage)
        except Exception:
            logger.warning("reading %s: drain after disconnect failed; refunding", reading.id)
            _close(stream)
            _fail_and_refund(db, reading, buffer)
        return
    except Exception:
        # GenerationError and anything unexpected: never keep credits for an
        # undelivered reading.
        _close(stream)
        _fail_and_refund(db, reading, buffer)
        raise


def _complete(db: Session, reading: Reading, text: str, model: str, usage) -> None:
    """Persist the finished reading, but only if it is still pending: a reading that
    was failed and refunded meanwhile (e.g. by a stale sweep) must not turn complete."""
    token_usage = {"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens}
    if _retries(reading):
        token_usage["retries"] = _retries(reading)
    done = db.execute(
        update(Reading)
        .where(Reading.id == reading.id, Reading.status == "pending")
        .values(status="complete", text=text, model=model, token_usage=token_usage)
    ).rowcount
    db.commit()
    db.refresh(reading)
    if not done:
        logger.warning("reading %s: finished but no longer pending; left %s", reading.id, reading.status)


def _close(stream) -> None:
    if stream is not None:
        stream.close()


def _fail_and_refund(db: Session, reading: Reading, partial_text: str = "") -> None:
    db.rollback()  # the session may be mid-transaction
    if reading.status == "complete":
        return  # never refund a delivered reading
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
