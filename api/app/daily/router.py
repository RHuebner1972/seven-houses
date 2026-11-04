from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.deps import current_user
from app.daily.service import get_or_create_daily
from app.db import get_db
from app.models import User
from app.ratelimit import DAILY_LIMIT, HOUR, check_user_rate
from app.readings.router import _stream, reading_payload

router = APIRouter()

DAILY_MAX_TOKENS = 600


class DailyBody(BaseModel):
    tz: str


@router.post("/daily")
def daily(
    body: DailyBody,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    check_user_rate(db, user.id, "daily", DAILY_LIMIT, HOUR)
    reading, already_drawn = get_or_create_daily(db, user, body.tz)
    if already_drawn and reading.status == "complete":
        return {"reading": reading_payload(reading)}
    if reading.status == "failed":
        # Same card, no redraw and no debit (daily is free).
        reading.status = "pending"
        reading.text = ""
        db.commit()
    return _stream(db, reading, cost=0, max_tokens=DAILY_MAX_TOKENS)
