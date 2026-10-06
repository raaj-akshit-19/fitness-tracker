"""Analytics for one month.

Everything here is a pure function of one month's data, in the shape returned
by TrackerStore.get_month, and of today's date. Nothing reads the workbook,
another month, or the clock, and nothing is changed, so the same inputs always
give the same result.

Rules:
  - Exercise on each day is completed, partial, rest_day, missed or pending:
      past day    the status in the cell; a blank cell is missed
      today       the status in the cell; a blank cell is pending
      future day  pending, whatever the cell holds
    Completed earns 1 credit, Partial half, Missed none. A rest day is left out
    of the percentage altogether. Pending is left out of everything.
        completion % = credits / (completed + partial + missed) * 100
    The streak counts Completed days in a row. A rest day neither adds to it
    nor breaks it; Partial and Missed break it.
  - Junk Food on each day is none, controlled, had, missed or pending, where
    missed is a past day left blank. None earns 1 credit, Controlled half,
    Had none.
        success % = credits / (none + controlled + had) * 100
    so only days with an entry count towards it. The clean streak counts None
    days in a row; Controlled, Had and a past blank all break it.
  - Calories, protein, cardio and weight lifted are summed and averaged over
    the days that have an entry. A blank is no entry and is never counted as
    zero; a recorded zero is an entry. With no entries the figures are None.
  - Weeks run Monday to Sunday and are cut at the month's edges.
  - Streaks and "previous Sunday" never reach outside the month.
  - There are no targets: nothing here compares a value with a goal.
"""

from datetime import date

from backend import validation
from backend.workbook import format_cardio

MEASUREMENTS = ("weight_kg", "waist_cm", "chest_cm", "bicep_cm", "thigh_cm", "forearm_cm")

COMPLETED = "completed"
PARTIAL = "partial"
REST_DAY = "rest_day"
MISSED = "missed"
PENDING = "pending"
NONE = "none"
CONTROLLED = "controlled"
HAD = "had"

EXERCISE_STATUS = {
    validation.EXERCISE_COMPLETED: COMPLETED,
    validation.EXERCISE_PARTIAL: PARTIAL,
    validation.EXERCISE_REST_DAY: REST_DAY,
    validation.EXERCISE_MISSED: MISSED,
}
JUNK_FOOD_STATUS = {
    validation.JUNK_FOOD_NONE: NONE,
    validation.JUNK_FOOD_CONTROLLED: CONTROLLED,
    validation.JUNK_FOOD_HAD: HAD,
}
EXERCISE_COUNTS = (COMPLETED, PARTIAL, REST_DAY, MISSED, PENDING)
JUNK_FOOD_COUNTS = (NONE, CONTROLLED, HAD, MISSED, PENDING)

# Credit by status. None means the day is not part of the percentage.
EXERCISE_CREDIT = {COMPLETED: 1.0, PARTIAL: 0.5, MISSED: 0.0, REST_DAY: None, PENDING: None}
JUNK_FOOD_CREDIT = {NONE: 1.0, CONTROLLED: 0.5, HAD: 0.0, MISSED: None, PENDING: None}


def month_analytics(data, today):
    days = []
    for record in data["days"]:
        on = date.fromisoformat(record["date"])
        days.append(dict(
            record, on=on,
            exercise_status=day_status(record["exercise"], on, today, EXERCISE_STATUS),
            junk_food_status=day_status(record["junk_food"], on, today, JUNK_FOOD_STATUS),
        ))
    weeks = split_weeks(days)
    pending_days = sum(1 for day in days if PENDING in (day["exercise_status"], day["junk_food_status"]))

    return {
        "month": {
            "year": data["year"],
            "month": data["month"],
            "label": data["label"],
            "days_in_month": len(days),
            "due_days": len(days) - pending_days,
            "pending_days": pending_days,
            "today": today.isoformat(),
        },
        "exercise": {**exercise_counts(days), **exercise_streaks(days)},
        "junk_food": {**junk_food_counts(days), **junk_food_streaks(days)},
        "daily": [daily_entry(day) for day in days],
        "weekly": [weekly_entry(number, week) for number, week in enumerate(weeks, start=1)],
        "cardio": cardio_summary(days),
        "weight_lifted": number_summary(days, "weight_lifted_kg", "kg"),
        "calories": number_summary(days, "calories_kcal", "kcal"),
        "protein": number_summary(days, "protein_g", "g"),
        "measurements": {
            field: measurement_summary(data["measurements"], field) for field in MEASUREMENTS
        },
        "issues": data["issues"],
    }


