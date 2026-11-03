from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

import jwt

from app.config import get_settings
from app.errors import Unauthorized

ALGORITHM = "HS256"
TOKEN_TTL = timedelta(days=30)


@dataclass(frozen=True)
class TokenClaims:
    user_id: UUID
    anon: bool


def mint_token(user_id: UUID, anon: bool) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "anon": anon, "iat": now, "exp": now + TOKEN_TTL}
    return jwt.encode(payload, get_settings().jwt_secret, algorithm=ALGORITHM)


def verify_token(token: str) -> TokenClaims:
    try:
        payload = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=[ALGORITHM],
            options={"require": ["sub", "exp", "iat"]},
        )
        anon = payload.get("anon")
        if not isinstance(anon, bool):
            raise ValueError("anon claim must be a boolean")
        return TokenClaims(user_id=UUID(payload["sub"]), anon=anon)
    except (jwt.PyJWTError, ValueError, TypeError, KeyError) as e:
        raise Unauthorized("Invalid or expired token") from e
