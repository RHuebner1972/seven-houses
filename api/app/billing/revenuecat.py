from uuid import UUID

from pydantic import BaseModel

PURCHASE_EVENT_TYPE = "NON_RENEWING_PURCHASE"


class NoUsableUser(ValueError):
    """No app_user_id / original_app_user_id / alias parses as a user UUID."""


class PurchaseEvent(BaseModel):
    transaction_id: str
    app_user_id: UUID
    product_id: str
    event_type: str
    environment: str
    store: str | None = None


def _as_uuid(value: object) -> UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


def _required_str(event: dict, key: str) -> str:
    value = event.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"missing or invalid event.{key}")
    return value


def parse_event(payload: dict) -> PurchaseEvent | None:
    """Parse a RevenueCat webhook body.

    Returns None for any event type other than NON_RENEWING_PURCHASE. Raises
    ValueError for a malformed payload and NoUsableUser (a ValueError) when no
    user id in the event is one of ours.
    """
    event = payload.get("event") if isinstance(payload, dict) else None
    if not isinstance(event, dict):
        raise ValueError("missing event")
    event_type = _required_str(event, "type")
    if event_type != PURCHASE_EVENT_TYPE:
        return None
    transaction_id = _required_str(event, "transaction_id")
    product_id = _required_str(event, "product_id")
    environment = _required_str(event, "environment")
    aliases = event.get("aliases")
    candidates = [event.get("app_user_id"), event.get("original_app_user_id")]
    candidates += aliases if isinstance(aliases, list) else []
    for candidate in candidates:
        user_id = _as_uuid(candidate)
        if user_id is not None:
            break
    else:
        raise NoUsableUser("no usable app_user_id")
    store = event.get("store")
    return PurchaseEvent(
        transaction_id=transaction_id,
        app_user_id=user_id,
        product_id=product_id,
        event_type=event_type,
        environment=environment,
        store=store if isinstance(store, str) else None,
    )
