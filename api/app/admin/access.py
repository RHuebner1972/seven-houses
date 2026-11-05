from typing import Annotated

from fastapi import Depends, Request

from app.auth.deps import current_user
from app.config import Settings
from app.errors import Forbidden
from app.models import User


def is_admin(user: User, settings: Settings) -> bool:
    if not user.email:
        return False
    allowed = {email.lower() for email in settings.admin_emails}
    return user.email.lower() in allowed


def current_admin(
    user: Annotated[User, Depends(current_user)],
    request: Request,
) -> User:
    if not is_admin(user, request.app.state.settings):
        raise Forbidden("Admin only")
    return user
