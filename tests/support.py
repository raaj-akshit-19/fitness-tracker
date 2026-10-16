"""What the tests use to run Raft's API without a network.

workbook_app(path)   the API over the workbook store, signed in as one user.
                     The workbook format is a library now; this is how its
                     existing tests keep checking it behind the same routes.
cloud_app()          the API over the Supabase store, with FakeSupabase standing
                     in for the project: accounts, and per-user tables with the
                     same rules as the real schema (one month per user and
                     month, days only inside a kept month, deleting a month
                     deletes its days, every row visible to its owner only).

The real thing, Supabase's own auth server and REST layer over PostgreSQL with
the real migrations, is tested in test_supabase_stack.py.
"""

import itertools
import secrets
import threading
import time
from datetime import date, datetime, timezone

from backend import errors as er
from backend.app import create_app
from backend.auth import Session
from backend.store import TrackerStore
from backend.supabase_store import SupabaseStore

TEST_USER = Session(user_id="00000000-0000-4000-8000-000000000001", email="test@example.test",
                    display_name="Test", access_token="test-access", refresh_token="test-refresh",
                    expires_at=4102444800.0)


class SignedInAuth:
    """Every request is the one test user."""

    def resume(self, access_token, refresh_token):
        return TEST_USER, False

    def sign_in(self, email, password):
        return TEST_USER

    def sign_up(self, email, password, display_name):
        return TEST_USER

    def sign_out(self, session):
        pass


def workbook_app(path, today=None):
    """The API over a workbook, as the workbook tests have always used it."""
    return create_app(store_factory=lambda session: TrackerStore(path), auth=SignedInAuth(), today=today)


# ---------------------------------------------------------------- a stand-in Supabase project

class FakeSupabase:
    """Accounts and tables in memory, with the rules the real project enforces."""

    def __init__(self, confirm_email=False, token_lifetime=3600, clock=time.time):
        self.confirm_email = confirm_email
        self.token_lifetime = token_lifetime
        self.clock = clock
        self.lock = threading.Lock()
        self.accounts = {}          # email -> {id, password, display_name, confirmed}
        self.access = {}            # access token -> (user id, expires at)
        self.refresh = {}           # refresh token -> user id
        self.profiles = {}          # user id -> {email, display_name, changed_at}
        self.months = {}            # user id -> set of (year, month)
        self.days = {}              # user id -> {date iso -> row}
        self.sundays = {}           # user id -> {date iso -> row}
        self.down = False           # True: every call fails as if Supabase were unreachable
        self.calls = []             # (user id, what) for every repository call
        self._ids = itertools.count(1)
        self._ticks = itertools.count(1)

    def check(self):
        if self.down:
            raise er.ServiceUnavailableError()

    def touch(self, user):
        tick = next(self._ticks)
        self.profiles[user]["changed_at"] = datetime(2026, 1, 1, tzinfo=timezone.utc).replace(microsecond=tick % 1_000_000).isoformat()

    def new_user(self, email, password="correct-horse-1", display_name="Someone", confirmed=True):
        user = f"00000000-0000-4000-8000-{next(self._ids):012d}"
        self.accounts[email] = {"id": user, "password": password, "display_name": display_name, "confirmed": confirmed}
        self.profiles[user] = {"email": email, "display_name": display_name, "changed_at": ""}
        self.months[user], self.days[user], self.sundays[user] = set(), {}, {}
        self.touch(user)
        return user

    def session_for(self, email):
        account = self.accounts[email]
        access, refresh = secrets.token_hex(16), secrets.token_hex(16)
        expires = self.clock() + self.token_lifetime
        self.access[access] = (account["id"], expires)
        self.refresh[refresh] = account["id"]
        return Session(user_id=account["id"], email=email, display_name=account["display_name"],
                       access_token=access, refresh_token=refresh, expires_at=expires)


class FakeAuth:
    """Supabase Auth's behaviour, over FakeSupabase."""

    def __init__(self, project):
        self.project = project

    def sign_up(self, email, password, display_name):
        p = self.project
        p.check()
        if email in p.accounts:
            raise er.AccountExistsError()
        p.new_user(email, password, display_name, confirmed=not p.confirm_email)
        return None if p.confirm_email else p.session_for(email)

    def sign_in(self, email, password):
        p = self.project
        p.check()
        account = p.accounts.get(email)
        if account is None or account["password"] != password:
            raise er.InvalidCredentialsError()
        if not account["confirmed"]:
            raise er.EmailNotConfirmedError()
        return p.session_for(email)

    def resume(self, access_token, refresh_token):
        p = self.project
        p.check()
        found = p.access.get(access_token or "")
        if found and found[1] > p.clock():
            user = found[0]
            email = p.profiles[user]["email"]
            return Session(user_id=user, email=email, display_name=p.profiles[user]["display_name"],
                           access_token=access_token, refresh_token=refresh_token or "", expires_at=found[1]), False
        user = p.refresh.pop(refresh_token or "", None)
        if user is None:
            raise er.NotSignedInError()
        return p.session_for(p.profiles[user]["email"]), True

    def sign_out(self, session):
        self.project.access.pop(session.access_token, None)
        self.project.refresh.pop(session.refresh_token, None)