def day_status(value, on, today, statuses):
    """Classify one status cell. value is the stored status, or None for not entered."""
    if on > today:
        return PENDING
    if value is None:
        return PENDING if on == today else MISSED
    return statuses[value]


def exercise_counts(days):
    statuses = [day["exercise_status"] for day in days]
    counts = {status: statuses.count(status) for status in EXERCISE_COUNTS}
    eligible = counts[COMPLETED] + counts[PARTIAL] + counts[MISSED]
    credits = counts[COMPLETED] + 0.5 * counts[PARTIAL]
    return {
        "counts": counts,
        # How many of the missed days were left blank, not recorded as Missed.
        "missed_not_entered": sum(
            1 for day in days if day["exercise_status"] == MISSED and day["exercise"] is None
        ),
        "eligible_days": eligible,
        "credits": credits,
        "completion_percentage": percentage(credits, eligible),
    }


def exercise_streaks(days):
    """Completed days in a row. Rest days and pending days are stepped over."""
    flags = [day["exercise_status"] == COMPLETED for day in days
             if day["exercise_status"] not in (REST_DAY, PENDING)]
    current, longest = streaks(flags)
    return {"current_streak": current, "longest_streak": longest}


def junk_food_counts(days):
    statuses = [day["junk_food_status"] for day in days]
    counts = {status: statuses.count(status) for status in JUNK_FOOD_COUNTS}
    eligible = counts[NONE] + counts[CONTROLLED] + counts[HAD]
    credits = counts[NONE] + 0.5 * counts[CONTROLLED]
    return {
        "counts": counts,
        "eligible_days": eligible,
        "credits": credits,
        "success_percentage": percentage(credits, eligible),
    }


def junk_food_streaks(days):
    """None days in a row. Only pending days are stepped over."""
    flags = [day["junk_food_status"] == NONE for day in days if day["junk_food_status"] != PENDING]
    current, longest = streaks(flags)
    return {"current_streak": current, "longest_streak": longest}


def daily_entry(day):
    """One day: what the workbook holds, and how the two statuses were read."""
    return {
        "date": day["date"],
        "exercise": day["exercise"],
        "exercise_status": day["exercise_status"],
        "exercise_credit": EXERCISE_CREDIT[day["exercise_status"]],
        "junk_food": day["junk_food"],
        "junk_food_status": day["junk_food_status"],
        "junk_food_credit": JUNK_FOOD_CREDIT[day["junk_food_status"]],
        "cardio_seconds": day["cardio_seconds"],
        "cardio_display": _display(day["cardio_seconds"]),
        "calories_kcal": day["calories_kcal"],
        "protein_g": day["protein_g"],
        "weight_lifted_kg": day["weight_lifted_kg"],
    }


def weekly_entry(number, week):
    exercise = exercise_counts(week)
    junk_food = junk_food_counts(week)
    cardio = cardio_summary(week)
    weight = number_summary(week, "weight_lifted_kg", "kg")
    return {
        "week": number,
        "start": week[0]["date"],
        "end": week[-1]["date"],
        "days": len(week),
        "due_days": sum(1 for day in week
                        if PENDING not in (day["exercise_status"], day["junk_food_status"])),
        "exercise": {**exercise["counts"], "completion_percentage": exercise["completion_percentage"]},
        "junk_food": {**junk_food["counts"], "success_percentage": junk_food["success_percentage"]},
        "cardio": {key: cardio[key] for key in ("days_recorded", "total_seconds", "total_display")},
        "weight_lifted": {key: weight[key] for key in ("days_recorded", "total_kg", "average_kg")},
        "calories": _without_dates(number_summary(week, "calories_kcal", "kcal")),
        "protein": _without_dates(number_summary(week, "protein_g", "g")),
    }


