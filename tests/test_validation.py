"""Checks for the field rules in backend/validation.py.

Run from the project root:  python -m unittest discover -s tests -v
"""

import unittest
from datetime import date

from backend import validation as v


def message(call, *args):
    try:
        call(*args)
    except v.ValidationError as error:
        return error
    raise AssertionError(f"{call.__name__}{args} was accepted")


class StatusTests(unittest.TestCase):
    def test_the_lists_are_exactly_the_agreed_ones(self):
        self.assertEqual(v.EXERCISE_STATUSES, ("Completed", "Partial", "Rest Day", "Missed"))
        self.assertEqual(v.JUNK_FOOD_STATUSES, ("None", "Controlled", "Had"))

    def test_credit_for_each_status(self):
        self.assertEqual(v.EXERCISE_CREDIT, {"Completed": 1.0, "Partial": 0.5, "Rest Day": None, "Missed": 0.0})
        self.assertEqual(v.JUNK_FOOD_CREDIT, {"None": 1.0, "Controlled": 0.5, "Had": 0.0})
        self.assertEqual(set(v.EXERCISE_CREDIT), set(v.EXERCISE_STATUSES))
        self.assertEqual(set(v.JUNK_FOOD_CREDIT), set(v.JUNK_FOOD_STATUSES))

    def test_every_exercise_status_is_accepted(self):
        for status in v.EXERCISE_STATUSES:
            self.assertEqual(v.validate_exercise(status), status)

    def test_every_junk_food_status_is_accepted(self):
        for status in v.JUNK_FOOD_STATUSES:
            self.assertEqual(v.validate_junk_food(status), status)

    def test_blank_means_not_entered(self):
        for blank in (None, "", "   "):
            self.assertIsNone(v.validate_exercise(blank))
            self.assertIsNone(v.validate_junk_food(blank))

    def test_the_word_none_is_a_junk_food_status_not_a_blank(self):
        self.assertEqual(v.validate_junk_food("None"), "None")
        self.assertIsNone(v.validate_junk_food(None))
        self.assertEqual(message(v.validate_exercise, "None").field, "exercise")

    def test_case_and_spacing_are_tidied_to_the_stored_spelling(self):
        self.assertEqual(v.validate_exercise("  rest   day "), "Rest Day")
        self.assertEqual(v.validate_exercise("COMPLETED"), "Completed")
        self.assertEqual(v.validate_junk_food("controlled"), "Controlled")

    def test_other_values_are_refused_not_guessed(self):
        for bad in ("Done", "Yes", "Complete", "Rest", "RestDay", True, False, 1, 0, 1.0, ["Completed"]):
            error = message(v.validate_exercise, bad)
            self.assertEqual(error.field, "exercise")
            self.assertIn("Completed, Partial, Rest Day, Missed", error.message)
        for bad in ("No", "Some", "Had some", "Completed", True, False, 0):
            error = message(v.validate_junk_food, bad)
            self.assertEqual(error.field, "junk_food")
            self.assertIn("None, Controlled, Had", error.message)

    def test_statuses_of_one_field_are_not_valid_for_the_other(self):
        for status in v.EXERCISE_STATUSES:
            message(v.validate_junk_food, status)
        for status in v.JUNK_FOOD_STATUSES:
            message(v.validate_exercise, status)


class CardioTests(unittest.TestCase):
    def test_min_sec_is_accepted(self):
        for text, seconds in (("25:30", 1530), ("0:45", 45), ("60:00", 3600), ("0:00", 0),
                              ("999:59", 59999), ("5:05", 305)):
            self.assertEqual(v.validate_cardio(text), text)
            self.assertEqual(v.cardio_seconds(text), seconds)

    def test_stored_form_has_unpadded_minutes(self):
        self.assertEqual(v.validate_cardio(" 05:30 "), "5:30")
        self.assertEqual(v.validate_cardio("000:07"), "0:07")

    def test_blank(self):
        for blank in (None, "", "  "):
            self.assertIsNone(v.validate_cardio(blank))
        self.assertIsNone(v.cardio_seconds(None))

    def test_anything_else_is_refused(self):
        for bad in ("25", "25:60", "25:3", "25.30", "1:2:3", "abc", "-5:00", "1000:00", "25:30 min",
                    25.30, 1530, True, "25:3o", ":30", "25:"):
            error = message(v.validate_cardio, bad)
            self.assertEqual(error.field, "cardio")
            self.assertIn("min:sec", error.message)

    def test_twenty_five_point_three_is_never_read_as_a_duration(self):
        message(v.validate_cardio, 25.3)
        message(v.validate_cardio, "25.3")


