import random

import pytest

from app.tarot.cards import CARD_BY_ID, CARDS
from app.tarot.draw import draw
from app.tarot.spreads import SPREADS


def test_catalogue_has_78_unique_cards():
    assert len(CARDS) == 78 and len({c.id for c in CARDS}) == 78
    assert sum(c.arcana == "major" for c in CARDS) == 22


def test_every_card_has_keywords():
    assert all(3 <= len(c.upright) <= 5 and 3 <= len(c.reversed) <= 5 for c in CARDS)


def test_ids_names_images_and_courts():
    assert CARD_BY_ID["major-00-fool"].name == "The Fool"
    assert CARD_BY_ID["major-21-world"].number == 21
    assert CARD_BY_ID["wands-01"].name == "Ace of Wands"
    assert CARD_BY_ID["cups-11-page"].name == "Page of Cups"
    assert CARD_BY_ID["swords-13-queen"].name == "Queen of Swords"
    assert CARD_BY_ID["pentacles-14-king"].number == 14
    assert CARD_BY_ID["cups-05"].suit == "cups" and CARD_BY_ID["major-01-magician"].suit is None
    assert all(c.image == f"/deck/{c.id}.webp" for c in CARDS)
    for suit in ("wands", "cups", "swords", "pentacles"):
        assert sum(c.suit == suit for c in CARDS) == 14


def test_reversed_differs_from_upright():
    assert all(not set(c.upright) & set(c.reversed) for c in CARDS)


def test_spread_position_counts():
    assert [len(SPREADS[k].positions) for k in ("daily", "three_card", "celtic_cross")] == [1, 3, 10]


def test_spread_keys():
    assert [p.key for p in SPREADS["celtic_cross"].positions] == [
        "present", "challenge", "past", "future", "above",
        "below", "advice", "external", "hopes_fears", "outcome",
    ]
    assert [p.key for p in SPREADS["three_card"].positions] == ["past", "present", "future"]
    assert SPREADS["daily"].positions[0].key == "card"
    assert SPREADS["daily"].positions[0].name == "Card of the Day"


def test_draw_unique_cards_and_positions():
    d = draw("celtic_cross")
    assert len({x.card_id for x in d}) == 10
    assert [x.position for x in d] == [p.key for p in SPREADS["celtic_cross"].positions]
    assert all(x.card_id in CARD_BY_ID for x in d)


def test_draw_is_deterministic_with_seeded_rng():
    assert draw("three_card", random.Random(7)) == draw("three_card", random.Random(7))


def test_drawn_card_serializes():
    assert set(draw("daily")[0].model_dump()) == {"position", "card_id", "reversed"}


def test_reversal_rate_near_half():
    rng = random.Random(42)
    n = sum(x.reversed for _ in range(500) for x in draw("three_card", rng))
    assert 650 < n < 850


def test_unknown_spread_raises():
    with pytest.raises(KeyError):
        draw("nope")
