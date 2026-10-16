"""Raft's HTTP API, plus the page's files.

Every route under /api/ except the account routes needs a signed-in user. Who
the user is comes only from their session (see auth.py): the API never takes a
user id from the browser. Each request gets a store for that one user, and the
store only ever reads and writes that user's rows.

Run locally from the project root (settings in .env, see .env.example):

    python -m backend.app

then open http://127.0.0.1:5000. Deployed, gunicorn serves wsgi.py instead.
"""

import logging
import re
from datetime import date, datetime, timedelta, timezone

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from backend import errors as er
from backend.analytics import month_analytics
from backend.config import LOCAL_HOSTS
from backend.months import month_label
from backend.paths import RESOURCE_DIR

FRONTEND_DIR = RESOURCE_DIR / "frontend"

HOST = "127.0.0.1"
PORT = 5000

STATUS_CODES = {
    "invalid_request": 400,
    "invalid_month": 400,
    "not_signed_in": 401,
    "invalid_credentials": 401,
    "forbidden_origin": 403,
    "email_not_confirmed": 403,
    "month_not_found": 404,
    "day_not_found": 404,
    "month_exists": 409,
    "last_month": 409,
    "account_exists": 409,
    "workbook_locked": 423,
    "too_many_requests": 429,
    "workbook_missing": 500,
    "workbook_unreadable": 500,
    "workbook_format": 500,
    "service_unavailable": 503,
}

READ_METHODS = ("GET", "HEAD", "OPTIONS")
ACCOUNT_ROUTES = ("/api/auth/",)
HEALTH_ROUTE = "/api/health"

ACCESS_COOKIE = "raft_access"
REFRESH_COOKIE = "raft_refresh"
COOKIE_PATH = "/api"
REFRESH_COOKIE_DAYS = 60

TODAY_HEADER = "X-Raft-Today"
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

log = logging.getLogger("raft")


def _error(code, message, status, fields=None):
    error = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return jsonify({"error": error}), status


def _from_another_site(hosts):
    """True when a request that changes something did not come from Raft's own page.

    A page on another website can make the browser send requests here, with the
    user's cookies. The browser says where such a request came from, and that
    is what is checked: it must be this site itself. The address itself must
    also be one Raft is served at, which stops a site that points its own name
    at this server (DNS rebinding).
    """
    if request.host.rsplit(":", 1)[0].lower() not in hosts:
        return True
    origin = request.headers.get("Origin")
    if origin is not None and origin != f"{request.scheme}://{request.host}":
        return True
    return request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")


def _json_fields():
    """The request body, which must be JSON. Its contents are checked by the store."""
    if not request.is_json:
        raise er.InvalidUpdateError({"body": "Send the fields as JSON (Content-Type: application/json)."})
    body = request.get_json(silent=True)
    if body is None:
        raise er.InvalidUpdateError({"body": "The request body is not valid JSON."})
    return body


def _json_object():
    body = request.get_json(silent=True) if request.is_json else None
    if not isinstance(body, dict):
        raise er.InvalidUpdateError({"body": "Send the fields as a JSON object."})
    return body


def _request_today():
    """The user's date. The page sends its own (the user may be far from the server's
    time zone); it is used if it is within a day of the date in UTC, which covers
    every time zone on Earth. Otherwise the UTC date."""
    base = datetime.now(timezone.utc).date()
    sent = request.headers.get(TODAY_HEADER, "")
    try:
        theirs = date.fromisoformat(sent)
    except ValueError:
        return base
    return theirs if abs(theirs - base) <= timedelta(days=1) else base