class NumberTests(unittest.TestCase):
    def test_calories_are_whole_numbers_of_kcal(self):
        for good, stored in ((0, 0), (2200, 2200), (20000, 20000), (2200.0, 2200)):
            result = v.validate_calories(good)
            self.assertEqual(result, stored)
            self.assertIs(type(result), int)
        for bad in (-1, 20001, 2200.5, "2200", True, float("nan"), float("inf"), [2200]):
            self.assertEqual(message(v.validate_calories, bad).field, "calories_kcal")
        self.assertIn("whole number", message(v.validate_calories, 2200.5).message)
        self.assertIn("between 0 and 20,000 kcal", message(v.validate_calories, 20001).message)

    def test_protein_in_grams(self):
        for good, stored in ((0, 0), (140, 140), (140.5, 140.5), (1000, 1000), (120.0, 120)):
            self.assertEqual(v.validate_protein(good), stored)
        self.assertIs(type(v.validate_protein(120.0)), int)
        for bad in (-0.1, 1000.1, 140.55, "140", False, float("nan")):
            self.assertEqual(message(v.validate_protein, bad).field, "protein_g")
        self.assertIn("at most 1 decimal place", message(v.validate_protein, 140.55).message)

    def test_weight_lifted_in_kg(self):
        for good, stored in ((0, 0), (2450, 2450), (1820.5, 1820.5), (100000, 100000)):
            self.assertEqual(v.validate_weight_lifted(good), stored)
        for bad in (-1, 100000.1, 1820.55, "2450", True, float("-inf")):
            self.assertEqual(message(v.validate_weight_lifted, bad).field, "weight_lifted_kg")

    def test_a_recorded_zero_is_kept_and_blank_is_not_zero(self):
        self.assertEqual(v.validate_calories(0), 0)
        self.assertEqual(v.validate_protein(0), 0)
        self.assertEqual(v.validate_weight_lifted(0), 0)
        for check in (v.validate_calories, v.validate_protein, v.validate_weight_lifted):
            self.assertIsNone(check(None))
            self.assertIsNone(check(""))

    def test_arithmetic_noise_is_not_mistaken_for_extra_decimals(self):
        self.assertEqual(v.validate_protein(0.1 + 0.2), 0.3)
        self.assertEqual(v.validate_weight_lifted(1820.5000000000002), 1820.5)

    def test_measurements(self):
        for field in v.MEASUREMENT_FIELDS:
            self.assertEqual(v.validate_measurement(72.5, field), 72.5)
            self.assertEqual(v.validate_measurement(84, field), 84)
            self.assertEqual(v.validate_measurement(500, field), 500)
            self.assertIsNone(v.validate_measurement(None, field))
            for bad in (0, -1, 500.1, 72.55, "72.5", True):
                self.assertEqual(message(v.validate_measurement, bad, field).field, field)
        self.assertIn("more than 0", message(v.validate_measurement, 0, "waist_cm").message)
        self.assertIn("Waist", message(v.validate_measurement, 0, "waist_cm").message)
        self.assertIn("kg", message(v.validate_measurement, 600, "weight_kg").message)
        self.assertIn("cm", message(v.validate_measurement, 600, "chest_cm").message)
        message(v.validate_measurement, 70, "height_cm")

    def test_measurement_fields_are_the_six_agreed_ones(self):
        self.assertEqual(v.MEASUREMENT_FIELDS,
                         ("weight_kg", "waist_cm", "chest_cm", "bicep_cm", "thigh_cm", "forearm_cm"))
        self.assertEqual(v.DAILY_FIELDS, ("exercise", "junk_food", "cardio", "calories_kcal",
                                          "protein_g", "weight_lifted_kg"))


