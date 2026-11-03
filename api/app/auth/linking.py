from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User


def link_identity(
    db: Session, current: User, provider: str, subject: str | None, email: str
) -> User:
    """Attach an identity to `current`, or return the existing owner of that identity.

    If the identity already belongs to another user, `current` (an anonymous
    user) is abandoned, not deleted, and the existing user is returned.
    """
    found = None
    if subject is not None:
        found = db.scalars(
            select(User).where(User.auth_provider == provider, User.auth_subject == subject)
        ).first()
    if found is None:
        found = db.scalars(select(User).where(User.email == email)).first()
    if found is not None and found.id != current.id:
        return found
    current.email = email
    current.auth_provider = provider
    current.auth_subject = subject
    return current
