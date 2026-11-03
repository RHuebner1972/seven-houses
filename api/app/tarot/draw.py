import secrets
from typing import Protocol

from pydantic import BaseModel

from .cards import CARDS
from .spreads import SPREADS


class DrawnCard(BaseModel):
    position: str
    card_id: str
    reversed: bool


class Rng(Protocol):
    def shuffle(self, x: list) -> None: ...
    def random(self) -> float: ...


def draw(spread_type: str, rng: Rng | None = None) -> list[DrawnCard]:
    spread = SPREADS[spread_type]
    rng = rng or secrets.SystemRandom()
    deck = [c.id for c in CARDS]
    rng.shuffle(deck)
    return [
        DrawnCard(position=pos.key, card_id=card_id, reversed=rng.random() < 0.5)
        for pos, card_id in zip(spread.positions, deck)
    ]
