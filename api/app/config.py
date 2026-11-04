import json
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

DEV_JWT_SECRET = "dev-secret-change-me-not-for-production-use-0123456789abcdef"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: str = ""
    test_database_url: str = ""
    jwt_secret: str = DEV_JWT_SECRET
    anthropic_api_key: str = ""
    revenuecat_webhook_secret: str = ""
    resend_api_key: str = ""
    google_client_id: str = ""
    opencage_api_key: str = ""
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:3000"]
    model_paid: str = "claude-sonnet-4-5"
    model_daily: str = "claude-haiku-4-5"
    app_base_url: str = "http://localhost:3000"
    ephemeris_path: str = "app/astro/de440s.bsp"
    credit_products: dict[str, int] = {"sh_credits_5": 5, "sh_credits_15": 15, "sh_credits_40": 40}

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _parse_cors_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if v.startswith("["):
                v = json.loads(v)
            else:
                v = v.split(",")
        return [o.strip() for o in v if o.strip()]

    @model_validator(mode="after")
    def _require_real_secret_in_prod(self):
        if self.env == "prod" and self.jwt_secret in ("", DEV_JWT_SECRET):
            raise ValueError("JWT_SECRET must be set to a non-default value when ENV=prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
