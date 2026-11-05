from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.admin import service
from app.admin.access import current_admin
from app.auth.deps import current_user
from app.db import get_db
from app.models import User

router = APIRouter()


class GrantBody(BaseModel):
    amount: int = Field(gt=0, le=10_000)
    note: str = Field(default="", max_length=200)
    reference_id: str | None = Field(default=None, max_length=120)


class MessageBody(BaseModel):
    subject: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=4000)


class CouponBody(BaseModel):
    code: str | None = Field(default=None, max_length=40)
    credits: int = Field(gt=0, le=10_000)
    max_redemptions: int | None = Field(default=None, gt=0)
    expires_at: datetime | None = None
    note: str = Field(default="", max_length=200)


class RedeemBody(BaseModel):
    code: str = Field(min_length=1, max_length=40)


@router.get("/admin/users")
def admin_list_users(
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
    q: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    return {"users": service.list_users(db, q, limit, offset)}


@router.get("/admin/users/{user_id}")
def admin_get_user(
    user_id: UUID,
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.get_user(db, user_id)


@router.post("/admin/users/{user_id}/credits")
def admin_grant_credits(
    user_id: UUID,
    body: GrantBody,
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.grant_credits(db, user_id, body.amount, body.note, body.reference_id)


@router.post("/admin/users/{user_id}/messages", status_code=201)
def admin_send_message(
    user_id: UUID,
    body: MessageBody,
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.send_message(db, user_id, body.subject, body.body)


@router.get("/admin/coupons")
def admin_list_coupons(
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    return {"coupons": service.list_coupons(db)}


@router.post("/admin/coupons", status_code=201)
def admin_create_coupon(
    body: CouponBody,
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.create_coupon(
        db,
        code=body.code,
        credits=body.credits,
        max_redemptions=body.max_redemptions,
        expires_at=body.expires_at,
        note=body.note,
        created_by=admin.id,
    )


@router.post("/admin/coupons/{coupon_id}/disable")
def admin_disable_coupon(
    coupon_id: UUID,
    admin: Annotated[User, Depends(current_admin)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.disable_coupon(db, coupon_id)


@router.post("/coupons/redeem")
def redeem_coupon(
    body: RedeemBody,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.redeem_coupon(db, user.id, body.code)


@router.get("/messages")
def list_messages(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    return {"messages": service.list_messages(db, user.id)}


@router.post("/messages/{message_id}/read")
def read_message(
    message_id: UUID,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    return service.mark_read(db, user.id, message_id)
