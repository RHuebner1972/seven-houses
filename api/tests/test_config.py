import json

import pytest

from app.config import DEV_JWT_SECRET, Settings


def test_prod_rejects_dev_jwt_secret():
    with pytest.raises(ValueError):
        Settings(env="prod", jwt_secret=DEV_JWT_SECRET)


def test_prod_rejects_empty_jwt_secret():
    with pytest.raises(ValueError):
        Settings(env="prod", jwt_secret="")


def test_prod_accepts_real_secret():
    assert Settings(env="prod", jwt_secret="x" * 32).env == "prod"


def test_cors_origins_comma_separated():
    s = Settings(cors_origins="https://a.com, https://b.com")
    assert s.cors_origins == ["https://a.com", "https://b.com"]


def test_cors_origins_json_and_list():
    assert Settings(cors_origins=json.dumps(["https://a.com"])).cors_origins == ["https://a.com"]
    assert Settings(cors_origins=[" https://a.com "]).cors_origins == ["https://a.com"]


def test_cors_origins_from_env(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://a.com,https://b.com")
    assert Settings().cors_origins == ["https://a.com", "https://b.com"]


def test_prod_rejects_short_jwt_secret():
    with pytest.raises(ValueError, match="32"):
        Settings(env="prod", jwt_secret="x" * 31)


def test_short_jwt_secret_allowed_outside_prod():
    assert Settings(env="dev", jwt_secret="short").jwt_secret == "short"


@pytest.mark.parametrize("amount", [0, -5])
def test_credit_products_must_be_positive(amount):
    with pytest.raises(ValueError, match="sh_bad"):
        Settings(credit_products={"sh_ok": 5, "sh_bad": amount})
