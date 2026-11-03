from itertools import combinations

from pydantic import BaseModel

from app.astro import angdiff

ASPECT_ANGLES = {
    "conjunction": 0.0,
    "opposition": 180.0,
    "trine": 120.0,
    "square": 90.0,
    "sextile": 60.0,
}
_LUMINARIES = {"sun", "moon"}


class Aspect(BaseModel):
    a: str
    b: str
    kind: str
    orb: float


def _max_orb(a: str, b: str, kind: str) -> float:
    if kind == "sextile":
        return 3.0
    return 8.0 if a in _LUMINARIES or b in _LUMINARIES else 6.0


def find_aspects(positions: dict[str, float]) -> list[Aspect]:
    """Major aspects between every unordered pair, in the order of `positions`."""
    found: list[Aspect] = []
    for a, b in combinations(positions, 2):
        separation = abs(angdiff(positions[a], positions[b]))
        best: Aspect | None = None
        for kind, angle in ASPECT_ANGLES.items():
            orb = abs(angdiff(separation, angle))
            if orb <= _max_orb(a, b, kind) and (best is None or orb < best.orb):
                best = Aspect(a=a, b=b, kind=kind, orb=orb)
        if best is not None:
            found.append(best)
    return found
