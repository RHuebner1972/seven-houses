from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth.router import router as auth_router
from app.billing.router import router as billing_router
from app.charts.router import router as charts_router
from app.config import get_settings
from app.daily.router import router as daily_router
from app.errors import register_error_handlers
from app.readings.router import router as readings_router


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="Seventh House API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(auth_router)
    app.include_router(charts_router)
    app.include_router(readings_router)
    app.include_router(daily_router)
    app.include_router(billing_router)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    return app


app = create_app()
