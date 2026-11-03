import uuid
from datetime import UTC, date, datetime, time
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.astro.chart import compute_chart
from app.astro.time import to_utc
from app.auth.deps import current_user
from app.charts.geocode import geocode
from app.db import get_db
from app.errors import NotFound, ValidationFailed
from app.models import BirthProfile, Chart, User

router = APIRouter()

MIN_BIRTH_DATE = date(1800, 1, 1)


class ProfileBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    birth_date: date
    birth_time: time | None = None
    tz: str
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    place_label: str


def _profile_json(p: BirthProfile) -> dict:
    local = p.birth_datetime_utc.astimezone(ZoneInfo(p.birth_tz))
    return {
        "id": str(p.id),
        "name": p.name,
        "birth_date": local.date().isoformat(),
        "birth_time": local.strftime("%H:%M") if p.time_known else None,
        "tz": p.birth_tz,
        "lat": p.lat,
        "lon": p.lon,
        "place_label": p.place_label,
        "time_known": p.time_known,
        "created_at": p.created_at.isoformat(),
    }


def _owned_profile(db: Session, user: User, profile_id: uuid.UUID) -> BirthProfile:
    profile = db.scalar(
        select(BirthProfile).where(BirthProfile.id == profile_id, BirthProfile.user_id == user.id)
    )
    if profile is None:
        raise NotFound("Profile not found")
    return profile


@router.get("/geocode")
def geocode_places(q: str, _user: Annotated[User, Depends(current_user)]):
    if len(q.strip()) < 2:
        raise ValidationFailed("q: must be at least 2 characters")
    return [place.model_dump() for place in geocode(q)]


@router.post("/profiles", status_code=201)
def create_profile(
    body: ProfileBody,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Create a birth profile and its chart.

    Nonexistent local times in a DST gap are normalised forward; the stored
    instant (birth_datetime_utc) is authoritative.
    """
    if body.birth_date > datetime.now(UTC).date():
        raise ValidationFailed("birth_date: must not be in the future")
    if body.birth_date < MIN_BIRTH_DATE:
        raise ValidationFailed("birth_date: must be on or after 1800-01-01")
    time_known = body.birth_time is not None
    utc = to_utc(datetime.combine(body.birth_date, body.birth_time or time(12, 0)), body.tz)
    chart = compute_chart(utc, body.lat, body.lon, time_known)
    profile = BirthProfile(
        user_id=user.id,
        name=body.name,
        birth_datetime_utc=utc,
        birth_tz=body.tz,
        lat=body.lat,
        lon=body.lon,
        place_label=body.place_label,
        time_known=time_known,
    )
    db.add(profile)
    db.flush()
    chart_data = chart.model_dump(mode="json")
    db.add(Chart(birth_profile_id=profile.id, data=chart_data, engine_version=chart.engine_version))
    db.commit()
    db.refresh(profile)
    return {"profile": _profile_json(profile), "chart": chart_data}


@router.get("/profiles")
def list_profiles(
    user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]
):
    rows = db.scalars(
        select(BirthProfile)
        .where(BirthProfile.user_id == user.id)
        .order_by(BirthProfile.created_at.desc())
    ).all()
    return {"profiles": [_profile_json(p) for p in rows]}


@router.get("/profiles/{profile_id}")
def get_profile(
    profile_id: uuid.UUID,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    profile = _owned_profile(db, user, profile_id)
    chart = db.scalar(select(Chart).where(Chart.birth_profile_id == profile.id))
    return {"profile": _profile_json(profile), "chart": chart.data if chart else None}


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(
    profile_id: uuid.UUID,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    db.delete(_owned_profile(db, user, profile_id))
    db.commit()
    return Response(status_code=204)
