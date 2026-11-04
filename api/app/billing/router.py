import hmac
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.billing.revenuecat import NoUsableUser, parse_event
from app.config import Settings, get_settings
from app.db import get_db
from app.errors import Unauthorized
from app.ledger.service import credit
from app.models import User

logger = logging.getLogger(__name__)
router = APIRouter()


class WebhookResult(BaseModel):
    credited: bool
    reason: str


def _check_auth(authorization: str | None, settings: Settings) -> None:
    secret = settings.revenuecat_webhook_secret
    if not secret or not authorization:
        raise Unauthorized("Invalid webhook credentials")
    expected = f"Bearer {secret}"
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise Unauthorized("Invalid webhook credentials")


def _skip(reason: str, event: dict, **extra) -> WebhookResult:
    logger.warning(
        "revenuecat webhook not credited: reason=%s event_id=%s type=%s product=%s %s",
        reason,
        event.get("id"),
        event.get("type"),
        event.get("product_id"),
        " ".join(f"{k}={v}" for k, v in extra.items()),
    )
    return WebhookResult(credited=False, reason=reason)


@router.post("/billing/revenuecat", response_model=WebhookResult)
async def revenuecat_webhook(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
):
    _check_auth(authorization, settings)
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    raw_event = payload.get("event") if isinstance(payload, dict) else None
    event = raw_event if isinstance(raw_event, dict) else {}

    try:
        purchase = parse_event(payload)
    except NoUsableUser:
        return _skip("unknown_user", event)
    except ValueError as e:
        return _skip("malformed", event, detail=e)
    if purchase is None:
        return _skip("ignored_event_type", event)

    if settings.env == "prod" and purchase.environment == "SANDBOX":
        return _skip("sandbox", event)
    if db.get(User, purchase.app_user_id) is None:
        return _skip("unknown_user", event, user=purchase.app_user_id)
    amount = settings.credit_products.get(purchase.product_id)
    if amount is None:
        return _skip("unknown_product", event, user=purchase.app_user_id)

    if credit(
        db, purchase.app_user_id, amount, reason="purchase", reference_id=purchase.transaction_id
    ):
        db.commit()
        return WebhookResult(credited=True, reason="ok")
    db.rollback()
    return _skip("duplicate", event, user=purchase.app_user_id)
