def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_app_error_shape(client):
    r = client.get("/_test/raise-not-found")  # test-only route registered in conftest
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "nope"}}
