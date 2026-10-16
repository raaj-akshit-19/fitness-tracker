"""Reading and writing one user's rows in Supabase's PostgreSQL, through its REST layer.

Every request is made with the signed-in user's own access token, so the
database's row level security decides what the request may touch: even a
mistake here could not reach another user's rows. On top of that, every query
names the user it is for, and every row written carries that user, both taken
from the verified session and never from the browser.

Only the rows a request needs are read: one month's days and Sundays, the
user's list of months, or the time of their last change.
"""

from urllib.parse import quote

from backend import supabase_http
from backend.errors import MonthExistsError, MonthNotFoundError, NotSignedInError, ServiceUnavailableError

DAY_COLUMNS = ("date", "exercise_status", "junk_food_status", "cardio_seconds", "calories", "protein", "weight_lifted")
MEASUREMENT_COLUMNS = ("date", "weight", "waist", "chest", "bicep", "thigh", "forearm")


class SupabaseRepository:
    def __init__(self, supabase_url, anon_key, session):
        self.base = f"{supabase_url.rstrip('/')}/rest/v1"
        self.anon_key = anon_key
        self.session = session
        self.user = quote(session.user_id, safe="")

    def _call(self, method, path, body=None, prefer=None):
        headers = {"apikey": self.anon_key, "Authorization": f"Bearer {self.session.access_token}"}
        if prefer:
            headers["Prefer"] = prefer
        answer = supabase_http.call(method, f"{self.base}/{path}", headers, body)
        if answer.status == 401:
            # The token was refused: it ran out a moment ago, or the account went away.
            raise NotSignedInError("Your session has ended. Sign in again.")
        return answer

    def _rows(self, path):
        answer = self._call("GET", path)
        if not answer.ok or not isinstance(answer.body, list):
            raise ServiceUnavailableError()
        return answer.body

    # ------------------------------------------------------------ months

    def months(self):
        """[(year, month)] of every month the user keeps, in calendar order."""
        rows = self._rows(f"months?select=year,month&user_id=eq.{self.user}&order=year.asc,month.asc")
        return [(row["year"], row["month"]) for row in rows]

    def has_month(self, year, month):
        return bool(self._rows(f"months?select=id&user_id=eq.{self.user}&year=eq.{int(year)}&month=eq.{int(month)}"))

    def add_month(self, year, month):
        answer = self._call("POST", "months", {"user_id": self.session.user_id, "year": int(year), "month": int(month)},
                            prefer="return=minimal")
        if answer.status == 409 or answer.error_code() == "23505":
            raise MonthExistsError("That month already exists.")
        if not answer.ok:
            raise ServiceUnavailableError()

    def remove_month(self, year, month):
        """Delete the month; its days and Sundays go with it (the database cascades). True if it was there."""
        answer = self._call("DELETE", f"months?user_id=eq.{self.user}&year=eq.{int(year)}&month=eq.{int(month)}",
                            prefer="return=representation")
        if not answer.ok:
            raise ServiceUnavailableError()
        return bool(answer.body)

    # ------------------------------------------------------------ days and Sundays

    def days(self, first, last):
        """The rows for days between two dates, inclusive. A day with nothing entered has no row."""
        return self._rows(f"daily_logs?select={','.join(DAY_COLUMNS)}&user_id=eq.{self.user}"
                          f"&date=gte.{first.isoformat()}&date=lte.{last.isoformat()}&order=date.asc")

    def measurements(self, first, last):
        return self._rows(f"measurements?select={','.join(MEASUREMENT_COLUMNS)}&user_id=eq.{self.user}"
                          f"&date=gte.{first.isoformat()}&date=lte.{last.isoformat()}&order=date.asc")

    def save_day(self, when, columns):
        """Set some columns of one day's row (making the row if there is none). Returns the row."""
        return self._save("daily_logs", DAY_COLUMNS, when, columns)

    def save_measurement(self, when, columns):
        return self._save("measurements", MEASUREMENT_COLUMNS, when, columns)

    def _save(self, table, columns_wanted, when, columns):
        row = {"user_id": self.session.user_id, "date": when.isoformat(), **columns}
        # Only the columns given are written; the others keep what they hold.
        answer = self._call("POST", f"{table}?on_conflict=user_id,date&select={','.join(columns_wanted)}", row,
                            prefer="resolution=merge-duplicates,return=representation")
        if answer.status == 409 and answer.error_code() == "23503":
            raise MonthNotFoundError("That month does not exist.")
        if not answer.ok or not answer.body:
            raise ServiceUnavailableError()
        return answer.body[0]

    # ------------------------------------------------------------ changes

    def last_change(self):
        """When anything of the user's last changed (added, changed or deleted), as an ISO time."""
        rows = self._rows(f"profiles?select=changed_at&id=eq.{self.user}")
        if not rows:
            raise ServiceUnavailableError()
        return rows[0]["changed_at"]
