"""initial schema

Revision ID: 0001
Revises:
"""
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql as pg

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

NOW = sa.text("now()")


def _uuid_pk():
    return sa.Column("id", pg.UUID(as_uuid=True), primary_key=True)


def _user_fk(**kw):
    return sa.Column(
        "user_id",
        pg.UUID(as_uuid=True),
        sa.ForeignKey("users.id", ondelete="CASCADE"),
        **kw,
    )


def upgrade() -> None:
    op.create_table(
        "users",
        _uuid_pk(),
        sa.Column("email", sa.String(), unique=True),
        sa.Column("auth_provider", sa.String()),
        sa.Column("auth_subject", sa.String()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_table(
        "birth_profiles",
        _uuid_pk(),
        _user_fk(nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("birth_datetime_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("birth_tz", sa.String(), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("place_label", sa.String(), nullable=False),
        sa.Column("time_known", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_index("ix_birth_profiles_user_id", "birth_profiles", ["user_id"])
    op.create_table(
        "charts",
        _uuid_pk(),
        sa.Column(
            "birth_profile_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("birth_profiles.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("data", pg.JSONB(), nullable=False),
        sa.Column("engine_version", sa.String(), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_table(
        "readings",
        _uuid_pk(),
        _user_fk(nullable=False),
        sa.Column("spread_type", sa.String(), nullable=False),
        sa.Column("cards", pg.JSONB(), nullable=False),
        sa.Column("question", sa.Text()),
        sa.Column(
            "chart_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("charts.id", ondelete="SET NULL"),
        ),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("model", sa.String()),
        sa.Column("token_usage", pg.JSONB()),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
        sa.CheckConstraint(
            "status in ('pending','complete','failed')", name="ck_readings_status"
        ),
    )
    op.create_index("ix_readings_user_id", "readings", ["user_id"])
    op.create_table(
        "credit_ledger",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        _user_fk(nullable=False),
        sa.Column("delta", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(), nullable=False),
        sa.Column("reference_id", sa.String(), unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_index("ix_credit_ledger_user_id", "credit_ledger", ["user_id"])
    op.create_table(
        "daily_draws",
        _user_fk(primary_key=True),
        sa.Column("local_date", sa.Date(), primary_key=True),
        sa.Column("card", pg.JSONB(), nullable=False),
        sa.Column(
            "reading_id",
            pg.UUID(as_uuid=True),
            sa.ForeignKey("readings.id", ondelete="CASCADE"),
        ),
    )
    spread_prices = op.create_table(
        "spread_prices",
        sa.Column("spread_type", sa.String(), primary_key=True),
        sa.Column("credits", sa.Integer(), nullable=False),
    )
    op.bulk_insert(
        spread_prices,
        [
            {"spread_type": "daily", "credits": 0},
            {"spread_type": "three_card", "credits": 1},
            {"spread_type": "celtic_cross", "credits": 3},
        ],
    )
    op.create_table(
        "ip_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("ip", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=NOW),
    )
    op.create_index("ix_ip_events_ip", "ip_events", ["ip"])


def downgrade() -> None:
    for table in (
        "ip_events",
        "spread_prices",
        "daily_draws",
        "credit_ledger",
        "readings",
        "charts",
        "birth_profiles",
        "users",
    ):
        op.drop_table(table)
