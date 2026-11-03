from datetime import datetime, timedelta

from pydantic import BaseModel

from app.astro import angdiff
from app.astro.angles import ascendant_mc
from app.astro.aspects import Aspect, find_aspects
from app.astro.ephemeris import longitudes
from app.astro.houses import degree_in_sign, sign_of, whole_sign_house

_NEVER_RETROGRADE = {"sun", "moon", "north_node"}
_RETRO_STEP = timedelta(hours=1)


class Placement(BaseModel):
    longitude: float
    sign: str
    degree: float
    house: int | None
    retrograde: bool


class ChartData(BaseModel):
    engine_version: str = "1"
    time_known: bool
    planets: dict[str, Placement]
    ascendant: Placement | None
    mc: Placement | None
    aspects: list[Aspect]


def _placement(lon: float, asc_lon: float | None, retrograde: bool = False) -> Placement:
    return Placement(
        longitude=lon,
        sign=sign_of(lon),
        degree=degree_in_sign(lon),
        house=None if asc_lon is None else whole_sign_house(lon, asc_lon),
        retrograde=retrograde,
    )


def compute_chart(utc: datetime, lat: float, lon: float, time_known: bool) -> ChartData:
    positions = longitudes(utc)
    before = longitudes(utc - _RETRO_STEP)
    after = longitudes(utc + _RETRO_STEP)

    angles = ascendant_mc(utc, lat, lon) if time_known else None
    asc_lon = angles[0] if angles else None

    planets = {
        body: _placement(
            p,
            asc_lon,
            body not in _NEVER_RETROGRADE and angdiff(after[body], before[body]) < 0,
        )
        for body, p in positions.items()
    }
    return ChartData(
        time_known=angles is not None,
        planets=planets,
        ascendant=_placement(angles[0], asc_lon) if angles else None,
        mc=_placement(angles[1], asc_lon) if angles else None,
        aspects=find_aspects(positions),
    )
