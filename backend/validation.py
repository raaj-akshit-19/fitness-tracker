"""Field definitions and validation.

The single place that says what each field may hold. The workbook builder
takes its limits and lists from here, and everything that accepts a value from
outside (a request, a cell someone typed into) checks it here.

Every validate_* function returns the value in its stored form, or None for
"not entered", and raises ValidationError otherwise. Nothing is guessed or
silently corrected: 25.30 is not accepted as 25:30, and "yes" is not accepted
as Completed.
"""

import calendar
import math
import re
from datetime import date

# ---------------------------------------------------------------- statuses

EXERCISE_COMPLETED = "Completed"
EXERCISE_PARTIAL = "Partial"
EXERCISE_REST_DAY = "Rest Day"
EXERCISE_MISSED = "Missed"
EXERCISE_STATUSES = (EXERCISE_COMPLETED, EXERCISE_PARTIAL, EXERCISE_REST_DAY, EXERCISE_MISSED)

JUNK_FOOD_NONE = "None"            # the text "None": no junk food was eaten
JUNK_FOOD_CONTROLLED = "Controlled"
JUNK_FOOD_HAD = "Had"
JUNK_FOOD_STATUSES = (JUNK_FOOD_NONE, JUNK_FOOD_CONTROLLED, JUNK_FOOD_HAD)

# Credit each status earns towards completion. A rest day earns nothing and is
# left out of the count altogether, which is what None means here.
EXERCISE_CREDIT = {
    EXERCISE_COMPLETED: 1.0,
    EXERCISE_PARTIAL: 0.5,
    EXERCISE_REST_DAY: None,
    EXERCISE_MISSED: 0.0,
}
JUNK_FOOD_CREDIT = {
    JUNK_FOOD_NONE: 1.0,
    JUNK_FOOD_CONTROLLED: 0.5,
    JUNK_FOOD_HAD: 0.0,
}

# ---------------------------------------------------------------- limits

CARDIO_MAX_MINUTES = 999
CALORIES_MAX = 20_000          # kcal, whole numbers
PROTEIN_MAX = 1_000            # g
WEIGHT_LIFTED_MAX = 100_000    # kg, the day's total
MEASUREMENT_MAX = 500          # kg or cm; must be more than zero
DECIMAL_PLACES = 1             # for protein, weight lifted and measurements

MIN_YEAR = 2000
MAX_YEAR = 2100

DAILY_FIELDS = ("exercise", "junk_food", "cardio", "calories_kcal", "protein_g", "weight_lifted_kg")
MEASUREMENT_FIELDS = ("weight_kg", "waist_cm", "chest_cm", "bicep_cm", "thigh_cm", "forearm_cm")

_CARDIO = re.compile(r"^(\d{1,3}):([0-5]\d)$")


class ValidationError(ValueError):
    """A value that may not be stored. `errors` maps each field to what is wrong."""

    def __init__(self, field, message, errors=None):
        super().__init__(message)
        self.field = field
        self.message = message
        self.errors = errors if errors is not None else {field: message}


# ---------------------------------------------------------------- single fields

def _blank(value):
    return value is None or (isinstance(value, str) and value.strip() == "")


def _status(value, allowed, field, label):
    if _blank(value):
        return None
    if isinstance(value, str):
        wanted = " ".join(value.split()).casefold()
        for status in allowed:
            if status.casefold() == wanted:
                return status
    raise ValidationError(field, f"{label} must be one of: {', '.join(allowed)}; or left blank.")


def validate_exercise(value):
    return _status(value, EXERCISE_STATUSES, "exercise", "Exercise")


def validate_junk_food(value):
    return _status(value, JUNK_FOOD_STATUSES, "junk_food", "Junk Food")


def validate_cardio(value):
    """A duration typed as min:sec. Returned as text with the minutes not padded."""
    if _blank(value):
        return None
    if isinstance(value, str):
        match = _CARDIO.match(value.strip())
        if match:
            return f"{int(match.group(1))}:{match.group(2)}"
    raise ValidationError(
        "cardio",
        f"Cardio must be minutes and seconds as min:sec, for example 25:30 "
        f"(up to {CARDIO_MAX_MINUTES} minutes, seconds 00 to 59).",
    )


def cardio_seconds(text):
    """Total seconds of an already validated cardio value. None stays None."""
    if text is None:
        return None
    minutes, seconds = text.split(":")
    return int(minutes) * 60 + int(seconds)


