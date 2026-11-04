from typing import Annotated

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.auth.jwt import verify_token
from app.db import get_db
from app.errors import Unauthorized
from app.models import User


def current_user(
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise Unauthorized("Missing or malformed Authorization header")
    claims = verify_token(token.strip())
    user = db.get(User, claims.user_id)
    if user is None:
        raise Unauthorized("User no longer exists")
    return user


def optional_current_user(
    db: Annotated[Session, Depends(get_db)],
    authorization: Annotated[str | None, Header()] = None,
) -> User | None:
    """None when no Authorization header is sent; otherwise exactly `current_user`
    (a malformed, invalid or stale bearer is still 401)."""
    if authorization is None:
        return None
    return current_user(db, authorization)
