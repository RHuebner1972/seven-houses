import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


def _user_fk(**kw) -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), **kw
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _pk()
    email: Mapped[str | None] = mapped_column(String, unique=True)
    auth_provider: Mapped[str | None] = mapped_column(String)
    auth_subject: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = _created_at()


class BirthProfile(Base):
    __tablename__ = "birth_profiles"

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = _user_fk(index=True)
    name: Mapped[str] = mapped_column(String)
    birth_datetime_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    birth_tz: Mapped[str] = mapped_column(String)
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    place_label: Mapped[str] = mapped_column(String)
    time_known: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _created_at()


class Chart(Base):
    __tablename__ = "charts"

    id: Mapped[uuid.UUID] = _pk()
    birth_profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("birth_profiles.id", ondelete="CASCADE"),
        unique=True,
    )
    data: Mapped[dict] = mapped_column(JSONB)
    engine_version: Mapped[str] = mapped_column(String)
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Reading(Base):
    __tablename__ = "readings"
    __table_args__ = (
        CheckConstraint(
            "status in ('pending','complete','failed')", name="ck_readings_status"
        ),
    )

    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = _user_fk(index=True)
    spread_type: Mapped[str] = mapped_column(String)
    cards: Mapped[list] = mapped_column(JSONB)
    question: Mapped[str | None] = mapped_column(Text)
    chart_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("charts.id", ondelete="SET NULL")
    )
    text: Mapped[str] = mapped_column(Text, default="", server_default="")
    model: Mapped[str | None] = mapped_column(String)
    token_usage: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = _created_at()


class CreditLedger(Base):
    __tablename__ = "credit_ledger"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = _user_fk(index=True)
    delta: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String)
    reference_id: Mapped[str | None] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = _created_at()


class DailyDraw(Base):
    __tablename__ = "daily_draws"

    user_id: Mapped[uuid.UUID] = _user_fk(primary_key=True)
    local_date: Mapped[date] = mapped_column(Date, primary_key=True)
    card: Mapped[dict] = mapped_column(JSONB)
    reading_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("readings.id", ondelete="CASCADE")
    )


class SpreadPrice(Base):
    __tablename__ = "spread_prices"

    spread_type: Mapped[str] = mapped_column(String, primary_key=True)
    credits: Mapped[int] = mapped_column(Integer)


class IpEvent(Base):
    __tablename__ = "ip_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ip: Mapped[str] = mapped_column(String, index=True)
    kind: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = _created_at()


class MagicToken(Base):
    __tablename__ = "magic_tokens"

    token_hash: Mapped[str] = mapped_column(Text, primary_key=True)
    email: Mapped[str] = mapped_column(Text)
    user_id: Mapped[uuid.UUID] = _user_fk()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created_at()
