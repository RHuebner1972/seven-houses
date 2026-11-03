import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

_DATA_PATH = Path(__file__).parent / "data" / "cards.json"


class Card(BaseModel):
    id: str
    name: str
    arcana: Literal["major", "minor"]
    suit: str | None
    number: int
    upright: list[str]
    reversed: list[str]
    image: str


def _load() -> list[Card]:
    raw = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
    return [Card.model_validate(entry) for entry in raw]


CARDS: list[Card] = _load()
CARD_BY_ID: dict[str, Card] = {c.id: c for c in CARDS}
