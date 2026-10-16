"""The tracker's data for one signed-in user, kept in Supabase.

The same methods, the same checks and the same answers as the workbook store
(store.py), so the API and the page work the same whichever is behind them:
a month is every one of its days and Sundays, blank where nothing is entered;
saving changes only the fields sent; nothing after today can be edited;
measurements go on Sundays; the last month cannot be deleted.

Business rules live here and in validation.py and errors.py. How rows are read
and written lives in repository.py.
"""

from backend import validation
from backend.errors import (
    LastMonthError, MonthNotFoundError, checked_update, validate_month,
)
from backend.months import format_cardio, month_dates, month_label, month_summary, month_sundays

# Field the API takes -> column in the database.
DAY_COLUMN = {
    "exercise": "exercise_status",
    "junk_food": "junk_food_status",
    "cardio": "cardio_seconds",
    "calories_kcal": "calories",
    "protein_g": "protein",
    "weight_lifted_kg": "weight_lifted",
}
MEASUREMENT_COLUMN = {
    "weight_kg": "weight",
    "waist_cm": "waist",
    "chest_cm": "chest",
    "bicep_cm": "bicep",
    "thigh_cm": "thigh",
    "forearm_cm": "forearm",
}


def _number(value):
    """A number as the workbook store gives it: 2450, not 2450.0; 140.5 stays 140.5."""
    if value is None:
        return None
    value = float(value)
    return int(value) if value == int(value) else value


def day_record(when, row):
    """One day in the API's shape, from its row (or no row: nothing entered)."""
    row = row or {}
    seconds = row.get("cardio_seconds")
    return {
        "date": when.isoformat(),
        "exercise": row.get("exercise_status"),
        "junk_food": row.get("junk_food_status"),
        "cardio_display": None if seconds is None else format_cardio(seconds),
        "cardio_seconds": seconds,
        "calories_kcal": _number(row.get("calories")),
        "protein_g": _number(row.get("protein")),
        "weight_lifted_kg": _number(row.get("weight_lifted")),
    }


def measurement_record(when, row):
    row = row or {}
    record = {"sunday": when.isoformat()}
    for field, column in MEASUREMENT_COLUMN.items():
        record[field] = _number(row.get(column))
    return record


class SupabaseStore:
    def __init__(self, repository):
        self.repo = repository

    def status(self):
        """When anything of this user's last changed. Nothing is ever locked here."""
        return {"modified": self.repo.last_change(), "locked": False, "unsaved_changes": False}

    def list_months(self):
        return [month_summary(year, month) for year, month in self.repo.months()]

    def get_month(self, year, month):
        validate_month(year, month)
        if not self.repo.has_month(year, month):
            raise MonthNotFoundError(f"{month_label(year, month)} does not exist.")
        dates = month_dates(year, month)
        days = {row["date"]: row for row in self.repo.days(dates[0], dates[-1])}
        sundays = {row["date"]: row for row in self.repo.measurements(dates[0], dates[-1])}
        result = month_summary(year, month)
        result.update(
            days=[day_record(day, days.get(day.isoformat())) for day in dates],
            measurements=[measurement_record(day, sundays.get(day.isoformat())) for day in month_sundays(year, month)],
            issues=[],          # the database only holds values that passed validation
        )
        return result

    def update_day(self, year, month, day, fields, today=None):
        return self._update(year, month, day, fields, today, sunday=False)

    def update_measurements(self, year, month, day, fields, today=None):
        return self._update(year, month, day, fields, today, sunday=True)

    def _update(self, year, month, day, fields, today, sunday):
        validate_month(year, month)
        when, values = checked_update(year, month, day, fields, today, sunday)
        if not self.repo.has_month(year, month):
            raise MonthNotFoundError(f"{month_label(year, month)} does not exist.")
        if sunday:
            columns = {MEASUREMENT_COLUMN[field]: value for field, value in values.items()}
            row = self.repo.save_measurement(when, columns)
            record = measurement_record(when, row)
        else:
            columns = {DAY_COLUMN[field]: (validation.cardio_seconds(value) if field == "cardio" else value)
                       for field, value in values.items()}
            row = self.repo.save_day(when, columns)
            record = day_record(when, row)
        result = month_summary(year, month)
        result["measurement" if sunday else "day"] = record
        result["modified"] = self.repo.last_change()
        return result

    def create_month(self, year, month):
        validate_month(year, month)
        self.repo.add_month(year, month)
        return self.get_month(year, month)

    def delete_month(self, year, month):
        """Delete a month with everything entered in it. The last month is never deleted."""
        validate_month(year, month)
        kept = self.repo.months()
        name = month_label(year, month)
        if (year, month) not in kept:
            raise MonthNotFoundError(f"{name} does not exist.")
        if len(kept) <= 1:
            raise LastMonthError(f"{name} is the only month you keep, so it cannot be deleted. Add another month first.")
        if not self.repo.remove_month(year, month):
            raise MonthNotFoundError(f"{name} does not exist.")
        return {
            "deleted": month_summary(year, month),
            "months": [month_summary(*found) for found in self.repo.months()],
        }
