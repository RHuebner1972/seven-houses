"""Daily card: one free card per user per local day, enforced by the daily_draws PK."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import ValidationFailed
from app.models import DailyDraw, Reading, User
from app.tarot.draw import draw


def get_or_create_daily(db: Session, user: User, tz: str) -> tuple[Reading, bool]:
    """Return (reading, already_drawn) for the user's current local day in `tz`."""
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValidationFailed(f"Unknown time zone: {tz!r}") from None
    local_date = datetime.now(UTC).astimezone(zone).date()

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
