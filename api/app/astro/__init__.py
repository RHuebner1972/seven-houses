"""Astronomical core of the natal chart engine."""


def angdiff(a: float, b: float) -> float:
    """Signed smallest difference a - b in degrees, in (-180, 180]."""
    d = (a - b) % 360.0
    return d - 360.0 if d > 180.0 else d
