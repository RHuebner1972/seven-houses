from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import InsufficientCredits
from app.models import CreditLedger, User


def balance(db: Session, user_id: UUID) -> int:
    total = db.scalar(
        select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(
            CreditLedger.user_id == user_id
        )
    )
    return int(total)


def credit(db: Session, user_id: UUID, amount: int, reason: str, reference_id: str) -> bool:
    """Insert a ledger row; return False if reference_id already exists.

    Uses a SAVEPOINT so a duplicate does not abort the caller's transaction.
    Does not commit.
    """
    try:
        with db.begin_nested():
            db.add(
                CreditLedger(
                    user_id=user_id, delta=amount, reason=reason, reference_id=reference_id
                )
            )
    except IntegrityError:
        return False
    return True


def debit_for_reading(db: Session, user_id: UUID, cost: int, reading_id: UUID) -> None:
    """Debit `cost` credits atomically. Runs in the caller's transaction (no commit).

    The user row is locked FOR UPDATE before the balance is read, so concurrent
    debits for one user serialize and cannot overdraw.
    """
    locked = db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    if locked is None or balance(db, user_id) < cost:
        raise InsufficientCredits("Not enough credits")
    db.add(
        CreditLedger(
            user_id=user_id, delta=-cost, reason="reading", reference_id=str(reading_id)
        )
    )
    db.flush()


def refund_reading(db: Session, user_id: UUID, cost: int, reading_id: UUID) -> bool:
    if cost == 0:
        return False
    return credit(db, user_id, cost, "refund", f"{reading_id}:refund")
