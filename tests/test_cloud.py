"""Raft over Supabase: accounts, each user's data kept apart, and the same answers
as the workbook store gave.

Runs without a network: FakeSupabase (tests/support.py) stands in for the
project, with the same rules as the real schema. The real Supabase services
over PostgreSQL, with the real migrations and row level security, are tested
in test_supabase_stack.py.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from backend.app import ACCESS_COOKIE, REFRESH_COOKIE, create_app
from backend.store import TrackerStore
from backend.supabase_store import DAY_COLUMN, MEASUREMENT_COLUMN
from tests.support import FakeAuth, FakeSupabase, cloud_app, fill_month, sign_in, workbook_app
from tests.test_frontend_js import MONTHS, build_editing_scenario, build_scenario

ROOT = Path(__file__).resolve().parent.parent
TODAY = date(2026, 10, 20)
PASSWORD = "correct-horse-1"


def cookies(response):
    """The Set-Cookie headers of a response, by name."""
    found = {}
    for header in response.headers.getlist("Set-Cookie"):
        name, _, rest = header.partition("=")
        found[name] = header
    return found


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.app, self.project = cloud_app(today=lambda: TODAY)
        self.client = self.app.test_client()

    def register(self, **body):
        fields = {"email": "asha@example.test", "password": PASSWORD, "confirm": PASSWORD, "display_name": "Asha"}
        fields.update(body)
        return self.client.post("/api/auth/register", json=fields)

    def test_nothing_is_served_without_signing_in(self):
        for method, url in (("get", "/api/status"), ("get", "/api/months"), ("get", "/api/months/2026/10"),
                            ("get", "/api/months/2026/10/analytics"), ("post", "/api/months"),
                            ("put", "/api/months/2026/10/days/1"), ("put", "/api/months/2026/10/measurements/4"),
                            ("delete", "/api/months/2026/10")):
            response = getattr(self.client, method)(url, json={})
            self.assertEqual(response.status_code, 401, url)
            self.assertEqual(response.get_json()["error"]["code"], "not_signed_in", url)
        self.assertEqual(self.client.get("/api/auth/session").status_code, 401)
        self.assertEqual(self.project.calls, [])                 # the database was never asked
        # The page itself is served to anyone: it shows the sign-in form.
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_register_signs_in_with_http_only_cookies(self):
        response = self.register()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json(), {"user": {"email": "asha@example.test", "display_name": "Asha"}})
        set_cookies = cookies(response)
        for name in (ACCESS_COOKIE, REFRESH_COOKIE):
            self.assertIn("HttpOnly", set_cookies[name])
            self.assertIn("SameSite=Lax", set_cookies[name])
            self.assertIn("Path=/api", set_cookies[name])
        # No token is ever in a response body.
        self.assertNotIn("token", response.get_data(as_text=True))
        self.assertEqual(self.client.get("/api/auth/session").get_json(), {"user": {"email": "asha@example.test", "display_name": "Asha"}})
        self.assertEqual(self.client.get("/api/months").get_json(), [])
        self.assertEqual(self.project.profiles[self.project.accounts["asha@example.test"]["id"]]["display_name"], "Asha")

    def test_registration_is_checked(self):
        cases = [
            ({"email": "not-an-email"}, "email"),
            ({"password": "short", "confirm": "short"}, "password"),
            ({"confirm": "something else"}, "confirm"),
            ({"display_name": "   "}, "display_name"),
            ({"display_name": "x" * 61}, "display_name"),
            ({"password": "p" * 73, "confirm": "p" * 73}, "password"),
        ]
        for body, field in cases:
            response = self.register(**body)
            self.assertEqual(response.status_code, 400, body)
            self.assertIn(field, response.get_json()["error"]["fields"], body)
        self.assertEqual(self.project.accounts, {})
        self.assertEqual(self.client.post("/api/auth/register", data="nope").status_code, 400)

    def test_an_email_already_registered(self):
        self.register()
        self.client.post("/api/auth/logout")
        response = self.register(display_name="Someone else")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["error"]["code"], "account_exists")

    def test_registration_that_needs_the_email_confirmed(self):
        app, project = cloud_app(FakeSupabase(confirm_email=True), today=lambda: TODAY)
        client = app.test_client()
        response = client.post("/api/auth/register", json={"email": "b@example.test", "password": PASSWORD,
                                                           "confirm": PASSWORD, "display_name": "B"})
        self.assertEqual(response.status_code, 201)
        self.assertIs(response.get_json()["confirmation_required"], True)
        self.assertEqual(cookies(response), {})                  # not signed in yet
        self.assertEqual(client.get("/api/months").status_code, 401)
        refused = sign_in(client, project, "b@example.test")
        self.assertEqual((refused.status_code, refused.get_json()["error"]["code"]), (403, "email_not_confirmed"))

    def test_login_logout_and_wrong_details(self):
        self.project.new_user("asha@example.test", PASSWORD, "Asha")
        for email, password in (("asha@example.test", "wrong-password"), ("nobody@example.test", PASSWORD)):
            response = sign_in(self.client, self.project, email, password)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.get_json()["error"]["code"], "invalid_credentials")
            # The same words either way: nothing says whether the email has an account.
            self.assertEqual(response.get_json()["error"]["message"], "That email and password do not match an account.")
        self.assertEqual(self.client.post("/api/auth/login", json={"email": "", "password": ""}).status_code, 400)
        response = sign_in(self.client, self.project, "asha@example.test")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/months").status_code, 200)
        out = self.client.post("/api/auth/logout")
        self.assertEqual(out.status_code, 200)
        self.assertIn(ACCESS_COOKIE, cookies(out))               # cleared
        self.assertIn("Max-Age=0", cookies(out)[ACCESS_COOKIE])
        self.assertEqual(self.client.get("/api/months").status_code, 401)
        self.assertEqual(self.project.access, {})                # the session ended at Supabase too
        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)     # signing out twice is fine

    def test_session_survives_a_reload_and_is_renewed_when_it_runs_out(self):
        clock = [1_000_000.0]
        project = FakeSupabase(token_lifetime=600, clock=lambda: clock[0])
        app, _ = cloud_app(project, today=lambda: TODAY)
        client = app.test_client()
        project.new_user("asha@example.test", PASSWORD, "Asha")
        sign_in(client, project, "asha@example.test")
        first = client.get_cookie(ACCESS_COOKIE, path="/api").value
        # A reload: the same cookies, the same session.
        self.assertEqual(client.get("/api/auth/session").status_code, 200)
        self.assertEqual(client.get_cookie(ACCESS_COOKIE, path="/api").value, first)
        # The access token runs out; the refresh token gets a new pair, quietly.
        clock[0] += 601
        response = client.get("/api/months")
        self.assertEqual(response.status_code, 200)
        self.assertIn(ACCESS_COOKIE, cookies(response))
        self.assertNotEqual(client.get_cookie(ACCESS_COOKIE, path="/api").value, first)
        self.assertEqual(client.get("/api/auth/session").status_code, 200)

    def test_a_session_that_cannot_be_renewed_signs_out(self):
        self.project.new_user("asha@example.test", PASSWORD, "Asha")
        sign_in(self.client, self.project, "asha@example.test")
        self.project.access.clear()
        self.project.refresh.clear()                            # ended elsewhere (signed out on another device)
        response = self.client.get("/api/months")
        self.assertEqual(response.status_code, 401)
        self.assertIn("Max-Age=0", cookies(response).get(ACCESS_COOKIE, ""))
        self.client.set_cookie(ACCESS_COOKIE, "forged.token.value", path="/api")
        self.client.set_cookie(REFRESH_COOKIE, "forged", path="/api")
        self.assertEqual(self.client.get("/api/months").status_code, 401)

    def test_account_requests_from_another_site_are_refused(self):
        self.project.new_user("asha@example.test", PASSWORD, "Asha")
        for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}, {"Host": "evil.example"}):
            response = self.client.post("/api/auth/login", json={"email": "asha@example.test", "password": PASSWORD},
                                        headers=headers)
            self.assertEqual(response.status_code, 403, headers)
            self.assertEqual(cookies(response), {}, headers)

    def test_supabase_unreachable(self):
        self.project.new_user("asha@example.test", PASSWORD, "Asha")
        sign_in(self.client, self.project, "asha@example.test")
        fill_month(self.project, self.project.accounts["asha@example.test"]["id"], 2026, 10)
        self.project.down = True
        for response in (self.client.get("/api/months"), self.client.put("/api/months/2026/10/days/1", json={"exercise": "Completed"}),
                         sign_in(self.client, self.project, "asha@example.test")):
            self.assertEqual(response.status_code, 503)
            body = response.get_json()["error"]
            self.assertEqual(body["code"], "service_unavailable")
            self.assertIn("Nothing was saved", body["message"])
        self.project.down = False
        self.assertIsNone(self.project.days[self.project.accounts["asha@example.test"]["id"]].get("2026-10-01"))

    def test_unexpected_errors_tell_nothing_of_inside(self):
        def broken(session):
            raise RuntimeError("postgres://user:secret@db/raft exploded")
        project = FakeSupabase()
        app = create_app(store_factory=broken, auth=FakeAuth(project), today=lambda: TODAY)
        project.new_user("asha@example.test", PASSWORD, "Asha")
        client = app.test_client()
        sign_in(client, project, "asha@example.test")
        response = client.get("/api/months")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["error"]["code"], "server_error")
        self.assertNotIn("secret", response.get_data(as_text=True))
        self.assertNotIn("postgres", response.get_data(as_text=True))

    def test_security_headers(self):
        response = self.client.get("/api/months")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")


class IsolationTests(unittest.TestCase):
    """User A never sees or changes anything of user B's, whatever the browser sends."""

    def setUp(self):
        self.app, self.p = cloud_app(today=lambda: TODAY)
        self.a = self.p.new_user("a@example.test", PASSWORD, "A")
        self.b = self.p.new_user("b@example.test", PASSWORD, "B")
        fill_month(self.p, self.a, 2026, 10, days={"2026-10-03": {"exercise_status": "Completed", "calories": 2100}},
                   sundays={"2026-10-04": {"weight": 72.5}})
        fill_month(self.p, self.a, 2026, 9)
        fill_month(self.p, self.b, 2026, 11, days={"2026-11-02": {"exercise_status": "Missed"}})
        self.alice, self.bob = self.app.test_client(), self.app.test_client()
        sign_in(self.alice, self.p, "a@example.test")
        sign_in(self.bob, self.p, "b@example.test")

    def test_each_sees_only_their_own(self):
        self.assertEqual([m["label"] for m in self.alice.get("/api/months").get_json()], ["September 2026", "October 2026"])
        self.assertEqual([m["label"] for m in self.bob.get("/api/months").get_json()], ["November 2026"])
        self.assertEqual(self.bob.get("/api/months/2026/10").status_code, 404)
        self.assertEqual(self.bob.get("/api/months/2026/10/analytics").status_code, 404)
        self.assertEqual(self.alice.get("/api/months/2026/11").status_code, 404)
        october = self.alice.get("/api/months/2026/10").get_json()
        self.assertEqual(october["days"][2]["exercise"], "Completed")
        self.assertEqual(self.alice.get("/api/status").get_json()["user"]["email"], "a@example.test")
        self.assertEqual(self.bob.get("/api/status").get_json()["user"]["email"], "b@example.test")

    def test_a_user_id_from_the_browser_is_never_used(self):
        # In the query string, the body or a header: refused or ignored, never followed.
        self.assertEqual(self.bob.get(f"/api/months?user_id={self.a}").get_json()[0]["label"], "November 2026")
        self.assertEqual(self.bob.get(f"/api/months/2026/10?user_id={self.a}").status_code, 404)
        sneaky = self.bob.put("/api/months/2026/11/days/2", json={"exercise": "Completed", "user_id": self.a})
        self.assertEqual(sneaky.status_code, 400)
        self.assertIn("user_id", sneaky.get_json()["error"]["fields"])
        made = self.bob.post("/api/months", json={"year": 2026, "month": 10, "user_id": self.a})
        self.assertEqual(made.status_code, 201)
        self.assertIn((2026, 10), self.p.months[self.b])          # Bob's own October, not Alice's
        self.assertEqual(self.p.days[self.a]["2026-10-03"]["calories"], 2100)
        self.assertEqual(self.bob.get("/api/months/2026/10", headers={"X-User-Id": self.a}).get_json()["days"][2]["exercise"], None)

    def test_one_user_cannot_change_or_delete_the_others(self):
        self.assertEqual(self.bob.put("/api/months/2026/9/days/1", json={"exercise": "Completed"}).status_code, 404)
        self.assertEqual(self.bob.put("/api/months/2026/10/measurements/4", json={"weight_kg": 60}).status_code, 404)
        self.assertEqual(self.bob.delete("/api/months/2026/9", json={"confirm": "September 2026"}).status_code, 404)
        self.assertEqual(self.p.months[self.a], {(2026, 9), (2026, 10)})
        self.assertEqual(self.p.sundays[self.a]["2026-10-04"]["weight"], 72.5)
        # Every database call went out as the signed-in user.
        self.assertEqual({user for user, _ in self.p.calls if user != self.a}, {self.b})
        bobs = [what for user, what in self.p.calls if user == self.b]
        self.assertTrue(bobs)

    def test_signing_out_one_user_leaves_the_other_signed_in(self):
        self.alice.post("/api/auth/logout")
        self.assertEqual(self.alice.get("/api/months").status_code, 401)
        self.assertEqual(self.bob.get("/api/months").status_code, 200)


