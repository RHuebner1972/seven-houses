from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import ValidationFailed
from app.models import User


def _find_owner(
    db: Session, current: User, provider: str, subject: str | None, email: str
) -> User | None:
    """Return another user who already owns this identity (by subject, else email)."""
    if subject is not None:
        found = db.scalars(
            select(User).where(
                User.auth_provider == provider,
                User.auth_subject == subject,
                User.id != current.id,
            )
        ).first()
        if found is not None:
            return found
    return db.scalars(select(User).where(User.email == email, User.id != current.id)).first()


def link_identity(
    db: Session, current: User, provider: str, subject: str | None, email: str
) -> User:
    """Attach an identity to `current`, or return the existing owner of that identity.

    If the identity already belongs to another user, `current` (an anonymous
    user) is abandoned, not deleted, and the existing user is returned.
    An already-linked `current` is never silently rewritten to a different identity.
    """
    owner = _find_owner(db, current, provider, subject, email)
    if owner is not None:
        return owner
    if current.email is None:
        current.email = email
        current.auth_provider = provider
        current.auth_subject = subject
    elif subject is not None and (current.auth_provider, current.auth_subject) == (
        provider,
        subject,
    ):
        current.email = email  # same account, provider reports a changed email
    elif current.email != email:
        raise ValidationFailed("Account already linked to another identity")
    return current


def link_and_commit(
    db: Session,
    current: User,
    provider: str,
    subject: str | None,
    email: str,
    before_commit: Callable[[], None] | None = None,
) -> User:
    """link_identity + commit; a lost race on users.email resolves to the winner."""
    try:
        user = link_identity(db, current, provider, subject, email)
        if before_commit:
            before_commit()
        db.commit()
        return user
    except IntegrityError:
        db.rollback()
        owner = db.scalars(select(User).where(User.email == email, User.id != current.id)).first()
        if owner is None:
            raise
        if before_commit:
            before_commit()
        db.commit()
        return owner
