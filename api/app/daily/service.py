"""Daily card: one free card per user per local day, enforced by the daily_draws PK."""

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import Conflict, ValidationFailed
from app.models import DailyDraw, Reading, User
from app.readings.service import STALE_PENDING, fail_if_pending
from app.tarot.draw import draw

GENERATION_IN_PROGRESS = "generation_in_progress"
GENERATION_IN_PROGRESS_MESSAGE = "Today's card is still being written; try again shortly"


def local_date_in(tz: str) -> date:
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValidationFailed(f"Unknown time zone: {tz!r}") from None
    return datetime.now(UTC).astimezone(zone).date()


def find_daily(db: Session, user: User, tz: str) -> Reading | None:
    """The user's daily reading for the current local day in `tz`, if drawn."""
    return db.scalar(
        select(Reading)
        .join(DailyDraw, DailyDraw.reading_id == Reading.id)
        .where(DailyDraw.user_id == user.id, DailyDraw.local_date == local_date_in(tz))
    )


def is_in_progress(reading: Reading) -> bool:
    """Pending and recently touched: another request is generating it."""
    return reading.status == "pending" and reading.updated_at > datetime.now(UTC) - STALE_PENDING


def restart_daily(db: Session, reading: Reading) -> Reading:
    """Reset a failed (or stale pending) daily reading to pending with the same card.

    The failed -> pending transition is a conditional UPDATE, so of two concurrent
    requests only one wins; the loser gets 409 generation_in_progress.
    """
    if reading.status == "pending":
        # Stale: a dead stream left it pending. Conditional on still being stale, so a
        # stream that wrote meanwhile is not failed (the claim below then 409s).
        fail_if_pending(db, reading.id, stale_before=datetime.now(UTC) - STALE_PENDING)
    claimed = db.execute(
        update(Reading)
        .where(Reading.id == reading.id, Reading.status == "failed")
        .values(status="pending", text="", updated_at=func.now())
    ).rowcount
    db.commit()
    db.refresh(reading)
    if not claimed:
        raise Conflict(GENERATION_IN_PROGRESS, GENERATION_IN_PROGRESS_MESSAGE)
    return reading


def get_or_create_daily(db: Session, user: User, tz: str) -> tuple[Reading, bool]:
    """Return (reading, already_drawn) for the user's current local day in `tz`."""
    local_date = local_date_in(tz)

    card = draw("daily")[0].model_dump()
    try:
        with db.begin_nested():
            reading = Reading(
                user_id=user.id, spread_type="daily", status="pending", cards=[card]
            )
            db.add(reading)
            db.flush()
            db.add(
                DailyDraw(
                    user_id=user.id, local_date=local_date, card=card, reading_id=reading.id
                )
            )
            db.flush()
    except IntegrityError:
        existing = db.scalar(
            select(Reading)
            .join(DailyDraw, DailyDraw.reading_id == Reading.id)
            .where(DailyDraw.user_id == user.id, DailyDraw.local_date == local_date)
        )
        return existing, True
    db.commit()
    return reading, False
