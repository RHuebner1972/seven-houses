from dataclasses import dataclass

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token

from app.config import get_settings
from app.errors import Unauthorized


@dataclass(frozen=True)
class GoogleIdentity:
    subject: str
    email: str


def _verify_oauth2_token(id_token: str, request, client_id: str) -> dict:
    return google_id_token.verify_oauth2_token(id_token, request, client_id)


def verify_google_id_token(id_token: str) -> GoogleIdentity:
    try:
        claims = _verify_oauth2_token(
            id_token, google_requests.Request(), get_settings().google_client_id
        )
        subject, email = claims["sub"], claims["email"]
    except (ValueError, KeyError) as e:
        raise Unauthorized("Invalid Google ID token") from e
    if claims.get("email_verified") is not True:
        raise Unauthorized("Google email is not verified")
    return GoogleIdentity(subject=subject, email=email.lower())
