"""DB-backed rate limits (serverless-safe: no in-process state).

Per-user limits count recent `generation_events` rows (one per started Claude
generation or geocode call, recorded by `record_generation`); per-IP limits record
`ip_events`.
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import RateLimited
from app.models import GenerationEvent, IpEvent

HOUR = timedelta(hours=1)
READING_LIMIT = 20
DAILY_LIMIT = 10
GEOCODE_LIMIT = 60
ANON_MINT_LIMIT = 10
MAGIC_REQUEST_LIMIT = 5

_MESSAGE = "Too many requests; try again later"


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "") or "unknown"


def check_user_rate(
    db: Session, user_id: uuid.UUID, kind: str, limit: int, window: timedelta
) -> None:
    """Raise RateLimited once the user already has `limit` generation events of `kind`
    in the window.

    kind="reading": paid spread generations (new and retry); kind="daily": daily-card
    generations (including regenerations); kind="geocode": place lookups.
    """
    since = datetime.now(UTC) - window
    count = db.scalar(
        select(func.count())
        .select_from(GenerationEvent)
        .where(
            GenerationEvent.user_id == user_id,
            GenerationEvent.kind == kind,
            GenerationEvent.created_at > since,
        )
    )
    if count >= limit:
        raise RateLimited(_MESSAGE)


def record_generation(db: Session, user_id: uuid.UUID, kind: str) -> None:
    """Record one generation event of `kind` for the user and commit."""
    db.add(GenerationEvent(user_id=user_id, kind=kind))
    db.commit()


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