class FakeRepository:
    """repository.SupabaseRepository's methods, over FakeSupabase, as one user.

    Like row level security, it only ever touches the rows of the session's
    own user.
    """

    def __init__(self, project, session):
        self.p = project
        self.user = session.user_id

    def _log(self, what):
        self.p.check()
        self.p.calls.append((self.user, what))

    def months(self):
        self._log("months")
        return sorted(self.p.months[self.user])

    def has_month(self, year, month):
        self._log("has_month")
        return (year, month) in self.p.months[self.user]

    def add_month(self, year, month):
        self._log("add_month")
        with self.p.lock:
            if (year, month) in self.p.months[self.user]:
                raise er.MonthExistsError("That month already exists.")
            self.p.months[self.user].add((year, month))
            self.p.touch(self.user)

    def remove_month(self, year, month):
        self._log("remove_month")
        with self.p.lock:
            if (year, month) not in self.p.months[self.user]:
                return False
            self.p.months[self.user].discard((year, month))
            prefix = f"{year:04d}-{month:02d}-"
            for table in (self.p.days, self.p.sundays):        # the cascade
                for key in [key for key in table[self.user] if key.startswith(prefix)]:
                    del table[self.user][key]
            self.p.touch(self.user)
            return True

    def days(self, first, last):
        self._log(("days", first.isoformat(), last.isoformat()))
        return [dict(row) for key, row in sorted(self.p.days[self.user].items()) if first.isoformat() <= key <= last.isoformat()]

    def measurements(self, first, last):
        self._log(("measurements", first.isoformat(), last.isoformat()))
        return [dict(row) for key, row in sorted(self.p.sundays[self.user].items()) if first.isoformat() <= key <= last.isoformat()]

    def save_day(self, when, columns):
        return self._save(self.p.days, when, columns, ("exercise_status", "junk_food_status", "cardio_seconds",
                                                        "calories", "protein", "weight_lifted"))

    def save_measurement(self, when, columns):
        if when.weekday() != 6:
            raise er.ServiceUnavailableError()      # the database's check refuses it
        return self._save(self.p.sundays, when, columns, ("weight", "waist", "chest", "bicep", "thigh", "forearm"))

    def _save(self, table, when, columns, names):
        self._log(("save", when.isoformat()))
        with self.p.lock:
            if (when.year, when.month) not in self.p.months[self.user]:
                raise er.MonthNotFoundError("That month does not exist.")
            row = table[self.user].setdefault(when.isoformat(), {"date": when.isoformat(), **{name: None for name in names}})
            row.update(columns)
            self.p.touch(self.user)
            return dict(row)

    def last_change(self):
        self._log("last_change")
        return self.p.profiles[self.user]["changed_at"]


def cloud_app(project=None, today=None):
    """(app, project): the API over the Supabase store with a stand-in project."""
    project = project or FakeSupabase()
    app = create_app(store_factory=lambda session: SupabaseStore(FakeRepository(project, session)),
                     auth=FakeAuth(project), today=today)
    return app, project


def sign_in(client, project, email, password="correct-horse-1"):
    """Sign a test client in through the real login route; returns the response."""
    return client.post("/api/auth/login", json={"email": email, "password": password})


def fill_month(project, user, year, month, days=None, sundays=None):
    """Give a user a month, with rows as the database would hold them."""
    project.months[user].add((year, month))
    for when, row in (days or {}).items():
        project.days[user][when] = {"date": when, "exercise_status": None, "junk_food_status": None,
                                    "cardio_seconds": None, "calories": None, "protein": None,
                                    "weight_lifted": None, **row}
    for when, row in (sundays or {}).items():
        project.sundays[user][when] = {"date": when, "weight": None, "waist": None, "chest": None,
                                       "bicep": None, "thigh": None, "forearm": None, **row}
    project.touch(user)


TODAY = date(2026, 10, 20)
