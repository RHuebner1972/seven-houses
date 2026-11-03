import pytest
import sqlalchemy
from sqlalchemy.exc import IntegrityError

from app.models import CreditLedger, Reading, SpreadPrice, User


def test_tables_exist(db):
    names = set(sqlalchemy.inspect(db.get_bind()).get_table_names())
    assert {
        "users",
        "birth_profiles",
        "charts",
        "readings",
        "credit_ledger",
        "daily_draws",
        "spread_prices",
        "ip_events",
    } <= names


def test_spread_prices_seeded(db):
    rows = {r.spread_type: r.credits for r in db.query(SpreadPrice)}
    assert rows == {"daily": 0, "three_card": 1, "celtic_cross": 3}


def test_ledger_reference_unique(db, user):
    db.add(CreditLedger(user_id=user.id, delta=5, reason="purchase", reference_id="tx1"))
    db.commit()
    db.add(CreditLedger(user_id=user.id, delta=5, reason="purchase", reference_id="tx1"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_reading_defaults_and_status_check(db, user):
    r = Reading(user_id=user.id, spread_type="three_card", cards=[{"id": 1}], status="pending")
    db.add(r)
    db.commit()
    db.refresh(r)
    assert r.text == ""
    assert r.cards == [{"id": 1}]

    db.add(Reading(user_id=user.id, spread_type="daily", cards=[], status="bogus"))
    with pytest.raises(IntegrityError):
        db.commit()


def test_deleting_user_cascades(db, user):
    db.add(CreditLedger(user_id=user.id, delta=1, reason="grant"))
    db.add(Reading(user_id=user.id, spread_type="daily", cards=[], status="complete"))
    db.commit()
    db.query(User).filter_by(id=user.id).delete()
    db.commit()
    assert db.query(CreditLedger).count() == 0
    assert db.query(Reading).count() == 0


def test_db_state_is_truncated_between_tests(db):
    assert db.query(User).count() == 0
