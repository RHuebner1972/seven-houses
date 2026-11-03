from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.errors import ValidationFailed

_J2000 = datetime(2000, 1, 1, 12, 0, tzinfo=UTC)
_JD_J2000 = 2451545.0


def to_utc(local: datetime, tz: str) -> datetime:
    """Naive local wall time in IANA zone `tz` -> aware UTC.

    Ambiguous and nonexistent (DST) wall times resolve with fold=0.
    """
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ValidationFailed(f"Unknown time zone: {tz!r}") from None
    return local.replace(tzinfo=zone, fold=0).astimezone(UTC)


def julian_date(utc: datetime) -> float:
    """Julian date (UTC time scale) of an aware datetime."""
    if utc.tzinfo is None:
        raise ValueError("julian_date requires an aware datetime")
    return _JD_J2000 + (utc - _J2000).total_seconds() / 86400.0
