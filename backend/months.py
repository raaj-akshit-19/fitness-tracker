"""Months and days: names, dates and the cardio display. No storage involved.

Shared by the database store and the workbook format, so that both name a
month and lay out its days in exactly the same way.
"""

import calendar
from datetime import date

# English names are fixed here so month names never depend on the OS locale.
MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def month_label(year, month):
    """"October 2026": how a month is named everywhere."""
    return f"{MONTH_NAMES[month - 1]} {year}"


def month_summary(year, month):
    return {"year": year, "month": month, "label": month_label(year, month)}


def month_dates(year, month):
    days = calendar.monthrange(year, month)[1]
    return [date(year, month, day) for day in range(1, days + 1)]


def month_sundays(year, month):
    return [d for d in month_dates(year, month) if d.weekday() == calendar.SUNDAY]


def format_cardio(total_seconds):
    minutes, seconds = divmod(int(total_seconds), 60)
    return f"{minutes}:{seconds:02d}"
