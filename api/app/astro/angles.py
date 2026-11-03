import math
from datetime import datetime

from app.astro.ephemeris import get_ephemeris

MAX_ABS_LATITUDE = 66.0


def mean_obliquity(t_centuries: float) -> float:
    """Mean obliquity of the ecliptic of date (IAU, Meeus 22.2), degrees."""
    t = t_centuries
    seconds = 21.448 - 46.8150 * t - 0.00059 * t**2 + 0.001813 * t**3
    return 23.0 + 26.0 / 60.0 + seconds / 3600.0


def ascendant_mc(utc: datetime, lat: float, lon: float) -> tuple[float, float] | None:
    """(Ascendant, MC) ecliptic longitudes in degrees [0, 360); None above the polar circles.

    `lon` is geographic longitude, east positive.
    """
    if abs(lat) > MAX_ABS_LATITUDE:
        return None
    if utc.tzinfo is None:
        raise ValueError("ascendant_mc requires an aware datetime")
    _, ts = get_ephemeris()
    t = ts.from_datetime(utc)
    ramc = math.radians((t.gmst * 15.0 + lon) % 360.0)
    eps = math.radians(mean_obliquity((t.tt - 2451545.0) / 36525.0))
    phi = math.radians(lat)

    mc = math.degrees(math.atan2(math.sin(ramc), math.cos(ramc) * math.cos(eps))) % 360.0
    # Eastern horizon point: these y/x signs select the rising (not setting) intersection;
    # negating both would return the Descendant.
    asc = math.degrees(
        math.atan2(
            math.cos(ramc),
            -(math.sin(ramc) * math.cos(eps) + math.tan(phi) * math.sin(eps)),
        )
    ) % 360.0
    return asc, mc
