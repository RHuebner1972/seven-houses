from datetime import UTC, datetime

import pytest

from app.astro import angdiff
from app.astro.ephemeris import BODIES, longitudes
from app.astro.time import julian_date, to_utc
from app.errors import ValidationFailed


def test_sun_at_march_2000_equinox():
    lon = longitudes(datetime(2000, 3, 20, 7, 35, tzinfo=UTC))["sun"]
    assert abs(lon) < 0.02 or abs(lon - 360) < 0.02


def test_sun_at_june_2000_solstice():
    assert abs(longitudes(datetime(2000, 6, 21, 1, 48, tzinfo=UTC))["sun"] - 90.0) < 0.02


def test_longitudes_cover_all_bodies_in_range():
    lons = longitudes(datetime(2024, 11, 3, 3, 0, tzinfo=UTC))
    assert list(lons) == BODIES
    assert all(0.0 <= v < 360.0 for v in lons.values())


def test_all_bodies_match_swisseph():  # dev-only cross-check
    swe = pytest.importorskip("swisseph")
    pairs = [
        ("sun", swe.SUN),
        ("moon", swe.MOON),
        ("mercury", swe.MERCURY),
        ("venus", swe.VENUS),
        ("mars", swe.MARS),
        ("jupiter", swe.JUPITER),
        ("saturn", swe.SATURN),
        ("uranus", swe.URANUS),
        ("neptune", swe.NEPTUNE),
        ("pluto", swe.PLUTO),
        ("north_node", swe.MEAN_NODE),
    ]
    for utc in [datetime(1985, 7, 4, 14, 30, tzinfo=UTC), datetime(2024, 11, 3, 3, 0, tzinfo=UTC)]:
        ours = longitudes(utc)
        jd = swe.julday(utc.year, utc.month, utc.day, utc.hour + utc.minute / 60.0)
        for body, swe_id in pairs:
            theirs = swe.calc_ut(jd, swe_id, swe.FLG_SWIEPH | swe.FLG_SPEED)[0][0]
            assert abs(angdiff(ours[body], theirs)) < 0.05, (utc, body, ours[body], theirs)


def test_julian_date_j2000():
    assert julian_date(datetime(2000, 1, 1, 12, 0, tzinfo=UTC)) == pytest.approx(2451545.0, abs=1e-9)


def test_angdiff_wraps():
    assert angdiff(359.0, 1.0) == pytest.approx(-2.0)
    assert angdiff(1.0, 359.0) == pytest.approx(2.0)
    assert angdiff(0.0, 180.0) == pytest.approx(180.0)
    assert angdiff(180.0, 0.0) == pytest.approx(180.0)


def test_to_utc_dst_gap_does_not_raise():
    assert to_utc(datetime(2024, 3, 10, 2, 30), "America/New_York").tzinfo is not None


def test_to_utc_dst_fold_uses_first_occurrence():
    assert to_utc(datetime(2024, 11, 3, 1, 30), "America/New_York") == datetime(2024, 11, 3, 5, 30, tzinfo=UTC)


def test_to_utc_bad_tz_raises_validation():
    with pytest.raises(ValidationFailed):
        to_utc(datetime(2024, 1, 1, 0, 0), "Mars/Olympus")


def test_to_utc_malformed_tz_raises_validation():
    with pytest.raises(ValidationFailed):
        to_utc(datetime(2024, 1, 1, 0, 0), "../etc/passwd")
