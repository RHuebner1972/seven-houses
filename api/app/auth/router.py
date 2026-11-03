from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth.deps import current_user
from app.auth.jwt import mint_token
from app.db import get_db
from app.ledger.service import balance
from app.models import User

router = APIRouter()


@router.post("/auth/anonymous", status_code=201)
def create_anonymous(db: Annotated[Session, Depends(get_db)]):
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
