import os

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.auth.jwt import mint_token
from app.db import get_db
from app.errors import NotFound
from app.main import create_app
from app.models import User

DEFAULT_TEST_DATABASE_URL = "postgresql+psycopg://sh:sh@localhost:5432/seventh_house_test"
KEEP_TABLES = {"spread_prices", "alembic_version"}


def auth_headers(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {mint_token(user.id, user.email is None)}"}


@pytest.fixture(scope="session")
def db_url():
    return os.environ.get("TEST_DATABASE_URL") or DEFAULT_TEST_DATABASE_URL


@pytest.fixture(scope="session")
def engine(db_url):
    previous = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = db_url
    try:
        command.upgrade(Config("alembic.ini"), "head")
    finally:
        if previous is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous
    eng = create_engine(db_url)
    yield eng
    eng.dispose()


@pytest.fixture
def db(engine):
    with sessionmaker(engine, expire_on_commit=False)() as session:
        yield session
        session.rollback()
    with engine.begin() as conn:
        tables = [
            t
            for t in conn.execute(
                text("select tablename from pg_tables where schemaname = 'public'")
            ).scalars()
            if t not in KEEP_TABLES
        ]
        if tables:
            conn.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in tables) + " CASCADE"))


@pytest.fixture
def user(db) -> User:
    u = User()
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def client(db):
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db

    @app.get("/_test/raise-not-found")
    def _raise_not_found():
        raise NotFound("nope")

    with TestClient(app) as c:
        yield c