class MonthTests(unittest.TestCase):
    def setUp(self):
        self.app, self.p = cloud_app(today=lambda: TODAY)
        self.user = self.p.new_user("a@example.test", PASSWORD, "A")
        self.client = self.app.test_client()
        sign_in(self.client, self.p, "a@example.test")

    def test_add_list_duplicate_and_delete(self):
        made = self.client.post("/api/months", json={"year": 2026, "month": 10})
        self.assertEqual(made.status_code, 201)
        body = made.get_json()
        self.assertEqual((body["label"], len(body["days"]), len(body["measurements"]), body["issues"]), ("October 2026", 31, 4, []))
        self.assertTrue(all(day["exercise"] is None for day in body["days"]))
        again = self.client.post("/api/months", json={"year": 2026, "month": 10})
        self.assertEqual((again.status_code, again.get_json()["error"]["code"]), (409, "month_exists"))
        self.client.post("/api/months", json={"year": 2027, "month": 2})
        self.client.post("/api/months", json={"year": 2026, "month": 9})
        self.assertEqual([m["label"] for m in self.client.get("/api/months").get_json()],
                         ["September 2026", "October 2026", "February 2027"])     # calendar order
        self.client.put("/api/months/2026/10/days/3", json={"exercise": "Completed", "calories_kcal": 2000})
        self.client.put("/api/months/2026/10/measurements/4", json={"weight_kg": 70})
        gone = self.client.delete("/api/months/2026/10", json={"confirm": "October 2026"})
        self.assertEqual(gone.status_code, 200)
        self.assertEqual(gone.get_json()["deleted"]["label"], "October 2026")
        self.assertEqual([m["label"] for m in gone.get_json()["months"]], ["September 2026", "February 2027"])
        # Its days and Sundays went with it.
        self.assertEqual(self.p.days[self.user], {})
        self.assertEqual(self.p.sundays[self.user], {})
        self.assertEqual(self.client.get("/api/months/2026/10").status_code, 404)
        # Added again, it is empty.
        self.client.post("/api/months", json={"year": 2026, "month": 10})
        self.assertIsNone(self.client.get("/api/months/2026/10").get_json()["days"][2]["exercise"])

    def test_the_last_month_cannot_be_deleted(self):
        self.client.post("/api/months", json={"year": 2026, "month": 10})
        refused = self.client.delete("/api/months/2026/10", json={"confirm": "October 2026"})
        self.assertEqual((refused.status_code, refused.get_json()["error"]["code"]), (409, "last_month"))
        self.assertIn("only month", refused.get_json()["error"]["message"])
        self.assertEqual(self.p.months[self.user], {(2026, 10)})

    def test_delete_needs_the_month_named(self):
        self.client.post("/api/months", json={"year": 2026, "month": 10})
        self.client.post("/api/months", json={"year": 2026, "month": 11})
        for body in (None, {}, {"confirm": "October 2026"}, {"confirm": True}):
            self.assertEqual(self.client.delete("/api/months/2026/11", json=body).status_code, 400)
        self.assertEqual(self.p.months[self.user], {(2026, 10), (2026, 11)})
        self.assertEqual(self.client.delete("/api/months/2026/12", json={"confirm": "December 2026"}).status_code, 404)
        self.assertEqual(self.client.delete("/api/months/2026/13", json={}).status_code, 400)

    def test_every_month_length(self):
        for year, month, days, sundays in ((2027, 2, 28, 4), (2028, 2, 29, 4), (2026, 11, 30, 5), (2026, 10, 31, 4)):
            self.client.post("/api/months", json={"year": year, "month": month})
            body = self.client.get(f"/api/months/{year}/{month}").get_json()
            self.assertEqual((len(body["days"]), len(body["measurements"])), (days, sundays), (year, month))
            self.assertEqual(body["days"][-1]["date"], f"{year}-{month:02d}-{days:02d}")

    def test_only_the_month_is_read(self):
        fill_month(self.p, self.user, 2026, 9, days={"2026-09-30": {"calories": 1}})
        fill_month(self.p, self.user, 2026, 10, days={"2026-10-01": {"calories": 2}})
        fill_month(self.p, self.user, 2026, 11, days={"2026-11-01": {"calories": 3}})
        self.p.calls.clear()
        october = self.client.get("/api/months/2026/10").get_json()
        self.assertEqual([d["calories_kcal"] for d in october["days"] if d["calories_kcal"] is not None], [2])
        ranges = [what for _, what in self.p.calls if isinstance(what, tuple)]
        self.assertEqual(ranges, [("days", "2026-10-01", "2026-10-31"), ("measurements", "2026-10-01", "2026-10-31")])


