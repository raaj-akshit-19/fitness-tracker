"""Checks for the HTTP API, run against a temporary workbook.

Run from the project root:  python -m unittest discover -s tests -v
"""

import shutil
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from backend import store as st
from backend import workbook as wbk
from backend.app import create_app


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = wbk.create_workbook(self.tmp / "Fitness_Tracker.xlsx")
        self.client = create_app(self.path).test_client()

    def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status)
        body = response.get_json()
        self.assertEqual(body["error"]["code"], code)
        self.assertTrue(body["error"]["message"])

    def test_list_months(self):
        response = self.client.get("/api/months")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(), [{"year": 2026, "month": 10, "label": "October 2026"}]
        )

    def test_get_month(self):
        response = self.client.get("/api/months/2026/10")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(len(body["days"]), 31)
        self.assertEqual(len(body["measurements"]), 4)
        self.assertEqual(body["days"][0]["date"], "2026-10-01")
        self.assertIsNone(body["days"][0]["exercise"])
        self.assertIsNone(body["days"][0]["cardio_seconds"])
        self.assertIsNone(body["days"][0]["weight_lifted_kg"])
        self.assertEqual(set(body["days"][0]), {"date", "exercise", "junk_food", "cardio_display", "cardio_seconds",
                                               "calories_kcal", "protein_g", "weight_lifted_kg"})

    def test_get_missing_month(self):
        self.assert_error(self.client.get("/api/months/2026/11"), 404, "month_not_found")

    def test_get_invalid_month(self):
        self.assert_error(self.client.get("/api/months/2026/13"), 400, "invalid_month")

    def test_create_month(self):
        response = self.client.post("/api/months", json={"year": 2026, "month": 11})
        self.assertEqual(response.status_code, 201)
        body = response.get_json()
        self.assertEqual(body["label"], "November 2026")
        self.assertEqual(len(body["days"]), 30)
        self.assertEqual(len(body["measurements"]), 5)
        self.assertEqual(len(self.client.get("/api/months").get_json()), 2)

    def test_create_duplicate_month(self):
        self.assert_error(
            self.client.post("/api/months", json={"year": 2026, "month": 10}),
            409, "month_exists",
        )

    def test_create_with_bad_input(self):
        post = self.client.post
        self.assert_error(post("/api/months", json={"year": 2026}), 400, "invalid_request")
        self.assert_error(post("/api/months", data="nope"), 400, "invalid_request")
        self.assert_error(post("/api/months", json=[2026, 11]), 400, "invalid_request")
        self.assert_error(
            post("/api/months", json={"year": "2026", "month": 11}), 400, "invalid_month"
        )
        self.assert_error(
            post("/api/months", json={"year": 2026, "month": 13}), 400, "invalid_month"
        )
        self.assertEqual(len(self.client.get("/api/months").get_json()), 1)

    def test_goals_are_not_accepted_or_stored(self):
        response = self.client.post(
            "/api/months", json={"year": 2026, "month": 11, "goals": {"exercise": 20}}
        )
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("goal", response.get_data(as_text=True).lower())

    def test_locked_workbook(self):
        with mock.patch.object(st.os, "replace", side_effect=PermissionError("locked")):
            response = self.client.post("/api/months", json={"year": 2026, "month": 11})
        self.assert_error(response, 423, "workbook_locked")
        self.assertEqual(len(self.client.get("/api/months").get_json()), 1)

    def test_missing_workbook(self):
        client = create_app(self.tmp / "nope.xlsx").test_client()
        self.assert_error(client.get("/api/months"), 500, "workbook_missing")

    def test_status(self):
        body = self.client.get("/api/status").get_json()
        self.assertEqual(set(body), {"workbook_modified", "locked", "unsaved_changes", "today"})
        self.assertEqual(body["today"], date.today().isoformat())
        self.assertIs(body["unsaved_changes"], False)
        self.assertIs(body["locked"], False)

    def test_unknown_route_and_method_return_json(self):
        self.assert_error(self.client.get("/api/nothing"), 404, "not_found")
        self.assert_error(self.client.delete("/api/months"), 405, "method_not_allowed")


if __name__ == "__main__":
    unittest.main()
