import httpx

from tests.conftest import auth_headers

PROFILE_BODY = {
    "name": "Rich",
    "birth_date": "1990-05-15",
    "birth_time": "09:15",
    "tz": "America/New_York",
    "lat": 42.30,
    "lon": -70.91,
    "place_label": "Hull, MA, USA",
}


def _create(client, user, **over):
    return client.post("/profiles", json={**PROFILE_BODY, **over}, headers=auth_headers(user))


def test_geocode_proxies_opencage(client, user, fake_opencage):
    r = client.get("/geocode", params={"q": "Hull, MA"}, headers=auth_headers(user))
    assert r.json() == [
        {"label": "Hull, MA, USA", "lat": 42.30, "lon": -70.91, "tz": "America/New_York"}
    ]
    params = fake_opencage.calls[0]["params"]
    assert params["q"] == "hull, ma" and params["limit"] == 5 and params["language"] == "en"


def test_geocode_caches_normalised_query(client, user, fake_opencage):
    for q in ("Hull, MA", "  hull, ma "):
        client.get("/geocode", params={"q": q}, headers=auth_headers(user))
    assert len(fake_opencage.calls) == 1


def test_geocode_short_query_422(client, user, fake_opencage):
    r = client.get("/geocode", params={"q": " a "}, headers=auth_headers(user))
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"
    assert fake_opencage.calls == []


def test_geocode_requires_auth(client, fake_opencage):
    assert client.get("/geocode", params={"q": "Hull"}).status_code == 401


def test_geocode_upstream_failure_503_not_cached(client, user, fake_opencage):
    fake_opencage.error = httpx.ConnectTimeout("slow")
    r = client.get("/geocode", params={"q": "Hull"}, headers=auth_headers(user))
    assert r.status_code == 503 and r.json()["error"]["code"] == "geocode_unavailable"
    fake_opencage.error = None
    assert client.get("/geocode", params={"q": "Hull"}, headers=auth_headers(user)).status_code == 200


def test_create_profile_returns_chart(client, user):
    r = _create(client, user)
    assert r.status_code == 201 and r.json()["chart"]["planets"]["sun"]["sign"] == "Taurus"
    p = r.json()["profile"]
    assert p["birth_date"] == "1990-05-15" and p["birth_time"] == "09:15"
    assert p["time_known"] is True and p["tz"] == "America/New_York" and p["name"] == "Rich"
    assert r.json()["chart"]["ascendant"] is not None


def test_create_profile_unknown_time(client, user):
    r = _create(client, user, birth_time=None)
    assert r.status_code == 201
    assert r.json()["chart"]["ascendant"] is None
    assert r.json()["profile"]["time_known"] is False
    assert r.json()["profile"]["birth_time"] is None


def test_future_birth_date_422(client, user):
    r = _create(client, user, birth_date="2999-01-01")
    assert r.status_code == 422 and "birth_date" in r.json()["error"]["message"]


def test_too_early_birth_date_422(client, user):
    r = _create(client, user, birth_date="1799-12-31")
    assert r.status_code == 422 and "birth_date" in r.json()["error"]["message"]


def test_birth_date_before_ephemeris_coverage_422(client, user):
    r = _create(client, user, birth_date="1849-06-01")
    assert r.status_code == 422 and "birth_date" in r.json()["error"]["message"]


def test_earliest_supported_birth_date_201(client, user):
    r = _create(client, user, birth_date="1850-01-01", birth_time="00:30", tz="Asia/Tokyo")
    assert r.status_code == 201


def test_ephemeris_range_error_maps_to_422(client, user, monkeypatch):
    from skyfield.errors import EphemerisRangeError

    from app.charts import router

    def out_of_range(*a, **kw):
        raise EphemerisRangeError("out of range", None, None, None, None)

    monkeypatch.setattr(router, "compute_chart", out_of_range)
    r = _create(client, user)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"


def test_bad_tz_and_bad_shape_422(client, user):
    assert _create(client, user, tz="Mars/Base").status_code == 422
    r = _create(client, user, lat=123)
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_failed"
    assert "lat" in r.json()["error"]["message"]
    assert _create(client, user, name="").status_code == 422


def test_profile_belongs_to_user(client, user, other_user):
    pid = _create(client, user).json()["profile"]["id"]
    h = auth_headers(other_user)
    assert client.get(f"/profiles/{pid}", headers=h).status_code == 404
    assert client.delete(f"/profiles/{pid}", headers=h).status_code == 404
    assert client.get("/profiles", headers=h).json() == {"profiles": []}
    assert client.get(f"/profiles/{pid}", headers=auth_headers(user)).status_code == 200


def test_unknown_profile_id_404(client, user):
    r = client.get("/profiles/00000000-0000-0000-0000-000000000000", headers=auth_headers(user))
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_list_get_delete(client, user, db):
    first = _create(client, user, name="First").json()["profile"]["id"]
    second = _create(client, user, name="Second").json()["profile"]["id"]
    listed = client.get("/profiles", headers=auth_headers(user)).json()["profiles"]
    assert [p["id"] for p in listed] == [second, first]
    got = client.get(f"/profiles/{first}", headers=auth_headers(user)).json()
    assert got["profile"]["name"] == "First" and got["chart"]["planets"]["sun"]["sign"] == "Taurus"
    assert client.delete(f"/profiles/{first}", headers=auth_headers(user)).status_code == 204
    assert client.get(f"/profiles/{first}", headers=auth_headers(user)).status_code == 404
    from sqlalchemy import func, select

    from app.models import Chart

    assert db.scalar(select(func.count()).select_from(Chart)) == 1


def test_profiles_require_auth(client):
    assert client.post("/profiles", json=PROFILE_BODY).status_code == 401
    assert client.get("/profiles").status_code == 401


def _stored_utc(db, profile_id):
    import uuid
    from datetime import UTC

    from app.models import BirthProfile

    db.expire_all()
    return db.get(BirthProfile, uuid.UUID(profile_id)).birth_datetime_utc.astimezone(UTC)


def test_dst_gap_birth_time_is_normalised_forward(client, user, db):
    from datetime import UTC, datetime

    r = _create(client, user, birth_date="2024-03-10", birth_time="02:30")
    assert r.status_code == 201
    assert r.json()["profile"]["birth_time"] == "03:30"
    assert _stored_utc(db, r.json()["profile"]["id"]) == datetime(2024, 3, 10, 7, 30, tzinfo=UTC)


def test_dst_fold_birth_time_uses_first_occurrence(client, user, db):
    from datetime import UTC, datetime

    r = _create(client, user, birth_date="2024-11-03", birth_time="01:30")
    assert r.json()["profile"]["birth_time"] == "01:30"
    assert _stored_utc(db, r.json()["profile"]["id"]) == datetime(2024, 11, 3, 5, 30, tzinfo=UTC)


def test_geocode_empty_result_not_cached(client, user, fake_opencage):
    fake_opencage.body = {"results": []}
    h = auth_headers(user)
    assert client.get("/geocode", params={"q": "Nowhere"}, headers=h).json() == []
    client.get("/geocode", params={"q": "Nowhere"}, headers=h)
    assert len(fake_opencage.calls) == 2
    fake_opencage.body = None
    client.get("/geocode", params={"q": "Hull"}, headers=h)
    client.get("/geocode", params={"q": "Hull"}, headers=h)
    assert len(fake_opencage.calls) == 3