class DayTests(unittest.TestCase):
    def setUp(self):
        self.app, self.p = cloud_app(today=lambda: TODAY)
        self.user = self.p.new_user("a@example.test", PASSWORD, "A")
        fill_month(self.p, self.user, 2026, 10)
        self.client = self.app.test_client()
        sign_in(self.client, self.p, "a@example.test")

    def put(self, day, body, kind="days"):
        return self.client.put(f"/api/months/2026/10/{kind}/{day}", json=body)

    def test_create_update_clear_and_keep(self):
        made = self.put(3, {"exercise": "completed", "junk_food": "Controlled", "cardio": "025:30",
                            "calories_kcal": 2200, "protein_g": 140.5, "weight_lifted_kg": 2450})
        self.assertEqual(made.status_code, 200)
        self.assertEqual(made.get_json()["day"], {"date": "2026-10-03", "exercise": "Completed", "junk_food": "Controlled",
                                                  "cardio_display": "25:30", "cardio_seconds": 1530, "calories_kcal": 2200,
                                                  "protein_g": 140.5, "weight_lifted_kg": 2450})
        self.assertEqual(self.p.days[self.user]["2026-10-03"]["cardio_seconds"], 1530)
        changed = self.put(3, {"protein_g": None, "calories_kcal": 0})
        day = changed.get_json()["day"]
        self.assertEqual((day["protein_g"], day["calories_kcal"], day["exercise"], day["cardio_display"]), (None, 0, "Completed", "25:30"))
        self.assertIn("modified", changed.get_json())

    def test_refusals_change_nothing(self):
        self.put(3, {"exercise": "Completed"})
        before = json.dumps(self.p.days[self.user], sort_keys=True)
        cases = [
            (3, {"exercise": "Done", "calories_kcal": 12.5, "cardio": "9:99"}, 400, "invalid_request"),
            (25, {"exercise": "Completed"}, 400, "invalid_request"),          # the future
            (32, {"exercise": "Completed"}, 404, "day_not_found"),
            (3, {}, 400, "invalid_request"),
        ]
        for day, body, status, code in cases:
            response = self.put(day, body)
            self.assertEqual((response.status_code, response.get_json()["error"]["code"]), (status, code), body)
        future = self.put(21, {"exercise": "Completed"}).get_json()["error"]["fields"]
        self.assertEqual(future, {"day": "A day in the future cannot be edited yet."})
        self.assertEqual(self.client.put("/api/months/2026/8/days/2", json={"exercise": "Completed"}).status_code, 404)
        self.assertEqual(self.client.put("/api/months/2026/10/days/3", data="x").status_code, 400)
        self.assertEqual(json.dumps(self.p.days[self.user], sort_keys=True), before)

    def test_today_is_editable_and_tomorrow_is_not(self):
        self.assertEqual(self.put(20, {"exercise": "Partial"}).status_code, 200)
        self.assertEqual(self.put(21, {"exercise": "Partial"}).status_code, 400)

    def test_measurements_on_sundays(self):
        ok = self.put(4, {"weight_kg": 72.5, "waist_cm": 84}, "measurements")
        self.assertEqual(ok.get_json()["measurement"], {"sunday": "2026-10-04", "weight_kg": 72.5, "waist_cm": 84,
                                                        "chest_cm": None, "bicep_cm": None, "thigh_cm": None, "forearm_cm": None})
        self.assertEqual(self.put(5, {"weight_kg": 70}, "measurements").get_json()["error"]["fields"],
                         {"day": "05 October 2026 is not a Sunday. Measurements go on Sundays."})
        self.assertEqual(self.put(25, {"weight_kg": 70}, "measurements").status_code, 400)
        self.assertEqual(self.put(4, {"weight_kg": 0, "waist_cm": 501}, "measurements").status_code, 400)
        self.assertEqual(self.p.sundays[self.user]["2026-10-04"]["weight"], 72.5)

    def test_the_users_own_date_is_used_within_a_day(self):
        app, p = cloud_app()                                     # the real clock
        user = p.new_user("a@example.test", PASSWORD, "A")
        client = app.test_client()
        sign_in(client, p, "a@example.test")
        today = client.get("/api/status").get_json()["today"]
        theirs = date.fromisoformat(today) + timedelta(days=1)
        self.assertEqual(client.get("/api/status", headers={"X-Raft-Today": theirs.isoformat()}).get_json()["today"], theirs.isoformat())
        far = date.fromisoformat(today) + timedelta(days=5)
        self.assertEqual(client.get("/api/status", headers={"X-Raft-Today": far.isoformat()}).get_json()["today"], today)
        fill_month(p, user, far.year, far.month)
        response = client.put(f"/api/months/{far.year}/{far.month}/days/{far.day}", json={"exercise": "Completed"},
                              headers={"X-Raft-Today": far.isoformat()})
        self.assertEqual(response.status_code, 400)               # a date far ahead is not believed

    def test_polling_sees_every_kind_of_change(self):
        seen = [self.client.get("/api/status").get_json()["modified"]]
        self.put(3, {"exercise": "Completed"})
        seen.append(self.client.get("/api/status").get_json()["modified"])
        self.client.post("/api/months", json={"year": 2026, "month": 11})
        seen.append(self.client.get("/api/status").get_json()["modified"])
        self.client.delete("/api/months/2026/11", json={"confirm": "November 2026"})
        seen.append(self.client.get("/api/status").get_json()["modified"])
        self.assertEqual(len(set(seen)), 4)                      # each change, a deletion too, is noticed


