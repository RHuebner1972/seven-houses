from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class NotFound(AppError):
    def __init__(self, message: str):
        super().__init__(404, "not_found", message)


class Unauthorized(AppError):
    def __init__(self, message: str):
        super().__init__(401, "unauthorized", message)


class InsufficientCredits(AppError):
    def __init__(self, message: str):
        super().__init__(402, "insufficient_credits", message)


class RateLimited(AppError):
    def __init__(self, message: str):
        super().__init__(429, "rate_limited", message)


class ValidationFailed(AppError):
    def __init__(self, message: str):
        super().__init__(422, "validation_failed", message)


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, app_error_handler)
