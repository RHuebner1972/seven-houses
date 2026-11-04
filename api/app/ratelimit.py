"""DB-backed rate limits (serverless-safe: no in-process state).

Per-user limits count recent `readings` rows; per-IP limits record `ip_events`.
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import RateLimited
from app.models import IpEvent, Reading

HOUR = timedelta(hours=1)
READING_LIMIT = 20
DAILY_LIMIT = 10
ANON_MINT_LIMIT = 10
MAGIC_REQUEST_LIMIT = 5

_MESSAGE = "Too many requests; try again later"


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "") or "unknown"


def check_user_rate(
    db: Session, user_id: uuid.UUID, kind: str, limit: int, window: timedelta
) -> None:
    """Raise RateLimited once the user already has `limit` readings of `kind` in the window.

    kind="reading": paid spreads; kind="daily": daily-card readings.
    """
    if kind == "reading":
        kind_filter = Reading.spread_type != "daily"
    elif kind == "daily":
        kind_filter = Reading.spread_type == "daily"
    else:
        raise ValueError(f"unknown user rate kind: {kind}")
    since = datetime.now(UTC) - window
    count = db.scalar(
        select(func.count())
        .select_from(Reading)
        .where(Reading.user_id == user_id, kind_filter, Reading.created_at > since)
    )
    if count >= limit:
        raise RateLimited(_MESSAGE)


def check_ip_rate(db: Session, ip: str, kind: str, limit: int, window: timedelta) -> None:
    """Record this attempt, then raise RateLimited if it is over `limit` in the window."""
    db.add(IpEvent(ip=ip, kind=kind))
    db.commit()
    since = datetime.now(UTC) - window
    count = db.scalar(
        select(func.count())
        .select_from(IpEvent)
        .where(IpEvent.ip == ip, IpEvent.kind == kind, IpEvent.created_at > since)
    )
    if count > limit:
        raise RateLimited(_MESSAGE)
