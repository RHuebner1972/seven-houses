import pytest
from fastapi.testclient import TestClient

from app.errors import NotFound
from app.main import create_app


@pytest.fixture
def client():
    app = create_app()

    @app.get("/_test/raise-not-found")
    def _raise_not_found():
        raise NotFound("nope")

    with TestClient(app) as c:
        yield c
