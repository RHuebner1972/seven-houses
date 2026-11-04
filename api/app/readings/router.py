"""Reading HTTP endpoints. POST /readings and POST /readings/{id}/retry stream SSE.

Lifecycle: all checks that can fail with a plain HTTP error (auth, validation,
ownership, 402) run in the route before the StreamingResponse is returned. The
stream then drives `run_generation` with the request's session; whatever ends the
stream (completion, generation error, client disconnect, cancellation) closes the
inner generator, so the service either completes the reading or fails and refunds
it (on a disconnect after text was sent it drains and completes; see
`run_generation`). A reading never stays `pending` with a held debit.
"""

import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Annotated

import anyio
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.responses import StreamingResponse
from starlette.types import Receive, Scope, Send

from app.auth.deps import current_user
from app.db import get_db
from app.errors import NotFound
from app.models import Reading, SpreadPrice, User
from app.ratelimit import HOUR, READING_LIMIT, check_user_rate, record_generation
from app.readings.generator import GenerationError
from app.readings.service import (
    current_attempt,
    fail_if_pending,
    retry_reading,
    run_generation,
    start_reading,
)
from app.tarot.spreads import SPREADS

logger = logging.getLogger(__name__)

router = APIRouter()

EXCERPT_CHARS = 160
SPREAD_NAMES = {"daily": "Daily Card", "three_card": "Three Card", "celtic_cross": "Celtic Cross"}
GENERATION_FAILED_MESSAGE = (
    "The reading could not be generated. Your credits have been refunded; you can retry."
)
SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}

_SENTINEL = object()


class ReadingBody(BaseModel):
    spread_type: str
    question: str | None = None
    profile_id: uuid.UUID | None = None


def _sse(name: str, payload: dict) -> str:
    return f"event: {name}\ndata: {json.dumps(payload)}\n\n"


_ERROR_EVENT = _sse("error", {"code": "generation_failed", "message": GENERATION_FAILED_MESSAGE})


class _SSEResponse(StreamingResponse):
    """StreamingResponse that guarantees the reading never stays pending.

    Two layers, both shielded from cancellation:
    - `stream_response` closes the body iterator. Starlette stops iterating on
      disconnect/cancellation but leaves an async generator suspended at its
      `yield`; closing it lets `run_generation` drain-and-complete or fail and
      refund promptly.
    - `__call__` runs `fail_if_pending` once the response is over, however it
      ended. This covers streams cut off before `run_generation` started (e.g.
      during the `cards` send, or before the body began), where closing an
      unstarted generator runs no handler.
    """

    def __init__(self, content, *, db: Session, reading_id: uuid.UUID, attempt: int, **kwargs):
        super().__init__(content, **kwargs)
        self._db = db
        self._reading_id = reading_id
        self._attempt = attempt

    async def stream_response(self, send: Send) -> None:
        try:
            await super().stream_response(send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()
                if await anyio.to_thread.run_sync(
                    fail_if_pending, self._db, self._reading_id, self._attempt
                ):
                    logger.warning(
                        "reading %s: stream ended before generation; refunded", self._reading_id
                    )


def _stream(
    db: Session, reading: Reading, cost: int, max_tokens: int = 2000
) -> _SSEResponse:
    # Counted when the stream is set up, before run_generation can call Claude, so
    # every attempt counts toward the rate limit, even one abandoned at once.
    record_generation(db, reading.user_id, "daily" if reading.spread_type == "daily" else "reading")

    async def event_stream() -> AsyncIterator[str]:
        gen = run_generation(db, reading, max_tokens=max_tokens)
        try:
            yield _sse(
                "cards", {"reading_id": str(reading.id), "cost": cost, "cards": reading.cards}
            )
            while True:
                try:
                    # The thread call is shielded (abandon_on_cancel=False): a cancel can
                    # land at anyio's checkpoint before the thread starts, but one issued
                    # mid-`next` is deferred until `next` returns, so `gen` is never closed
                    # while executing. Under uvicorn (ASGI spec 2.3) disconnect arrives as
                    # task-group cancellation, usually at Starlette's `send`, i.e. while
                    # we are suspended at a `yield` (handled by _SSEResponse's aclose).
                    chunk = await anyio.to_thread.run_sync(next, gen, _SENTINEL)
                except GenerationError:
                    yield _ERROR_EVENT
                    return
                except Exception:
                    # run_generation has already failed and refunded the reading.
                    logger.exception("reading %s: unexpected error during generation", reading.id)
                    yield _ERROR_EVENT
                    return
                if chunk is _SENTINEL:
                    break
                yield _sse("delta", {"text": chunk})
            yield _sse("done", {"reading_id": str(reading.id)})
        finally:
            # No-op if the generator finished; otherwise GeneratorExit inside
            # run_generation drains and completes the reading (text already sent)
            # or fails and refunds it, within the generation deadline.
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(gen.close)

    return _SSEResponse(
        event_stream(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
        db=db,
        reading_id=reading.id,
        attempt=current_attempt(reading),
    )


def _cost(db: Session, spread_type: str) -> int:
    return db.get(SpreadPrice, spread_type).credits


def _owned_reading(db: Session, user: User, reading_id: uuid.UUID) -> Reading:
    reading = db.scalar(
        select(Reading).where(Reading.id == reading_id, Reading.user_id == user.id)
    )
    if reading is None:
        raise NotFound("Reading not found")
    return reading


@router.post("/readings")
def create_reading(
    body: ReadingBody,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    check_user_rate(db, user.id, "reading", READING_LIMIT, HOUR)
    reading = start_reading(db, user, body.spread_type, body.question, body.profile_id)
    return _stream(db, reading, _cost(db, reading.spread_type))


@router.post("/readings/{reading_id}/retry")
def retry(
    reading_id: uuid.UUID,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    check_user_rate(db, user.id, "reading", READING_LIMIT, HOUR)
    reading = retry_reading(db, user, reading_id)
    return _stream(db, reading, _cost(db, reading.spread_type))


@router.get("/readings")
def list_readings(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
):
    rows = db.scalars(
        select(Reading)
        .where(Reading.user_id == user.id)
        .order_by(Reading.created_at.desc(), Reading.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": str(r.id),
            "spread_type": r.spread_type,
            "cards": r.cards,
            "question": r.question,
            "status": r.status,
            "created_at": r.created_at.isoformat(),
            "excerpt": (r.text or "")[:EXCERPT_CHARS],
        }
        for r in rows
    ]


def reading_payload(r: Reading) -> dict:
    return {
        "id": str(r.id),
        "spread_type": r.spread_type,
        "cards": r.cards,
        "question": r.question,
        "chart_id": str(r.chart_id) if r.chart_id else None,
        "text": r.text or "",
        "status": r.status,
        "created_at": r.created_at.isoformat(),
    }


@router.get("/readings/{reading_id}")
def get_reading(
    reading_id: uuid.UUID,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    return reading_payload(_owned_reading(db, user, reading_id))


@router.get("/spreads")
def list_spreads(db: Annotated[Session, Depends(get_db)]):
    prices = {p.spread_type: p.credits for p in db.scalars(select(SpreadPrice))}
    return [
        {
            "type": s.type,
            "name": SPREAD_NAMES.get(s.type, s.type.replace("_", " ").title()),
            "credits": prices[s.type],
            "positions": [p.model_dump() for p in s.positions],
        }
        for s in SPREADS.values()
    ]
