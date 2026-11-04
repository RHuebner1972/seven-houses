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


@pytest.fixture
def fake_google(monkeypatch):
    from app.auth import google

    def fake_verify(id_token, request, client_id):
        return {"sub": "g1", "email": "a@x.io", "email_verified": True}

    monkeypatch.setattr(google, "_verify_oauth2_token", fake_verify)
    return fake_verify


@pytest.fixture
def other_user_google_g1(db) -> User:
    u = User(email="a@x.io", auth_provider="google", auth_subject="g1")
    db.add(u)
    db.commit()
    return u


class FakeResend:
    def __init__(self):
        self.sent: list[dict] = []

    def extract_token(self) -> str:
        from urllib.parse import parse_qs, urlparse

        return parse_qs(urlparse(self.sent[-1]["link"]).query)["token"][0]


@pytest.fixture
def fake_resend(monkeypatch):
    from app.auth import magic

    fake = FakeResend()
    monkeypatch.setattr(
        magic, "send_magic_link_email", lambda to, link: fake.sent.append({"to": to, "link": link})
    )
    return fake


@pytest.fixture
def other_user(db) -> User:
    u = User()
    db.add(u)
    db.commit()
    return u


OPENCAGE_BODY = {
    "results": [
        {
            "formatted": "Hull, MA, USA",
            "geometry": {"lat": 42.30, "lng": -70.91},
            "annotations": {"timezone": {"name": "America/New_York"}},
        },
        {"formatted": "No tz place", "geometry": {"lat": 1.0, "lng": 2.0}, "annotations": {}},
    ]
}


class FakeOpencage:
    def __init__(self):
        self.calls: list[dict] = []
        self.error: Exception | None = None
        self.body: dict | None = None


@pytest.fixture
def fake_opencage(monkeypatch):
    import httpx

    from app.charts import geocode

    geocode.clear_cache()
    fake = FakeOpencage()

    def fake_get(self, url, params=None, **kw):
        fake.calls.append({"url": url, "params": params})
        if fake.error:
            raise fake.error
        return httpx.Response(200, json=fake.body if fake.body is not None else OPENCAGE_BODY, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.Client, "get", fake_get)
    yield fake
    geocode.clear_cache()


def pytest_addoption(parser):
    parser.addoption(
        "--update-snapshots", action="store_true", default=False, help="rewrite tests/snapshots files"
    )


@pytest.fixture
def snapshot(request):
    from pathlib import Path

    update = request.config.getoption("--update-snapshots")
    base = Path(__file__).parent / "snapshots"

    def check(name: str) -> str:
        path = base / name
        if update:
            return _Writer(path)
        return path.read_text(encoding="utf-8")

    return check


class _Writer(str):
    """Equal to anything; records the compared value to disk when update mode is on."""

    def __new__(cls, path):
        obj = super().__new__(cls, "")
        obj.path = path
        return obj

    def __eq__(self, other):
        self.path.write_text(other, encoding="utf-8")
        return True

    __hash__ = str.__hash__
