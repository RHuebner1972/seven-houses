from datetime import UTC, datetime

import pytest

from app.astro import angdiff
from app.astro.angles import ascendant_mc
from app.astro.aspects import find_aspects
from app.astro.chart import compute_chart
from app.astro.houses import degree_in_sign, sign_of, whole_sign_house


def test_asc_mc_match_swisseph():  # dev-only cross-check
    swe = pytest.importorskip("swisseph")
    utc = datetime(1990, 5, 15, 9, 15, tzinfo=UTC)
    asc, mc = ascendant_mc(utc, 42.30, -70.91)
    _, ascmc = swe.houses(swe.julday(1990, 5, 15, 9.25), 42.30, -70.91, b"W")
    assert abs(angdiff(asc, ascmc[0])) < 0.05
    assert abs(angdiff(mc, ascmc[1])) < 0.05


def test_asc_is_eastern_horizon_point():
    asc, mc = ascendant_mc(datetime(1990, 5, 15, 9, 15, tzinfo=UTC), 42.30, -70.91)
    assert 0.0 < (asc - mc) % 360.0 < 180.0


def test_polar_latitude_returns_none():
    assert ascendant_mc(datetime(2000, 1, 1, tzinfo=UTC), 80.0, 0.0) is None


def test_sign_and_degree():
    assert sign_of(0.0) == "Aries"
    assert sign_of(45.5) == "Taurus"
    assert sign_of(359.9) == "Pisces"
    assert degree_in_sign(45.5) == pytest.approx(15.5)


def test_whole_sign_houses():
    assert whole_sign_house(5.0, 3.0) == 1  # both Aries
    assert whole_sign_house(35.0, 3.0) == 2  # Taurus planet, Aries asc
    assert whole_sign_house(350.0, 3.0) == 12


def test_aspect_orbs():
    a = find_aspects({"sun": 0.0, "mars": 7.5, "venus": 65.0, "saturn": 185.0, "jupiter": 277.0})
    kinds = {(x.a, x.b): x.kind for x in a}
    assert kinds[("sun", "mars")] == "conjunction"  # 7.5°, within 8° because Sun is involved
    assert ("sun", "venus") not in kinds  # 65°: 5° off sextile, sextile orb is 3°
    assert kinds[("sun", "saturn")] == "opposition"  # 185°: 5° off, within 8°
    assert kinds[("mars", "saturn")] == "opposition"  # 177.5°: 2.5° off, within 6°
    assert kinds[("venus", "saturn")] == "trine"  # exactly 120°
    assert kinds[("mars", "venus")] == "sextile"  # 57.5°: 2.5° off, within 3°
    assert kinds[("sun", "jupiter")] == "square"  # 277° is 83° the short way: 7° off, within 8°
    assert ("venus", "jupiter") not in kinds  # 148° the short way: nothing within orb


def test_aspect_orb_value():
    (asp,) = find_aspects({"sun": 0.0, "mars": 7.5})
    assert asp.orb == pytest.approx(7.5)


def test_compute_chart_unknown_time_has_no_houses():
    c = compute_chart(datetime(1990, 5, 15, 12, 0, tzinfo=UTC), 42.3, -70.9, time_known=False)
    assert c.ascendant is None and all(p.house is None for p in c.planets.values())
    assert c.mc is None and c.time_known is False


def test_compute_chart_known_time_has_houses():
    c = compute_chart(datetime(1990, 5, 15, 9, 15, tzinfo=UTC), 42.3, -70.9, time_known=True)
    assert c.ascendant is not None and all(1 <= p.house <= 12 for p in c.planets.values())
    assert c.ascendant.house == 1 and c.engine_version == "1" and c.time_known is True


def test_compute_chart_polar_known_time_degrades():
    c = compute_chart(datetime(1990, 5, 15, 9, 15, tzinfo=UTC), 80.0, 0.0, time_known=True)
    assert c.ascendant is None and c.mc is None and c.time_known is False
    assert all(p.house is None for p in c.planets.values())


def test_retrograde_flags():
    # Mercury was retrograde 2024-04-01 .. 2024-04-25; nodes/luminaries never flagged.
    c = compute_chart(datetime(2024, 4, 10, 12, 0, tzinfo=UTC), 0.0, 0.0, time_known=False)
    assert c.planets["mercury"].retrograde is True
    assert c.planets["venus"].retrograde is False
    assert not any(c.planets[b].retrograde for b in ("sun", "moon", "north_node"))
