from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, TypeAdapter, ValidationError
from pydantic.networks import EmailStr
from sqlalchemy.orm import Session

from app.auth.deps import current_user, optional_current_user
from app.auth.google import verify_google_id_token
from app.auth.jwt import mint_token
from app.auth.linking import link_and_commit
from app.auth.magic import consume_magic_token, issue_magic_link
from app.db import get_db
from app.ledger.service import balance
from app.models import User
from app.ratelimit import (
    ANON_MINT_LIMIT,
    HOUR,
    MAGIC_REQUEST_LIMIT,
    check_ip_rate,
    client_ip,
)

router = APIRouter()

_email_adapter = TypeAdapter(EmailStr)


class GoogleBody(BaseModel):
    id_token: str


class MagicRequestBody(BaseModel):
    email: str


class MagicVerifyBody(BaseModel):
    token: str


def _signed_in(user: User) -> dict:
    return {"token": mint_token(user.id, False), "user_id": str(user.id)}


@router.post("/auth/anonymous", status_code=201)
def create_anonymous(request: Request, db: Annotated[Session, Depends(get_db)]):
    check_ip_rate(db, client_ip(request), "anon_mint", ANON_MINT_LIMIT, HOUR)
    user = User()
    db.add(user)
    db.commit()
    return {"token": mint_token(user.id, True), "user_id": str(user.id)}


@router.post("/auth/refresh")
def refresh(user: Annotated[User, Depends(current_user)]):
    return {"token": mint_token(user.id, user.email is None)}


@router.get("/me")
def me(user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]):
    return {
        "user_id": str(user.id),
        "email": user.email,
        "anon": user.email is None,
        "balance": balance(db, user.id),
    }


@router.post("/auth/google")
def google_sign_in(
    body: GoogleBody,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    identity = verify_google_id_token(body.id_token)
    linked = link_and_commit(db, user, "google", identity.subject, identity.email)
    return _signed_in(linked)


@router.post("/auth/magic/request", status_code=202)
def magic_request(
    request: Request,
    body: MagicRequestBody,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    check_ip_rate(db, client_ip(request), "magic_request", MAGIC_REQUEST_LIMIT, HOUR)
    try:
        email = str(_email_adapter.validate_python(body.email.strip())).lower()
    except ValidationError:
        return {}
    issue_magic_link(db, email, user.id)
    return {}


@router.post("/auth/magic/verify")
def magic_verify(
    body: MagicVerifyBody,
    db: Annotated[Session, Depends(get_db)],
    requester: Annotated[User | None, Depends(optional_current_user)],
):
    """Send the requesting device's bearer to link that (anonymous) user; without one
    the link signs in as the email's owner, or a new user for that email."""
    return _signed_in(consume_magic_token(db, body.token, requester))


@router.delete("/account", status_code=204)
def delete_account(user: Annotated[User, Depends(current_user)], db: Annotated[Session, Depends(get_db)]):
    # Every user FK is ON DELETE CASCADE (profiles, charts, readings, daily draws, ledger, magic tokens).
    db.delete(user)
    db.commit()
    return Response(status_code=204)
