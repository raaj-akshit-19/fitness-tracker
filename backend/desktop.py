"""Raft on one computer, over the Excel workbook: the desktop edition.

This is what "Start Fitness Tracker.bat" and the packaged Windows program run
(see launch.py). It listens only on 127.0.0.1, has one user, the person at this
computer, and no sign-in. The web edition, deployed with wsgi.py, never
imports this module or anything that reads a workbook.
"""

from dataclasses import dataclass

from backend import errors as er
from backend.app import create_app
from backend.store import TrackerStore

LOCAL_NAME = "This computer"


@dataclass(frozen=True)
class LocalSession:
    user_id: str = "local"
    email: str = ""
    display_name: str = LOCAL_NAME

    def public(self):
        # "local" tells the page there is no account to sign out of.
        return {"email": self.email, "display_name": self.display_name, "local": True}


class LocalAuth:
    """The desktop's stand-in for accounts: whoever can reach 127.0.0.1 is the user."""

    def resume(self, access_token, refresh_token):
        return LocalSession(), False

    def sign_in(self, email, password):
        raise er.InvalidCredentialsError()

    def sign_up(self, email, password, display_name):
        raise er.InvalidCredentialsError()

    def sign_out(self, session):
        return None


def create_desktop_app(workbook_path, today=None):
    """The app over the workbook at workbook_path."""
    return create_app(store_factory=lambda session: TrackerStore(workbook_path), auth=LocalAuth(), today=today)
