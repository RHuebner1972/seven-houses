from collections.abc import Callable

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import ValidationFailed
from app.ledger.service import balance
from app.models import (
    AdminMessage,
    BirthProfile,
    CouponRedemption,
    CreditLedger,
    DailyDraw,
    GenerationEvent,
    Reading,
    User,
)


def _find_owner(
    db: Session, current: User, provider: str, subject: str | None, email: str
) -> User | None:
    """Return another user who already owns this identity (by subject, else email)."""
    if subject is not None:
        found = db.scalars(
            select(User).where(
                User.auth_provider == provider,
                User.auth_subject == subject,
                User.id != current.id,
            )
        ).first()
        if found is not None:
            return found
    return db.scalars(select(User).where(User.email == email, User.id != current.id)).first()


def merge_anonymous_into(db: Session, current: User, owner: User) -> None:
    """Move an anonymous user's data to `owner`, then delete it. Does not commit.

    Profiles (and so their charts), readings and generation events are re-pointed.
    Reading debits and refunds travel with their readings, so a later refund still
    finds its debit row (refunds are looked up by debit reference); the remaining
    positive balance moves as a transfer_out / transfer_in pair. Daily draws move
    unless the owner already drew that local date (then the anonymous draw row is
    dropped; its reading still moves). Runs in the caller's transaction, so a
    failure rolls back with the link and leaves both users untouched.
    """
    # Lock the anonymous user's row first: debit_for_reading locks the same row, so a
    # concurrent debit waits for the merge (and then finds the user gone) instead of
    # landing between the balance read and the delete.
    db.execute(select(User.id).where(User.id == current.id).with_for_update())
    for model in (BirthProfile, Reading, GenerationEvent, AdminMessage):
        db.execute(update(model).where(model.user_id == current.id).values(user_id=owner.id))
    owner_coupons = select(CouponRedemption.coupon_id).where(CouponRedemption.user_id == owner.id)
    db.execute(
        delete(CouponRedemption).where(
            CouponRedemption.user_id == current.id, CouponRedemption.coupon_id.in_(owner_coupons)
        )
    )
    db.execute(
        update(CouponRedemption)
        .where(CouponRedemption.user_id == current.id)
        .values(user_id=owner.id)
    )
    db.execute(
        update(CreditLedger)
        .where(CreditLedger.user_id == current.id, CreditLedger.reason.in_(("reading", "refund")))
        .values(user_id=owner.id)
    )
    remaining = balance(db, current.id)
    if remaining > 0:
        db.add_all(
            [
                CreditLedger(
                    user_id=current.id,
                    delta=-remaining,
                    reason="transfer_out",
                    reference_id=f"transfer:{current.id}",
                ),
                CreditLedger(
                    user_id=owner.id,
                    delta=remaining,
                    reason="transfer_in",
                    reference_id=f"transfer:{current.id}:in",
                ),
            ]
        )
    owner_dates = select(DailyDraw.local_date).where(DailyDraw.user_id == owner.id)
    db.execute(
        delete(DailyDraw).where(DailyDraw.user_id == current.id, DailyDraw.local_date.in_(owner_dates))
    )
    db.execute(update(DailyDraw).where(DailyDraw.user_id == current.id).values(user_id=owner.id))
    db.delete(current)
    db.flush()


def link_identity(
    db: Session, current: User, provider: str, subject: str | None, email: str
) -> User:
    """Attach an identity to `current`, or return the existing owner of that identity.

    If the identity already belongs to another user and `current` is anonymous,
    `current`'s data is merged into the owner and `current` is deleted (see
    `merge_anonymous_into`); the owner is returned. A linked `current` is left as
    it is. An already-linked `current` is never silently rewritten to a different
    identity.
    """
    owner = _find_owner(db, current, provider, subject, email)
    if owner is not None:
        if current.email is None:
            merge_anonymous_into(db, current, owner)
        return owner
    if current.email is None:
        current.email = email
        current.auth_provider = provider
        current.auth_subject = subject
    elif subject is not None and (current.auth_provider, current.auth_subject) == (
        provider,
        subject,
    ):
        current.email = email  # same account, provider reports a changed email
    elif current.email != email:
        raise ValidationFailed("Account already linked to another identity")
    return current


def link_and_commit(
    db: Session,
    current: User,
    provider: str,
    subject: str | None,
    email: str,
    before_commit: Callable[[], None] | None = None,
) -> User:
    """link_identity + commit, all in one transaction; a lost race on users.email
    resolves to the winner (merging an anonymous `current` into it).

    `before_commit` runs in the same transaction, before the link (so its writes are
    flushed before a merge can delete `current` and cascade its rows). Any failure
    rolls the whole transaction back.
    """
    current_id = current.id
    try:
        if before_commit:
            before_commit()
            db.flush()
        user = link_identity(db, current, provider, subject, email)
        db.commit()
        return user
    except IntegrityError:
        db.rollback()
        owner = db.scalars(select(User).where(User.email == email, User.id != current_id)).first()
        if owner is None:
            raise
        try:
            if before_commit:
                before_commit()
                db.flush()
            current = db.get(User, current_id)
            if current is not None and current.email is None:
                merge_anonymous_into(db, current, owner)
            db.commit()
        except Exception:
            db.rollback()
            raise
        return owner
    except Exception:
        db.rollback()
        raise
