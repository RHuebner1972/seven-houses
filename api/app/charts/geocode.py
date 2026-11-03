from functools import lru_cache

import httpx
from pydantic import BaseModel

from app.config import get_settings
from app.errors import ServiceUnavailable

OPENCAGE_URL = "https://api.opencagedata.com/geocode/v1/json"
TIMEOUT_SECONDS = 5.0


class Place(BaseModel):
    label: str
    lat: float
    lon: float
    tz: str


def _fetch(q: str) -> dict:
    params = {
        "q": q,
        "key": get_settings().opencage_api_key,
        "limit": 5,
        "no_annotations": 0,
        "language": "en",
    }
    with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
        response = client.get(OPENCAGE_URL, params=params)
        response.raise_for_status()
        return response.json()


@lru_cache(maxsize=256)
def _geocode_cached(normalised: str) -> tuple[Place, ...]:
    try:
        body = _fetch(normalised)
    except (httpx.HTTPError, ValueError):
        raise ServiceUnavailable(
            "geocode_unavailable", "Place lookup is temporarily unavailable"
        ) from None
    places = []
    for result in body.get("results", []):
        tz = ((result.get("annotations") or {}).get("timezone") or {}).get("name")
        geometry = result.get("geometry") or {}
        if not tz or "lat" not in geometry or "lng" not in geometry:
            continue
        places.append(
            Place(label=result["formatted"], lat=geometry["lat"], lon=geometry["lng"], tz=tz)
        )
    return tuple(places)


def geocode(q: str) -> list[Place]:
    return list(_geocode_cached(q.strip().lower()))