class EditionTests(unittest.TestCase):
    """The web edition and the desktop one: what each is made of and what it may reach."""

    def test_health_check_needs_no_session_and_asks_nothing_of_supabase(self):
        app, project = cloud_app(today=lambda: TODAY)
        response = app.test_client().get("/api/health")
        self.assertEqual((response.status_code, response.get_json()), (200, {"app": "raft", "ok": True}))
        self.assertEqual(project.calls, [])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_the_web_edition_never_loads_the_workbook_code(self):
        program = ("import sys, wsgi; "
                   "loaded = sorted(m for m in sys.modules if m.split('.')[0] == 'openpyxl' "
                   "or m.split('.')[0] in ('win32com', 'pythoncom', 'pywintypes', 'win32api', 'win32timezone') "
                   "or m in ('backend.store', 'backend.workbook', 'backend.excel_live', 'backend.desktop')); "
                   "print(repr(loaded)); print(type(wsgi.app).__name__)")
        env = {key: value for key, value in os.environ.items() if not key.startswith(("SUPABASE_", "RAFT_"))}
        env.update({"SUPABASE_URL": "http://127.0.0.1:9", "SUPABASE_ANON_KEY": "placeholder", "PYTHONDONTWRITEBYTECODE": "1"})
        result = subprocess.run([sys.executable, "-c", program], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["[]", "Flask"])

    def test_the_web_edition_will_not_start_without_its_settings(self):
        from backend import config as cfg
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(cfg, "load_env_file"):
            with self.assertRaises(cfg.ConfigError) as caught:
                create_app()
        self.assertIn("SUPABASE_URL and SUPABASE_ANON_KEY", str(caught.exception))
        self.assertIn(".env.example", str(caught.exception))

    def test_settings(self):
        from backend import config as cfg
        base = {"SUPABASE_URL": "https://abc.supabase.co/", "SUPABASE_ANON_KEY": "public-key"}
        with mock.patch.dict(os.environ, base, clear=True), mock.patch.object(cfg, "load_env_file"):
            found = cfg.Config.from_env()
            self.assertEqual((found.supabase_url, found.trust_proxy, found.cookie_secure), ("https://abc.supabase.co", False, None))
            self.assertEqual(found.hosts, ("127.0.0.1", "localhost"))
        with mock.patch.dict(os.environ, dict(base, RAFT_TRUST_PROXY="1", RAFT_COOKIE_SECURE="1",
                                              RENDER_EXTERNAL_HOSTNAME="raft.onrender.com", RAFT_ALLOWED_HOSTS="Raft.Example.com, "),
                             clear=True), mock.patch.object(cfg, "load_env_file"):
            found = cfg.Config.from_env()
            self.assertEqual((found.trust_proxy, found.cookie_secure), (True, True))
            self.assertEqual(found.hosts, ("127.0.0.1", "localhost", "raft.example.com", "raft.onrender.com"))
        for url in ("http://abc.supabase.co", "ftp://x", "abc.supabase.co"):
            with mock.patch.dict(os.environ, dict(base, SUPABASE_URL=url), clear=True), mock.patch.object(cfg, "load_env_file"):
                with self.assertRaises(cfg.ConfigError):
                    cfg.Config.from_env()

    def test_env_file_never_overrides_the_environment(self):
        from backend import config as cfg
        with tempfile.TemporaryDirectory() as folder:
            env_file = Path(folder) / ".env"
            env_file.write_text("# a comment\nSUPABASE_URL=https://file.supabase.co\nSUPABASE_ANON_KEY='from-file'\nnot a setting\n")
            with mock.patch.dict(os.environ, {"SUPABASE_URL": "https://env.supabase.co"}, clear=True):
                cfg.load_env_file(env_file)
                self.assertEqual(os.environ["SUPABASE_URL"], "https://env.supabase.co")
                self.assertEqual(os.environ["SUPABASE_ANON_KEY"], "from-file")

    def test_secure_cookies_behind_https(self):
        project = FakeSupabase()
        from backend.config import Config
        config = Config(supabase_url="https://x.supabase.co", supabase_anon_key="k", trust_proxy=True,
                        cookie_secure=None, hosts=("127.0.0.1", "localhost", "raft.onrender.com"))
        app = create_app(store_factory=lambda s: None, auth=FakeAuth(project), today=lambda: TODAY, config=config)
        project.new_user("a@example.test", PASSWORD, "A")
        response = app.test_client().post("/api/auth/login", json={"email": "a@example.test", "password": PASSWORD},
                                          headers={"Host": "raft.onrender.com", "X-Forwarded-Proto": "https",
                                                   "Origin": "https://raft.onrender.com"})
        self.assertEqual(response.status_code, 200)
        for header in cookies(response).values():
            self.assertIn("Secure", header)
            self.assertIn("HttpOnly", header)

    def test_the_desktop_edition_has_one_local_user_and_no_sign_in(self):
        from backend import workbook as wbk
        from backend.desktop import create_desktop_app
        with tempfile.TemporaryDirectory() as folder:
            path = wbk.create_workbook(Path(folder) / "Fitness_Tracker.xlsx")
            client = create_desktop_app(path, today=lambda: TODAY).test_client()
            status = client.get("/api/status").get_json()
            self.assertEqual(status["user"], {"email": "", "display_name": "This computer", "local": True})
            self.assertIn("workbook_modified", status)
            self.assertEqual(client.get("/api/months").get_json(), [{"year": 2026, "month": 10, "label": "October 2026"}])
            refused = client.post("/api/auth/login", json={"email": "a@example.test", "password": PASSWORD})
            self.assertEqual(refused.status_code, 401)
            self.assertEqual(client.post("/api/auth/logout").status_code, 200)
            self.assertEqual(client.get("/api/months").status_code, 200)       # still the one user


