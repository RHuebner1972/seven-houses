from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = ""
    test_database_url: str = ""
    jwt_secret: str = "dev-secret-change-me"
    anthropic_api_key: str = ""
    revenuecat_webhook_secret: str = ""
    resend_api_key: str = ""
    google_client_id: str = ""
    opencage_api_key: str = ""
    cors_origins: list[str] = ["http://localhost:3000"]
    model_paid: str = "claude-sonnet-4-5"
    model_daily: str = "claude-haiku-4-5"
    app_base_url: str = "http://localhost:3000"
    ephemeris_path: str = "app/astro/de440s.bsp"


@lru_cache
def get_settings() -> Settings:
    return Settings()
