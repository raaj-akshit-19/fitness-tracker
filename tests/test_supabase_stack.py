"""Raft against the real Supabase services: the auth server, the REST layer and
PostgreSQL, set up from supabase/migrations/ with row level security on.

Needs the local stack:  python supabase/local/stack.py up
Skipped when it is not running.
"""

import importlib.util
import time
import unittest
import uuid
from datetime import date
from pathlib import Path

from backend import supabase_http
from backend.app import create_app
from backend.config import Config

ROOT = Path(__file__).resolve().parent.parent
TODAY = date(2026, 10, 20)
PASSWORD = "stack-test-password-1"


def _load_stack():
    spec = importlib.util.spec_from_file_location("raft_local_stack", ROOT / "supabase" / "local" / "stack.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stack = _load_stack()


def _stack_running():
    try:
        return supabase_http.call("GET", f"{stack.URL}/auth/v1/health", {}, timeout=3).ok
    except Exception:
        return False


RUNNING = _stack_running()


@unittest.skipUnless(RUNNING, "the local Supabase stack is not running (python supabase/local/stack.py up)")
class StackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.anon = stack.anon_key()
        cls.config = Config(supabase_url=stack.URL, supabase_anon_key=cls.anon)
        cls.batch = uuid.uuid4().hex[:10]

    @classmethod
    def tearDownClass(cls):
        # Remove this run's accounts (and, by cascade, all their rows). Only the local
        # stack's own database superuser can do that; the app never could.
        stack.compose("exec", "-T", "db", "psql", "-U", "postgres", "-qc",
                      f"delete from auth.users where email like '%-{cls.batch}@stack.test'", check=False)

    def account(self, name):
        """A new signed-in browser for a new account."""
        client = create_app(config=self.config, today=lambda: TODAY).test_client()
        email = f"{name}-{uuid.uuid4().hex[:6]}-{self.batch}@stack.test"
        response = client.post("/api/auth/register", json={"email": email, "password": PASSWORD,
                                                           "confirm": PASSWORD, "display_name": name.title()})
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        client.email = email
        return client

    def token(self, client):
        return client.get_cookie("raft_access", path="/api").value

    def rest(self, method, path, token=None, body=None, prefer=None):
        headers = {"apikey": self.anon, "Authorization": f"Bearer {token or self.anon}"}
        if prefer:
            headers["Prefer"] = prefer
        return supabase_http.call(method, f"{stack.URL}/rest/v1/{path}", headers, body)

    def user_id(self, client):
        rows = self.rest("GET", "profiles?select=id", self.token(client)).body
        self.assertEqual(len(rows), 1)
        return rows[0]["id"]

    # ---- accounts

    def test_register_login_restore_and_logout(self):
        client = self.account("asha")
        self.assertEqual(client.get("/api/auth/session").get_json()["user"]["display_name"], "Asha")
        profile = self.rest("GET", "profiles?select=email,display_name", self.token(client)).body
        self.assertEqual(profile, [{"email": client.email, "display_name": "Asha"}])
        client.post("/api/auth/logout")
        self.assertEqual(client.get("/api/months").status_code, 401)

        again = create_app(config=self.config, today=lambda: TODAY).test_client()
        wrong = again.post("/api/auth/login", json={"email": client.email, "password": "not-it-at-all"})
        self.assertEqual((wrong.status_code, wrong.get_json()["error"]["code"]), (401, "invalid_credentials"))
        right = again.post("/api/auth/login", json={"email": client.email, "password": PASSWORD})
        self.assertEqual(right.status_code, 200)
        # A fresh app (a server restart, or another worker) takes the same cookie.
        restored = create_app(config=self.config, today=lambda: TODAY).test_client()
        restored.set_cookie("raft_access", self.token(again), path="/api")
        restored.set_cookie("raft_refresh", again.get_cookie("raft_refresh", path="/api").value, path="/api")
        self.assertEqual(restored.get("/api/auth/session").get_json()["user"]["email"], client.email)
        duplicate = again.post("/api/auth/register", json={"email": client.email, "password": PASSWORD,
                                                           "confirm": PASSWORD, "display_name": "Copy"})
        self.assertEqual(duplicate.status_code, 409)

    def test_an_ended_session_is_refused(self):
        client = self.account("ended")
        token = self.token(client)
        client.post("/api/auth/logout")
        stale = create_app(config=self.config, today=lambda: TODAY).test_client()
        stale.set_cookie("raft_access", token, path="/api")
        stale.set_cookie("raft_refresh", "x", path="/api")
        # The token may still verify until it runs out, but its refresh token is gone;
        # a forged one never verifies.
        stale.set_cookie("raft_access", token[:-4] + "AAAA", path="/api")
        self.assertEqual(stale.get("/api/months").status_code, 401)

    # ---- the whole app, end to end

    def test_months_days_measurements_and_analytics(self):
        client = self.account("full")
        self.assertEqual(client.get("/api/months").get_json(), [])
        self.assertEqual(client.post("/api/months", json={"year": 2026, "month": 10}).status_code, 201)
        self.assertEqual(client.post("/api/months", json={"year": 2026, "month": 10}).status_code, 409)
        client.post("/api/months", json={"year": 2026, "month": 9})
        saved = client.put("/api/months/2026/10/days/3", json={"exercise": "Completed", "junk_food": "None",
                                                                "cardio": "25:30", "calories_kcal": 2200,
                                                                "protein_g": 140.5, "weight_lifted_kg": 2450.5})
        self.assertEqual(saved.status_code, 200, saved.get_data(as_text=True))
        self.assertEqual(saved.get_json()["day"]["cardio_seconds"], 1530)
        cleared = client.put("/api/months/2026/10/days/3", json={"protein_g": None})
        self.assertIsNone(cleared.get_json()["day"]["protein_g"])
        self.assertEqual(cleared.get_json()["day"]["calories_kcal"], 2200)
        self.assertEqual(client.put("/api/months/2026/10/measurements/4", json={"weight_kg": 72.5}).status_code, 200)
        self.assertEqual(client.put("/api/months/2026/10/days/21", json={"exercise": "Completed"}).status_code, 400)
        month = client.get("/api/months/2026/10").get_json()
        self.assertEqual((len(month["days"]), month["days"][2]["exercise"], month["measurements"][0]["weight_kg"]),
                         (31, "Completed", 72.5))
        analytics = client.get("/api/months/2026/10/analytics")
        self.assertEqual(analytics.status_code, 200)
        self.assertEqual(client.get("/api/months/2027/2").status_code, 404)

        before = client.get("/api/status").get_json()["modified"]
        client.put("/api/months/2026/10/days/4", json={"exercise": "Partial"})
        self.assertNotEqual(client.get("/api/status").get_json()["modified"], before)

        gone = client.delete("/api/months/2026/10", json={"confirm": "October 2026"})
        self.assertEqual(gone.status_code, 200)
        token = self.token(client)
        # Its days and Sundays are gone from the database, not just hidden.
        self.assertEqual(self.rest("GET", "daily_logs?select=date", token).body, [])
        self.assertEqual(self.rest("GET", "measurements?select=date", token).body, [])
        last = client.delete("/api/months/2026/9", json={"confirm": "September 2026"})
        self.assertEqual((last.status_code, last.get_json()["error"]["code"]), (409, "last_month"))

    # ---- row level security, asked directly, the way an attacker with a token would

    def test_users_are_kept_apart_by_the_database_itself(self):
        alice, bob = self.account("alice"), self.account("bob")
        alice.post("/api/months", json={"year": 2026, "month": 10})
        alice.put("/api/months/2026/10/days/3", json={"exercise": "Completed"})
        a_id, b_id = self.user_id(alice), self.user_id(bob)
        bob_token = self.token(bob)
        # Through Raft:
        self.assertEqual(bob.get("/api/months").get_json(), [])
        self.assertEqual(bob.get("/api/months/2026/10").status_code, 404)
        # Straight to the database with Bob's own token, naming Alice:
        for table in ("months", "daily_logs", "measurements", "profiles"):
            column = "id" if table == "profiles" else "user_id"
            rows = self.rest("GET", f"{table}?{column}=eq.{a_id}&select=*", bob_token).body
            self.assertEqual(rows, [], table)
        sneaked = self.rest("POST", "months", bob_token, {"user_id": a_id, "year": 2027, "month": 1})
        self.assertIn(sneaked.status, (401, 403))
        self.assertEqual(sneaked.error_code(), "42501")
        into_hers = self.rest("POST", "daily_logs", bob_token, {"user_id": a_id, "date": "2026-10-04", "calories": 1})
        self.assertIn(into_hers.status, (401, 403))
        changed = self.rest("PATCH", f"daily_logs?user_id=eq.{a_id}", bob_token, {"calories": 1}, "return=representation")
        self.assertEqual(changed.body, [])
        removed = self.rest("DELETE", f"months?user_id=eq.{a_id}", bob_token, prefer="return=representation")
        self.assertEqual(removed.body, [])
        # Handing his own month over to Alice is refused too.
        bob.post("/api/months", json={"year": 2026, "month": 12})
        moved = self.rest("PATCH", f"months?user_id=eq.{b_id}", bob_token, {"user_id": a_id})
        self.assertFalse(moved.ok)
        self.assertEqual(moved.error_code(), "42501")
        self.assertEqual([m["label"] for m in bob.get("/api/months").get_json()], ["December 2026"])
        # Alice's data is untouched.
        self.assertEqual(alice.get("/api/months/2026/10").get_json()["days"][2]["exercise"], "Completed")
        self.assertEqual(len(alice.get("/api/months").get_json()), 1)

    def test_two_users_each_see_only_their_own_months_days_and_measurements(self):
        alice, bob = self.account("ann"), self.account("ben")
        for client, (month, day, sunday, calories, weight) in ((alice, (10, 3, 4, 2100, 70.5)), (bob, (9, 7, 6, 1500, 88.2))):
            self.assertEqual(client.post("/api/months", json={"year": 2026, "month": month}).status_code, 201)
            self.assertEqual(client.put(f"/api/months/2026/{month}/days/{day}",
                                        json={"exercise": "Completed", "calories_kcal": calories}).status_code, 200)
            self.assertEqual(client.put(f"/api/months/2026/{month}/measurements/{sunday}",
                                        json={"weight_kg": weight}).status_code, 200)
        a_id, b_id = self.user_id(alice), self.user_id(bob)
        a_token, b_token = self.token(alice), self.token(bob)

        # Through Raft, each sees only their own.
        self.assertEqual([m["label"] for m in alice.get("/api/months").get_json()], ["October 2026"])
        self.assertEqual([m["label"] for m in bob.get("/api/months").get_json()], ["September 2026"])
        self.assertEqual(alice.get("/api/months/2026/10").get_json()["days"][2]["calories_kcal"], 2100)
        self.assertEqual(bob.get("/api/months/2026/9").get_json()["measurements"][0]["weight_kg"], 88.2)
        for client, other in ((alice, "9"), (bob, "10")):
            self.assertEqual(client.get(f"/api/months/2026/{other}").status_code, 404)
            self.assertEqual(client.get(f"/api/months/2026/{other}/analytics").status_code, 404)
            self.assertEqual(client.put(f"/api/months/2026/{other}/days/1", json={"exercise": "Missed"}).status_code, 404)
        # A foreign user id from the browser is refused or ignored, never followed.
        self.assertEqual([m["label"] for m in bob.get(f"/api/months?user_id={a_id}").get_json()], ["September 2026"])
        sneaky = bob.put("/api/months/2026/9/days/8", json={"exercise": "Completed", "user_id": a_id})
        self.assertEqual(sneaky.status_code, 400)

        # Straight to the database with each one's valid token: every table shows only its owner's rows,
        # even when asked for everything, or for the other user by id.
        for token, me, them in ((a_token, a_id, b_id), (b_token, b_id, a_id)):
            for table in ("months", "daily_logs", "measurements"):
                every = self.rest("GET", f"{table}?select=user_id", token).body
                self.assertTrue(every, table)
                self.assertEqual({row["user_id"] for row in every}, {me}, table)
                self.assertEqual(self.rest("GET", f"{table}?user_id=eq.{them}&select=*", token).body, [], table)
            self.assertEqual([row["id"] for row in self.rest("GET", "profiles?select=id", token).body], [me])
            # Writing rows as the other user is refused by the policies.
            for table, row in (("months", {"year": 2027, "month": 3}), ("daily_logs", {"date": "2026-10-05", "calories": 1}),
                               ("measurements", {"date": "2026-10-11", "weight": 1})):
                refused = self.rest("POST", table, token, dict(row, user_id=them))
                self.assertEqual(refused.error_code(), "42501", (table, refused.body))
            self.assertEqual(self.rest("PATCH", f"daily_logs?user_id=eq.{them}", token, {"calories": 1},
                                       "return=representation").body, [])
            self.assertEqual(self.rest("DELETE", f"measurements?user_id=eq.{them}", token,
                                       prefer="return=representation").body, [])
        # Nothing changed for either.
        self.assertEqual(alice.get("/api/months/2026/10").get_json()["days"][2]["calories_kcal"], 2100)
        self.assertEqual(bob.get("/api/months/2026/9").get_json()["days"][6]["calories_kcal"], 1500)

        # No token: nothing, through Raft or straight to the database.
        stranger = create_app(config=self.config, today=lambda: TODAY).test_client()
        self.assertEqual(stranger.get("/api/months").status_code, 401)
        for table in ("months", "daily_logs", "measurements", "profiles"):
            response = self.rest("GET", f"{table}?select=*")
            self.assertFalse(response.ok and response.body, table)

    def test_an_expired_token_is_refused_everywhere(self):
        client = self.account("exp")
        client.post("/api/months", json={"year": 2026, "month": 10})
        me = self.user_id(client)
        # A token for this very user, properly signed, that ran out an hour ago.
        expired = stack.signed_token({"sub": me, "role": "authenticated", "aud": "authenticated",
                                      "exp": int(time.time()) - 3600, "iat": int(time.time()) - 7200})
        direct = self.rest("GET", "months?select=*", expired)
        self.assertEqual(direct.status, 401)
        self.assertNotEqual(direct.body, [])
        stale = create_app(config=self.config, today=lambda: TODAY).test_client()
        stale.set_cookie("raft_access", expired, path="/api")
        stale.set_cookie("raft_refresh", "not-a-refresh-token", path="/api")
        response = stale.get("/api/months")
        self.assertEqual((response.status_code, response.get_json()["error"]["code"]), (401, "not_signed_in"))
        self.assertIn("Max-Age=0", " ".join(response.headers.getlist("Set-Cookie")))     # the dead cookies are cleared

    def test_nothing_without_a_signed_in_user(self):
        alice = self.account("anon")
        alice.post("/api/months", json={"year": 2026, "month": 10})
        for table in ("profiles", "months", "daily_logs", "measurements"):
            response = self.rest("GET", f"{table}?select=*")       # the public key alone
            self.assertFalse(response.ok and response.body, table)
        self.assertFalse(self.rest("POST", "months", body={"year": 2027, "month": 1}).ok)

    def test_the_database_refuses_bad_rows_whoever_sends_them(self):
        client = self.account("rules")
        client.post("/api/months", json={"year": 2026, "month": 10})
        token, me = self.token(client), self.user_id(client)
        cases = [
            ("daily_logs", {"user_id": me, "date": "2026-11-03", "calories": 1}, "23503"),        # a month not kept
            ("measurements", {"user_id": me, "date": "2026-10-05", "weight": 70}, "23514"),      # a Monday
            ("daily_logs", {"user_id": me, "date": "2026-10-03", "exercise_status": "Done"}, "23514"),
            ("daily_logs", {"user_id": me, "date": "2026-10-03", "calories": 20001}, "23514"),
            ("daily_logs", {"user_id": me, "date": "2026-10-03", "cardio_seconds": 60000}, "23514"),
            ("measurements", {"user_id": me, "date": "2026-10-04", "weight": 0}, "23514"),
            ("months", {"user_id": me, "year": 2026, "month": 13}, "23514"),
        ]
        for table, row, code in cases:
            response = self.rest("POST", table, token, row)
            self.assertFalse(response.ok, row)
            self.assertEqual(response.error_code(), code, (row, response.body))

    def test_a_profile_can_only_change_its_display_name(self):
        client = self.account("named")
        token, me = self.token(client), self.user_id(client)
        renamed = self.rest("PATCH", f"profiles?id=eq.{me}", token, {"display_name": "Renamed"}, "return=representation")
        self.assertEqual(renamed.body[0]["display_name"], "Renamed")
        for column, value in (("email", "other@example.test"), ("changed_at", "2000-01-01T00:00:00Z"), ("id", str(uuid.uuid4()))):
            response = self.rest("PATCH", f"profiles?id=eq.{me}", token, {column: value})
            self.assertFalse(response.ok, column)
        self.rest("DELETE", f"profiles?id=eq.{me}", token)                  # not allowed: it stays
        self.assertEqual(len(self.rest("GET", "profiles?select=id", token).body), 1)
        self.assertFalse(self.rest("POST", "rpc/note_change", token, {}).ok)
        self.assertFalse(self.rest("POST", "rpc/make_profile", token, {}).ok)


if __name__ == "__main__":
    unittest.main()