class DateTests(unittest.TestCase):
    def test_month(self):
        self.assertEqual(v.validate_month(2026, 10), (2026, 10))
        for year, month in ((1999, 5), (2101, 5), (2026, 0), (2026, 13), ("2026", 10), (2026, 10.0),
                            (True, 1), (2026, None)):
            message(v.validate_month, year, month)

    def test_day_must_exist_in_that_month(self):
        self.assertEqual(v.validate_day(2026, 10, 31), date(2026, 10, 31))
        self.assertEqual(v.validate_day(2028, 2, 29), date(2028, 2, 29))
        for year, month, day in ((2026, 11, 31), (2027, 2, 29), (2026, 10, 0), (2026, 10, 32),
                                 (2026, 10, "3"), (2026, 10, 3.0), (2026, 10, True)):
            self.assertEqual(message(v.validate_day, year, month, day).field, "day")
        self.assertIn("between 1 and 28", message(v.validate_day, 2027, 2, 29).message)

    def test_future_days_cannot_be_edited(self):
        today = date(2026, 10, 3)
        self.assertEqual(v.validate_editable_day(2026, 10, 3, today), today)       # today
        self.assertEqual(v.validate_editable_day(2026, 10, 1, today), date(2026, 10, 1))
        self.assertEqual(v.validate_editable_day(2026, 9, 30, today), date(2026, 9, 30))
        for year, month, day in ((2026, 10, 4), (2026, 11, 1), (2027, 1, 1)):
            error = message(v.validate_editable_day, year, month, day, today)
            self.assertEqual(error.field, "day")
            self.assertIn("future", error.message)
        message(v.validate_editable_day, 2026, 10, 32, today)

    def test_measurements_only_on_sundays(self):
        for day in (4, 11, 18, 25):
            self.assertEqual(v.validate_sunday(2026, 10, day), date(2026, 10, day))
        for day in (1, 3, 5, 10, 31):
            error = message(v.validate_sunday, 2026, 10, day)
            self.assertEqual(error.field, "day")
            self.assertIn("not a Sunday", error.message)
        self.assertEqual(v.validate_sunday(2026, 11, 29), date(2026, 11, 29))      # a fifth Sunday
        message(v.validate_sunday, 2026, 11, 31)


class UpdateTests(unittest.TestCase):
    def test_a_whole_day_is_returned_in_stored_form(self):
        clean = v.validate_daily_update({
            "exercise": "completed", "junk_food": "None", "cardio": "05:30",
            "calories_kcal": 2200.0, "protein_g": 140.5, "weight_lifted_kg": 2450,
        })
        self.assertEqual(clean, {
            "exercise": "Completed", "junk_food": "None", "cardio": "5:30",
            "calories_kcal": 2200, "protein_g": 140.5, "weight_lifted_kg": 2450,
        })

    def test_only_the_fields_sent_are_returned_and_null_clears(self):
        self.assertEqual(v.validate_daily_update({"exercise": "Partial"}), {"exercise": "Partial"})
        self.assertEqual(v.validate_daily_update({"cardio": None, "protein_g": ""}),
                         {"cardio": None, "protein_g": None})

    def test_one_bad_field_rejects_everything_and_every_problem_is_listed(self):
        error = message(v.validate_daily_update, {
            "exercise": "Completed", "cardio": "25.30", "calories_kcal": -5, "steps": 9000,
        })
        self.assertEqual(set(error.errors), {"cardio", "calories_kcal", "steps"})
        self.assertNotIn("exercise", error.errors)
        self.assertIn(error.field, error.errors)
        self.assertIn("not a daily field", error.errors["steps"])

    def test_measurement_fields_are_not_daily_fields_and_the_reverse(self):
        self.assertIn("weight_kg", message(v.validate_daily_update, {"weight_kg": 72}).errors)
        self.assertIn("exercise", message(v.validate_measurement_update, {"exercise": "Completed"}).errors)

    def test_empty_or_wrongly_shaped_updates(self):
        for bad in ({}, None, [], "exercise", 5):
            self.assertEqual(message(v.validate_daily_update, bad).field, "body")
            self.assertEqual(message(v.validate_measurement_update, bad).field, "body")

    def test_measurement_update(self):
        self.assertEqual(v.validate_measurement_update({"weight_kg": 72.5, "waist_cm": 84.0, "chest_cm": None}),
                         {"weight_kg": 72.5, "waist_cm": 84, "chest_cm": None})
        error = message(v.validate_measurement_update, {"weight_kg": 0, "waist_cm": 84, "bicep_cm": "35"})
        self.assertEqual(set(error.errors), {"weight_kg", "bicep_cm"})

    def test_error_carries_field_and_message(self):
        error = message(v.validate_calories, -1)
        self.assertIsInstance(error, ValueError)
        self.assertEqual(error.errors, {"calories_kcal": error.message})
        self.assertEqual(str(error), error.message)

    def test_no_goal_or_target_exists(self):
        names = " ".join(dir(v)).lower()
        for word in ("goal", "target", "meditation", "muscle"):
            self.assertNotIn(word, names)


if __name__ == "__main__":
    unittest.main()
