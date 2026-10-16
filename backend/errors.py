"""What can go wrong, as the API reports it, and the checks every store shares.

Each error has a code the page understands. The HTTP status for each code is
in app.py. Messages are written for the person using Raft: they never carry
database details, tokens or anything else from inside.
"""

from backend import validation
from backend.months import month_label

MIN_YEAR = validation.MIN_YEAR
MAX_YEAR = validation.MAX_YEAR


class TrackerError(Exception):
    code = "tracker_error"


class InvalidMonthError(TrackerError):
    code = "invalid_month"


class MonthNotFoundError(TrackerError):
    code = "month_not_found"


class MonthExistsError(TrackerError):
    code = "month_exists"


class LastMonthError(TrackerError):
    code = "last_month"


class DayNotFoundError(TrackerError):
    code = "day_not_found"


class InvalidUpdateError(TrackerError):
    """Values that may not be stored. `fields` maps each one to what is wrong with it."""
    code = "invalid_request"

    def __init__(self, fields):
        super().__init__(" ".join(fields.values()))
        self.fields = dict(fields)


# ---------------------------------------------------------------- accounts

class NotSignedInError(TrackerError):
    code = "not_signed_in"

    def __init__(self, message="Sign in to see your tracker."):
        super().__init__(message)


class InvalidCredentialsError(TrackerError):
    code = "invalid_credentials"

    def __init__(self, message="That email and password do not match an account."):
        super().__init__(message)


class EmailNotConfirmedError(TrackerError):
    code = "email_not_confirmed"

    def __init__(self, message="Confirm your email address first: open the link in the email we sent, then sign in."):
        super().__init__(message)


class AccountExistsError(TrackerError):
    code = "account_exists"

    def __init__(self, message="There is already an account with that email. Sign in instead."):
        super().__init__(message)


class TooManyRequestsError(TrackerError):
    code = "too_many_requests"

    def __init__(self, message="Too many attempts. Wait a minute, then try again."):
        super().__init__(message)


class ServiceUnavailableError(TrackerError):
    code = "service_unavailable"

    def __init__(self, message="Raft cannot reach its database right now. Nothing was saved. Try again in a moment."):
        super().__init__(message)


# ---------------------------------------------------------------- shared checks

def validate_month(year, month):
    for name, value in (("year", year), ("month", month)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise InvalidMonthError(f"{name} must be a whole number.")
    if not MIN_YEAR <= year <= MAX_YEAR:
        raise InvalidMonthError(f"year must be between {MIN_YEAR} and {MAX_YEAR}.")
    if not 1 <= month <= 12:
        raise InvalidMonthError("month must be between 1 and 12.")


def checked_update(year, month, day, fields, today, sunday):
    """The date and the values in stored form, or InvalidUpdateError listing everything wrong.

    The same rules whatever the storage: the day must exist, measurements go on
    Sundays, nothing after today can be edited, and every value is checked by
    validation.py.
    """
    try:
        when = validation.validate_day(year, month, day)
    except validation.ValidationError as error:
        raise DayNotFoundError(f"{month_label(year, month)} has no day {day}.") from error
    errors = {}
    if sunday and when.weekday() != 6:
        errors["day"] = f"{when:%d %B %Y} is not a Sunday. Measurements go on Sundays."
    elif when > today:
        errors["day"] = ("A Sunday in the future cannot be edited yet." if sunday
                         else "A day in the future cannot be edited yet.")
    check = validation.validate_measurement_update if sunday else validation.validate_daily_update
    values = {}
    try:
        values = check(fields)
    except validation.ValidationError as error:
        errors.update(error.errors)
    if errors:
        raise InvalidUpdateError(errors)
    return when, values