def _number(value, field, label, low, high, unit, whole=False, above_zero=False):
    if _blank(value):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValidationError(field, f"{label} must be a number.")
    if above_zero and value <= 0:
        raise ValidationError(field, f"{label} must be more than 0.")
    if value < low or value > high:
        raise ValidationError(field, f"{label} must be between {low:,} and {high:,} {unit}.")
    if whole:
        if value != int(value):
            raise ValidationError(field, f"{label} must be a whole number.")
        return int(value)
    rounded = round(value, DECIMAL_PLACES)
    if abs(rounded - value) > 1e-9:
        raise ValidationError(field, f"{label} can have at most {DECIMAL_PLACES} decimal place.")
    return int(rounded) if rounded == int(rounded) else rounded


def validate_calories(value):
    return _number(value, "calories_kcal", "Calories", 0, CALORIES_MAX, "kcal", whole=True)


def validate_protein(value):
    return _number(value, "protein_g", "Protein", 0, PROTEIN_MAX, "g")


def validate_weight_lifted(value):
    return _number(value, "weight_lifted_kg", "Weight Lifted", 0, WEIGHT_LIFTED_MAX, "kg")


def validate_measurement(value, field="measurement"):
    if field not in MEASUREMENT_FIELDS and field != "measurement":
        raise ValidationError(field, f"{field} is not a measurement.")
    label = field.split("_")[0].capitalize() if field != "measurement" else "The measurement"
    unit = "kg" if field == "weight_kg" else "cm" if field != "measurement" else "kg or cm"
    return _number(value, field, label, 0, MEASUREMENT_MAX, unit, above_zero=True)


# ---------------------------------------------------------------- dates

def _whole(value, field):
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(field, f"{field} must be a whole number.")
    return value


def validate_month(year, month):
    """Return (year, month) for a month the tracker can hold."""
    _whole(year, "year")
    _whole(month, "month")
    if not MIN_YEAR <= year <= MAX_YEAR:
        raise ValidationError("year", f"year must be between {MIN_YEAR} and {MAX_YEAR}.")
    if not 1 <= month <= 12:
        raise ValidationError("month", "month must be between 1 and 12.")
    return year, month


def validate_day(year, month, day):
    """Return the date, which must exist in that month."""
    validate_month(year, month)
    _whole(day, "day")
    last = calendar.monthrange(year, month)[1]
    if not 1 <= day <= last:
        raise ValidationError("day", f"day must be between 1 and {last} for that month.")
    return date(year, month, day)


def validate_editable_day(year, month, day, today):
    """Return the date of a daily row that may be edited: today or earlier."""
    when = validate_day(year, month, day)
    if when > today:
        raise ValidationError("day", "A day in the future cannot be edited yet.")
    return when


def validate_sunday(year, month, day):
    """Return the date of a measurement row. Measurements are only taken on Sundays."""
    when = validate_day(year, month, day)
    if when.weekday() != calendar.SUNDAY:
        raise ValidationError("day", f"{when:%d %B %Y} is not a Sunday. Measurements go on Sundays.")
    return when


# ---------------------------------------------------------------- whole updates

_DAILY_VALIDATORS = {
    "exercise": validate_exercise,
    "junk_food": validate_junk_food,
    "cardio": validate_cardio,
    "calories_kcal": validate_calories,
    "protein_g": validate_protein,
    "weight_lifted_kg": validate_weight_lifted,
}


def _validate_update(values, validators, what):
    """Check every given field. All of them must pass, or none is accepted."""
    if not isinstance(values, dict):
        raise ValidationError("body", f"Send the {what} fields as a JSON object.")
    if not values:
        raise ValidationError("body", "Nothing to change was sent.")
    clean, errors = {}, {}
    for field, value in values.items():
        validator = validators.get(field)
        if validator is None:
            errors[field] = f"{field} is not a {what} field."
            continue
        try:
            clean[field] = validator(value)
        except ValidationError as error:
            errors[field] = error.message
    if errors:
        first = next(iter(errors))
        raise ValidationError(first, errors[first], errors)
    return clean


def validate_daily_update(values):
    """Validate a set of daily fields. Returns them in stored form; None clears a field."""
    return _validate_update(values, _DAILY_VALIDATORS, "daily")


def validate_measurement_update(values):
    """Validate a set of Sunday measurements. Returns them in stored form; None clears one."""
    validators = {field: (lambda value, field=field: validate_measurement(value, field))
                  for field in MEASUREMENT_FIELDS}
    return _validate_update(values, validators, "measurement")
