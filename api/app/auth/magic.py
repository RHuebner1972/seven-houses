import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

import resend
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.linking import link_and_commit
from app.config import get_settings
from app.errors import Unauthorized
from app.models import MagicToken, User

logger = logging.getLogger(__name__)

MAGIC_TTL = timedelta(minutes=15)


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def send_magic_link_email(to: str, link: str) -> None:
    resend.api_key = get_settings().resend_api_key
    resend.Emails.send(
        {
            "from": "Seventh House <no-reply@seventhhouse.app>",
            "to": [to],
            "subject": "Your Seventh House sign-in link",
            "html": f'<p><a href="{link}">Sign in to Seventh House</a></p>'
            "<p>This link expires in 15 minutes.</p>",
        }
    )


def issue_magic_link(db: Session, email: str, user_id: UUID) -> str:
    raw = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    row = MagicToken(
        token_hash=_hash(raw), email=email, user_id=user_id, expires_at=now + MAGIC_TTL
    )
    db.add(row)
    db.commit()
    try:
        send_magic_link_email(email, f"{get_settings().app_base_url}/auth/magic?token={raw}")
    except Exception:
        logger.exception("Failed to send magic link email")
        db.delete(row)
        db.commit()
    return raw


def consume_magic_token(db: Session, token: str) -> User:
    row = db.scalars(
        select(MagicToken).where(MagicToken.token_hash == _hash(token)).with_for_update()
    ).first()
    now = datetime.now(timezone.utc)
    if row is None or row.used_at is not None or row.expires_at <= now:
        db.rollback()
        raise Unauthorized("Invalid or expired link")
    current = db.get(User, row.user_id)
    if current is None:
        db.rollback()
        raise Unauthorized("Invalid or expired link")

    def mark_used() -> None:
        row.used_at = now

    return link_and_commit(db, current, "email", None, row.email, before_commit=mark_used)
