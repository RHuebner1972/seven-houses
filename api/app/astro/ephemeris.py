from datetime import datetime
from functools import lru_cache
from pathlib import Path

from skyfield.api import Loader, load_file

from app.config import get_settings

BODIES = [
    "sun", "moon", "mercury", "venus", "mars", "jupiter",
    "saturn", "uranus", "neptune", "pluto", "north_node",
]

_KERNEL_TARGETS = {
    "sun": "sun",
    "moon": "moon",
    "mercury": "mercury",
    "venus": "venus",
    # de440s carries no Mars body (499); its barycenter is within metres of it.
    "mars": "mars barycenter",
    "jupiter": "jupiter barycenter",
    "saturn": "saturn barycenter",
    "uranus": "uranus barycenter",
    "neptune": "neptune barycenter",
    "pluto": "pluto barycenter",
}

_API_ROOT = Path(__file__).resolve().parents[2]


def _kernel_path() -> Path:
    path = Path(get_settings().ephemeris_path)
    return path if path.is_absolute() else _API_ROOT / path


@lru_cache
def get_ephemeris():
    """Return (kernel, timescale). Loads only local files; never downloads."""
    path = _kernel_path()
    loader = Loader(str(path.parent), verbose=False)
    kernel = load_file(str(path))
    timescale = loader.timescale(builtin=True)
    return kernel, timescale


def mean_node(t_centuries: float) -> float:
    """Mean longitude of the Moon's ascending node (Meeus), degrees [0, 360)."""
    t = t_centuries
    lon = (
        125.0445479
        - 1934.1362891 * t
        + 0.0020754 * t**2
        + t**3 / 467441.0
        - t**4 / 60616000.0
    )
    return lon % 360.0


def longitudes(utc: datetime) -> dict[str, float]:
    """Apparent geocentric ecliptic longitude of date (tropical), degrees [0, 360)."""
    if utc.tzinfo is None:
        raise ValueError("longitudes requires an aware datetime")
    kernel, ts = get_ephemeris()
    t = ts.from_datetime(utc)
    earth = kernel["earth"].at(t)
    out: dict[str, float] = {}
    for body in BODIES:
        if body == "north_node":
            out[body] = mean_node((t.tt - 2451545.0) / 36525.0)
            continue
        target = kernel[_KERNEL_TARGETS[body]]
        _, lon, _ = earth.observe(target).apparent().ecliptic_latlon(epoch="date")
        out[body] = lon.degrees % 360.0
    return out