def _registration(body):
    email = str(body.get("email") or "").strip()
    password = body.get("password") if isinstance(body.get("password"), str) else ""
    confirm = body.get("confirm") if isinstance(body.get("confirm"), str) else ""
    name = " ".join(str(body.get("display_name") or "").split())
    problems = {}
    if not EMAIL.match(email) or len(email) > 254:
        problems["email"] = "Enter a valid email address."
    if len(password) < 8:
        problems["password"] = "Choose a password of at least 8 characters."
    elif len(password) > 72:
        problems["password"] = "Choose a password of at most 72 characters."
    if password and confirm != password:
        problems["confirm"] = "The two passwords are not the same."
    if not name:
        problems["display_name"] = "Enter the name to show in Raft."
    elif len(name) > 60:
        problems["display_name"] = "Keep the name to 60 characters."
    if problems:
        raise er.InvalidUpdateError(problems)
    return email, password, name


def create_app(store_factory=None, auth=None, today=None, config=None):
    """The app.

    With no arguments it is the real thing: settings from the environment,
    accounts from Supabase Auth, data from Supabase. store_factory (a function
    of the signed-in Session returning a store) and auth can be given instead,
    which is how the tests run the same API over other stores. today, if given,
    fixes the date (for tests).
    """
    if store_factory is None or auth is None:
        from backend.auth import SupabaseAuth
        from backend.config import Config
        from backend.repository import SupabaseRepository
        from backend.supabase_store import SupabaseStore
        config = config or Config.from_env()
        auth = auth or SupabaseAuth(config.supabase_url, config.supabase_anon_key)
        if store_factory is None:
            def store_factory(session):
                return SupabaseStore(SupabaseRepository(config.supabase_url, config.supabase_anon_key, session))

    app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
    # Always revalidate the page's files so a new version shows up on refresh.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    if config is not None and config.trust_proxy:
        # Render terminates HTTPS in front of the app and says so in X-Forwarded-*.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    cookie_secure = None if config is None else config.cookie_secure
    hosts = LOCAL_HOSTS if config is None else config.hosts
    the_date = today or _request_today

    # ------------------------------------------------------------ sessions

    def set_session_cookies(response, session):
        secure = request.is_secure if cookie_secure is None else cookie_secure
        lifetime = max(int(session.expires_at - datetime.now(timezone.utc).timestamp()), 60)
        for name, value, max_age in ((ACCESS_COOKIE, session.access_token, lifetime),
                                     (REFRESH_COOKIE, session.refresh_token, REFRESH_COOKIE_DAYS * 86400)):
            response.set_cookie(name, value, max_age=max_age, path=COOKIE_PATH,
                                secure=secure, httponly=True, samesite="Lax")

    def clear_session_cookies(response):
        for name in (ACCESS_COOKIE, REFRESH_COOKIE):
            response.delete_cookie(name, path=COOKIE_PATH)

    def current_session():
        """The signed-in user's session, renewing it if its access token ran out."""
        session, renewed = auth.resume(request.cookies.get(ACCESS_COOKIE), request.cookies.get(REFRESH_COOKIE))
        if renewed:
            g.renewed_session = session
        return session

    # ------------------------------------------------------------ every request

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.before_request
    def guard():
        if not request.path.startswith("/api/"):
            return None
        if request.method not in READ_METHODS and _from_another_site(hosts):
            return _error("forbidden_origin", "Changes are only accepted from Raft's own page.", 403)
        if request.path.startswith(ACCOUNT_ROUTES) or request.path == HEALTH_ROUTE:
            return None
        g.session = current_session()
        g.store = store_factory(g.session)
        return None

    @app.after_request
    def finish(response):
        renewed = g.pop("renewed_session", None)
        if renewed is not None:
            set_session_cookies(response, renewed)
        if g.pop("signed_out", False):
            clear_session_cookies(response)
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @app.errorhandler(er.TrackerError)
    def tracker_error(exc):
        if isinstance(exc, er.NotSignedInError):
            g.signed_out = True         # cookies that no longer work are cleared
        return _error(exc.code, str(exc), STATUS_CODES.get(exc.code, 500), getattr(exc, "fields", None))

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return _error(exc.name.lower().replace(" ", "_"), exc.description, exc.code)

    @app.errorhandler(Exception)
    def unexpected(exc):
        # Logged here without the request's headers or body (they hold tokens and
        # passwords); the user gets a plain message, never the details.
        log.error("Unexpected error on %s %s: %s", request.method, request.path, type(exc).__name__)
        return _error("server_error", "Something went wrong in Raft. Nothing was saved. Try again.", 500)

    # For the host's health check: the app is up. It asks nothing of Supabase
    # and says nothing about anyone.
    @app.get(HEALTH_ROUTE)
    def health():
        return jsonify({"app": "raft", "ok": True})

    # ------------------------------------------------------------ accounts

    @app.get("/api/auth/session")
    def session_info():
        session = current_session()
        return jsonify({"user": session.public()})

    @app.post("/api/auth/register")
    def register():
        email, password, name = _registration(_json_object())
        session = auth.sign_up(email, password, name)
        if session is None:
            return jsonify({"confirmation_required": True,
                            "message": "Check your email and open the link we sent, then sign in."}), 201
        g.renewed_session = session
        return jsonify({"user": session.public()}), 201

    @app.post("/api/auth/login")
    def login():
        body = _json_object()
        email = str(body.get("email") or "").strip()
        password = body.get("password") if isinstance(body.get("password"), str) else ""
        if not email or not password:
            raise er.InvalidUpdateError({"email": "Enter your email and password."})
        session = auth.sign_in(email, password)
        g.renewed_session = session
        return jsonify({"user": session.public()})

    @app.post("/api/auth/logout")
    def logout():
        try:
            session, _ = auth.resume(request.cookies.get(ACCESS_COOKIE), request.cookies.get(REFRESH_COOKIE))
            auth.sign_out(session)
        except er.TrackerError:
            pass        # already signed out, or Supabase unreachable: the cookies go either way
        g.signed_out = True
        return jsonify({"signed_out": True})

    # ------------------------------------------------------------ the tracker

    @app.get("/api/status")
    def status():
        found = dict(g.store.status())
        found.setdefault("modified", found.get("workbook_modified"))
        # The page needs the user's date to know which days are still to come.
        return jsonify({**found, "today": the_date().isoformat(), "user": g.session.public()})

    @app.get("/api/months")
    def list_months():
        return jsonify(g.store.list_months())

    @app.get("/api/months/<int:year>/<int:month>")
    def get_month(year, month):
        return jsonify(g.store.get_month(year, month))

    @app.get("/api/months/<int:year>/<int:month>/analytics")
    def get_month_analytics(year, month):
        return jsonify(month_analytics(g.store.get_month(year, month), the_date()))

    @app.put("/api/months/<int:year>/<int:month>/days/<int:day>")
    def update_day(year, month, day):
        return jsonify(g.store.update_day(year, month, day, _json_fields(), the_date()))

    @app.put("/api/months/<int:year>/<int:month>/measurements/<int:day>")
    def update_measurements(year, month, day):
        return jsonify(g.store.update_measurements(year, month, day, _json_fields(), the_date()))

    @app.post("/api/months")
    def create_month():
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or "year" not in body or "month" not in body:
            return _error("invalid_request", 'Send JSON with "year" and "month".', 400)
        return jsonify(g.store.create_month(body["year"], body["month"])), 201

    @app.delete("/api/months/<int:year>/<int:month>")
    def delete_month(year, month):
        # Deleting a month cannot be undone, so the request has to name the
        # month it means, the way the page does after the user has confirmed.
        body = request.get_json(silent=True)
        name = month_label(year, month) if 1 <= month <= 12 else None
        if name is not None and (not isinstance(body, dict) or body.get("confirm") != name):
            return _error("invalid_request", f'Send JSON with "confirm" set to "{name}" to delete that month.', 400)
        return jsonify(g.store.delete_month(year, month))

    return app


if __name__ == "__main__":
    from backend.config import ConfigError, port
    try:
        application = create_app()
    except ConfigError as problem:
        raise SystemExit(str(problem))
    application.run(host=HOST, port=port(PORT))