def seed_from_workbook(project, user, path, months):
    """Put a workbook's months into the stand-in project, as Raft would store them."""
    store = TrackerStore(path)
    for year, month in months:
        data = store.get_month(year, month)
        days = {}
        for day in data["days"]:
            row = {}
            for field, column in DAY_COLUMN.items():
                value = day["cardio_seconds"] if field == "cardio" else day[field]
                if value is not None:
                    row[column] = value
            if row:
                days[day["date"]] = row
        sundays = {}
        for record in data["measurements"]:
            row = {column: record[field] for field, column in MEASUREMENT_COLUMN.items() if record[field] is not None}
            if row:
                sundays[record["sunday"]] = row
        fill_month(project, user, year, month, days, sundays)


def without_times(body):
    if isinstance(body, dict):
        return {key: without_times(value) for key, value in body.items() if key not in ("modified", "workbook_modified")}
    return body


class SameAnswersAsTheWorkbookTests(unittest.TestCase):
    """The workbook store's answers are the reference: the Supabase store must give the same."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def pair(self, build, months):
        path = self.tmp / f"{build.__name__}.xlsx"
        build(path)
        old = workbook_app(path, today=lambda: TODAY).test_client()
        app, project = cloud_app(today=lambda: TODAY)
        user = project.new_user("a@example.test", PASSWORD, "A")
        seed_from_workbook(project, user, path, months)
        new = app.test_client()
        sign_in(new, project, "a@example.test")
        return old, new

    def test_months_days_sundays_and_analytics(self):
        old, new = self.pair(build_scenario, MONTHS)
        urls = ["/api/months"] + [f"/api/months/{y}/{m}" for y, m in MONTHS] + [f"/api/months/{y}/{m}/analytics" for y, m in MONTHS]
        for url in urls:
            self.assertEqual(new.get(url).get_json(), old.get(url).get_json(), url)

    def test_the_same_edits_get_the_same_answers(self):
        old, new = self.pair(build_scenario, MONTHS)
        edits = [
            ("put", "/api/months/2026/10/days/2", {"exercise": "Partial", "calories_kcal": 1800, "protein_g": 99.5}),
            ("put", "/api/months/2026/10/days/2", {"protein_g": None}),
            ("put", "/api/months/2026/10/days/20", {"junk_food": "None", "cardio": "5:05"}),
            ("put", "/api/months/2026/10/days/21", {"exercise": "Completed"}),
            ("put", "/api/months/2026/10/days/3", {"exercise": "Done", "calories_kcal": 12.5, "cardio": "9:99"}),
            ("put", "/api/months/2026/10/days/3", {"nonsense": 1}),
            ("put", "/api/months/2026/8/days/3", {"exercise": "Completed"}),
            ("put", "/api/months/2026/10/days/40", {"exercise": "Completed"}),
            ("put", "/api/months/2026/10/measurements/11", {"waist_cm": 83, "forearm_cm": 29.5}),
            ("put", "/api/months/2026/10/measurements/12", {"waist_cm": 83}),
            ("put", "/api/months/2026/10/measurements/11", {"weight_kg": 0}),
            ("post", "/api/months", {"year": 2027, "month": 2}),
            ("post", "/api/months", {"year": 2026, "month": 10}),
            ("post", "/api/months", {"year": 1999, "month": 2}),
            ("delete", "/api/months/2026/12", {"confirm": "December 2026"}),
            ("delete", "/api/months/2026/12", {"confirm": "December 2026"}),
        ]
        for method, url, body in edits:
            a, b = getattr(old, method)(url, json=body), getattr(new, method)(url, json=body)
            self.assertEqual(b.status_code, a.status_code, (url, body))
            answer_old, answer_new = without_times(a.get_json()), without_times(b.get_json())
            if a.status_code >= 400:
                self.assertEqual(answer_new["error"]["code"], answer_old["error"]["code"], (url, body))
                self.assertEqual(answer_new["error"].get("fields"), answer_old["error"].get("fields"), (url, body))
            else:
                self.assertEqual(answer_new, answer_old, (url, body))
        for url in ["/api/months"] + [f"/api/months/2026/10", "/api/months/2026/10/analytics", "/api/months/2027/2"]:
            self.assertEqual(new.get(url).get_json(), old.get(url).get_json(), url)

    def test_editing_scenario_values_that_could_be_stored(self):
        # The editing workbook has cells typed wrongly in Excel; a database cannot hold
        # those, so they arrive blank and the month has no issues. Everything else matches.
        old, new = self.pair(build_editing_scenario, [(2026, 10), (2026, 11)])
        a, b = old.get("/api/months/2026/10").get_json(), new.get("/api/months/2026/10").get_json()
        self.assertTrue(a["issues"])
        self.assertEqual(b["issues"], [])
        flagged = {(issue["date"], issue["field"]) for issue in a["issues"]}
        for day_a, day_b in zip(a["days"], b["days"]):
            for field in day_a:
                if (day_a["date"], field) not in flagged and not (field == "cardio_display" and (day_a["date"], "cardio") in flagged):
                    self.assertEqual(day_b[field], day_a[field], (day_a["date"], field))


if __name__ == "__main__":
    unittest.main()
