import threading
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import InsufficientCredits
from app.ledger.service import balance, credit, debit_for_reading, refund_reading
from app.models import CreditLedger


def test_balance_zero_for_new_user(db, user):
    assert balance(db, user.id) == 0


def test_credit_then_balance(db, user):
    assert credit(db, user.id, 5, "purchase", "tx1") is True
    db.commit()
    assert balance(db, user.id) == 5


def test_credit_idempotent(db, user):
    credit(db, user.id, 5, "purchase", "tx1")
    db.commit()
    assert credit(db, user.id, 5, "purchase", "tx1") is False
    assert balance(db, user.id) == 5


def test_credit_duplicate_keeps_outer_transaction_alive(db, user):
    credit(db, user.id, 5, "purchase", "tx1")
    assert credit(db, user.id, 5, "purchase", "tx1") is False
    assert credit(db, user.id, 2, "purchase", "tx2") is True
    db.commit()
    assert balance(db, user.id) == 7


def test_credit_unknown_user_raises_not_false(db):
    with pytest.raises(IntegrityError):
        credit(db, uuid4(), 5, "purchase", "txX")


@pytest.mark.parametrize("amount", [0, -1])
def test_credit_rejects_non_positive_amount(db, user, amount):
    with pytest.raises(ValueError):
        credit(db, user.id, amount, "purchase", "txV")


@pytest.mark.parametrize("cost", [0, -1])
def test_debit_rejects_non_positive_cost(db, user, cost):
    with pytest.raises(ValueError):
        debit_for_reading(db, user.id, cost, uuid4())


def test_refund_rejects_negative_cost(db, user):
    with pytest.raises(ValueError):
        refund_reading(db, user.id, -1, uuid4())


def test_debit_insufficient_raises(db, user):
    with pytest.raises(InsufficientCredits):
        debit_for_reading(db, user.id, 1, uuid4())


def test_debit_unknown_user_raises(db):
    with pytest.raises(InsufficientCredits):
        debit_for_reading(db, uuid4(), 1, uuid4())


def test_debit_records_row_without_committing(db, user):
    credit(db, user.id, 3, "purchase", "tx1")
    db.commit()
    rid = uuid4()
    debit_for_reading(db, user.id, 2, rid)
    assert balance(db, user.id) == 1
    row = db.scalars(select(CreditLedger).where(CreditLedger.reason == "reading")).one()
    assert (row.delta, row.reason, row.reference_id) == (-2, "reading", str(rid))
    db.rollback()
    assert balance(db, user.id) == 3


def test_refund_idempotent(db, user):
    credit(db, user.id, 1, "purchase", "tx1")
    rid = uuid4()
    debit_for_reading(db, user.id, 1, rid)
    db.commit()
    assert refund_reading(db, user.id, 1, rid) is True
    db.commit()
    assert refund_reading(db, user.id, 1, rid) is False
    assert balance(db, user.id) == 1


def test_refund_zero_cost_inserts_nothing(db, user):
    assert refund_reading(db, user.id, 0, uuid4()) is False
    db.commit()
    assert db.scalar(select(func.count()).select_from(CreditLedger)) == 0


def test_concurrent_debit_only_one_wins(db, db_url, user):
    credit(db, user.id, 1, "purchase", "tx1")
    db.commit()

    engine = create_engine(db_url)
    barrier = threading.Barrier(2)
    results: list[str] = []
    lock = threading.Lock()

    def worker():
        with Session(engine) as s:
            barrier.wait(timeout=10)
            try:
                debit_for_reading(s, user.id, 1, uuid4())
                s.commit()
                outcome = "ok"
            except InsufficientCredits:
                s.rollback()
                outcome = "insufficient"
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
    finally:
        engine.dispose()

    assert sorted(results) == ["insufficient", "ok"]
    db.rollback()
    assert balance(db, user.id) == 0
    n = db.scalar(
        select(func.count()).select_from(CreditLedger).where(CreditLedger.reason == "reading")
    )
    assert n == 1