def cardio_summary(days):
    entries = [day for day in days if day["cardio_seconds"] is not None]
    if not entries:
        return {"days_recorded": 0, "total_seconds": None, "total_display": None,
                "average_seconds": None, "average_display": None,
                "longest_seconds": None, "longest_display": None, "longest_date": None}
    total = sum(day["cardio_seconds"] for day in entries)
    average = int(total / len(entries) + 0.5)
    longest = max(entries, key=lambda day: day["cardio_seconds"])
    return {
        "days_recorded": len(entries),
        "total_seconds": total,
        "total_display": format_cardio(total),
        "average_seconds": average,
        "average_display": format_cardio(average),
        "longest_seconds": longest["cardio_seconds"],
        "longest_display": format_cardio(longest["cardio_seconds"]),
        "longest_date": longest["date"],
    }


def number_summary(days, field, unit):
    """Total, average, highest and lowest of one numeric field over the days that have an entry."""
    entries = [day for day in days if day[field] is not None]
    if not entries:
        return {"days_recorded": 0, f"total_{unit}": None, f"average_{unit}": None,
                f"highest_{unit}": None, "highest_date": None,
                f"lowest_{unit}": None, "lowest_date": None}
    total = sum(day[field] for day in entries)
    highest = max(entries, key=lambda day: day[field])      # the earliest day, when several tie
    lowest = min(entries, key=lambda day: day[field])
    return {
        "days_recorded": len(entries),
        f"total_{unit}": _tidy(total),
        f"average_{unit}": _tidy(total / len(entries)),
        f"highest_{unit}": highest[field],
        "highest_date": highest["date"],
        f"lowest_{unit}": lowest[field],
        "lowest_date": lowest["date"],
    }


def _without_dates(summary):
    return {key: value for key, value in summary.items() if not key.endswith("_date")}


def _tidy(value):
    """Two decimal places at most, and a whole number shown as one."""
    value = round(value, 2)
    return int(value) if value == int(value) else value


def _display(seconds):
    return None if seconds is None else format_cardio(seconds)


# ---------------------------------------------------------------- shared arithmetic

def split_weeks(days):
    """Group a month's days into Monday to Sunday weeks, in order."""
    weeks = []
    for day in days:
        if not weeks or day["on"].weekday() == 0:
            weeks.append([])
        weeks[-1].append(day)
    return weeks

def percentage(part, whole):
    return None if whole == 0 else round(100 * part / whole, 2)

def streaks(flags):
    """Return (current, longest) run of True in a chronological list of counted days."""
    longest = run = 0
    for flag in flags:
        run = run + 1 if flag else 0
        longest = max(longest, run)
    return run, longest

def measurement_summary(rows, field):
    """Latest recorded value compared with the Sunday immediately before it."""
    trend = [{"date": row["sunday"], "value": row[field]} for row in rows]
    result = {
        "current": None, "current_date": None,
        "previous": None, "previous_date": None,
        "change": None, "change_percentage": None,
        "trend": trend,
    }
    recorded = [index for index, point in enumerate(trend) if point["value"] is not None]
    if not recorded:
        return result
    index = recorded[-1]
    result["current"] = trend[index]["value"]
    result["current_date"] = trend[index]["date"]
    if index > 0:
        previous = trend[index - 1]
        result["previous"] = previous["value"]
        result["previous_date"] = previous["date"]
        if previous["value"] is not None:
            change = result["current"] - previous["value"]
            result["change"] = round(change, 2)
            result["change_percentage"] = round(100 * change / previous["value"], 2)
    return result
