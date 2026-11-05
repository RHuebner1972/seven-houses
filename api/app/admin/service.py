from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import Conflict, NotFound, ValidationFailed
from app.ledger.service import balance, credit
from app.models import AdminMessage, Coupon, CouponRedemption, CreditLedger, User

_CODE_CHARS = re.compile(r"[^A-Z0-9_-]")


def normalize_code(raw: str) -> str:
    code = _CODE_CHARS.sub("", raw.strip().upper())
    if len(code) < 4:
        raise ValidationFailed("Coupon code must be at least 4 characters")
    return code


def generate_code() -> str:
    return secrets.token_hex(4).upper()


def unread_count(db: Session, user_id: UUID) -> int:
    total = db.scalar(
        select(func.count())
        .select_from(AdminMessage)
        .where(AdminMessage.user_id == user_id, AdminMessage.read_at.is_(None))
    )
    return int(total or 0)


def _user_or_404(db: Session, user_id: UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise NotFound("User not found")
    return user


def list_users(db: Session, q: str | None, limit: int, offset: int) -> list[dict]:
    bal = (
        select(
            CreditLedger.user_id,
            func.coalesce(func.sum(CreditLedger.delta), 0).label("balance"),
        )
        .group_by(CreditLedger.user_id)
        .subquery()
    )
    stmt = (
        select(User, func.coalesce(bal.c.balance, 0))
        .outerjoin(bal, bal.c.user_id == User.id)
        .order_by(User.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if q:
        needle = q.strip()
        try:
            stmt = stmt.where(User.id == UUID(needle))
        except ValueError:
            stmt = stmt.where(User.email.ilike(f"%{needle}%"))
    rows = db.execute(stmt).all()
    return [_user_row(user, int(bal_amt)) for user, bal_amt in rows]


def get_user(db: Session, user_id: UUID) -> dict:
    user = _user_or_404(db, user_id)
    ledger = db.scalars(
        select(CreditLedger)
        .where(CreditLedger.user_id == user_id)
        .order_by(CreditLedger.id.desc())
        .limit(20)
    ).all()
    return {
        **_user_row(user, balance(db, user_id)),
        "unread_messages": unread_count(db, user_id),
        "ledger": [
            {
                "id": row.id,
                "delta": row.delta,
                "reason": row.reason,
                "reference_id": row.reference_id,
                "created_at": row.created_at.isoformat(),
            }
            for row in ledger
        ],
    }


def grant_credits(
    db: Session, user_id: UUID, amount: int, note: str, reference_id: str | None
) -> dict:
    _user_or_404(db, user_id)
    ref = reference_id or f"admin:{user_id}:{uuid4()}"
    inserted = credit(db, user_id, amount, "admin_grant", ref)
    if not inserted:
        raise Conflict("already_granted", "That grant was already applied")
    db.commit()
    return {"balance": balance(db, user_id), "reference_id": ref, "note": note}


def send_message(db: Session, user_id: UUID, subject: str, body: str) -> dict:
    _user_or_404(db, user_id)
    row = AdminMessage(user_id=user_id, subject=subject.strip(), body=body.strip())
    db.add(row)
    db.commit()
    db.refresh(row)
    return _message_row(row)


def list_messages(db: Session, user_id: UUID) -> list[dict]:
    rows = db.scalars(
        select(AdminMessage)
        .where(AdminMessage.user_id == user_id)
        .order_by(AdminMessage.created_at.desc())
    ).all()
    return [_message_row(row) for row in rows]


def mark_read(db: Session, user_id: UUID, message_id: UUID) -> dict:
    row = db.get(AdminMessage, message_id)
    if row is None or row.user_id != user_id:
        raise NotFound("Message not found")
    if row.read_at is None:
        row.read_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(row)
    return _message_row(row)


def create_coupon(
    db: Session,
    *,
    code: str | None,
    credits: int,
    max_redemptions: int | None,
    expires_at: datetime | None,
    note: str,
    created_by: UUID | None,
) -> dict:
    normalized = normalize_code(code) if code else generate_code()
    row = Coupon(
        code=normalized,
        credits=credits,
        max_redemptions=max_redemptions,
        expires_at=expires_at,
        note=note.strip(),
        created_by=created_by,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        if getattr(getattr(e.orig, "diag", None), "constraint_name", None) == "coupons_code_key":
            raise Conflict("coupon_exists", "A coupon with that code already exists") from e
        raise
    db.refresh(row)
    return _coupon_row(db, row)


def list_coupons(db: Session) -> list[dict]:
    rows = db.scalars(select(Coupon).order_by(Coupon.created_at.desc())).all()
    return [_coupon_row(db, row) for row in rows]


def disable_coupon(db: Session, coupon_id: UUID) -> dict:
    row = db.get(Coupon, coupon_id)
    if row is None:
        raise NotFound("Coupon not found")
    row.active = False
    db.commit()
    db.refresh(row)
    return _coupon_row(db, row)


def redeem_coupon(db: Session, user_id: UUID, raw_code: str) -> dict:
    _user_or_404(db, user_id)
    code = normalize_code(raw_code)
    coupon = db.scalars(select(Coupon).where(Coupon.code == code).with_for_update()).first()
    now = datetime.now(timezone.utc)
    if (
        coupon is None
        or not coupon.active
        or (coupon.expires_at is not None and coupon.expires_at <= now)
    ):
        db.rollback()
        raise ValidationFailed("Invalid or expired coupon")
    used = db.scalar(
        select(func.count())
        .select_from(CouponRedemption)
        .where(CouponRedemption.coupon_id == coupon.id)
    ) or 0
    if coupon.max_redemptions is not None and int(used) >= coupon.max_redemptions:
        db.rollback()
        raise Conflict("coupon_exhausted", "This coupon has been fully used")
    already = db.get(CouponRedemption, (coupon.id, user_id))
    if already is not None:
        db.rollback()
        raise Conflict("coupon_already_redeemed", "You already used this coupon")
    db.add(CouponRedemption(coupon_id=coupon.id, user_id=user_id))
    credit(db, user_id, coupon.credits, "coupon", f"coupon:{coupon.id}:{user_id}")
    db.commit()
    return {"credits": coupon.credits, "balance": balance(db, user_id), "code": coupon.code}


def _user_row(user: User, bal: int) -> dict:
    return {
        "id": str(user.id),
        "email": user.email,
        "anon": user.email is None,
        "auth_provider": user.auth_provider,
        "balance": bal,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }


def _message_row(row: AdminMessage) -> dict:
    return {
        "id": str(row.id),
        "subject": row.subject,
        "body": row.body,
        "created_at": row.created_at.isoformat(),
        "read_at": row.read_at.isoformat() if row.read_at else None,
    }


def _coupon_row(db: Session, row: Coupon) -> dict:
    used = db.scalar(
        select(func.count())
        .select_from(CouponRedemption)
        .where(CouponRedemption.coupon_id == row.id)
    ) or 0
    return {
        "id": str(row.id),
        "code": row.code,
        "credits": row.credits,
        "max_redemptions": row.max_redemptions,
        "redemptions": int(used),
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "active": row.active,
        "note": row.note,
        "created_at": row.created_at.isoformat(),
    }
