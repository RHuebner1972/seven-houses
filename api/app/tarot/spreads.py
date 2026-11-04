from pydantic import BaseModel


class Position(BaseModel):
    key: str
    name: str
    meaning: str


class Spread(BaseModel):
    type: str
    positions: list[Position]


def _spread(type_: str, rows: list[tuple[str, str, str]]) -> Spread:
    return Spread(type=type_, positions=[Position(key=k, name=n, meaning=m) for k, n, m in rows])


SPREADS: dict[str, Spread] = {
    "daily": _spread("daily", [
        ("card", "Card of the Day", "The energy or lesson most worth noticing today."),
    ]),
    "three_card": _spread("three_card", [
        ("past", "Past", "The background and earlier events that shaped the situation."),
        ("present", "Present", "The current state of things and what is active right now."),
        ("future", "Future", "The direction things are heading if the present course continues."),
    ]),
    "celtic_cross": _spread("celtic_cross", [
        ("present", "Present", "The heart of the matter as it stands now."),
        ("challenge", "Challenge", "The obstacle or opposing force crossing your path."),
        ("past", "Past", "The foundation and recent events leading to this moment."),
        ("future", "Future", "What is approaching in the near term."),
        ("above", "Above", "Your conscious aim, ideal, or best possible outcome."),
        ("below", "Below", "The unconscious roots and underlying drivers of the situation."),
        ("advice", "Advice", "The stance or approach that would serve you best."),
        ("external", "External Influences", "How other people and surroundings affect the situation."),
        (
            "hopes_fears",
            "Hopes and Fears",
            "What you long for and what you dread, which are often entangled.",
        ),
        ("outcome", "Outcome", "Where the situation is likely to settle."),
    ]),
}
