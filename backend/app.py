"""Local HTTP API over the workbook, plus the frontend files.

Listens on this computer only.

Run from the project root:  python -m backend.app
Then open http://127.0.0.1:5000
"""

from datetime import date

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from backend import store as st
from backend.analytics import month_analytics
from backend.paths import RESOURCE_DIR
from backend.workbook import WORKBOOK_PATH

FRONTEND_DIR = RESOURCE_DIR / "frontend"

HOST = "127.0.0.1"
PORT = 5000

STATUS_CODES = {
    "invalid_request": 400,
    "invalid_month": 400,
    "forbidden_origin": 403,
    "month_not_found": 404,
    "day_not_found": 404,
    "month_exists": 409,
    "workbook_locked": 423,
    "workbook_missing": 500,
    "workbook_unreadable": 500,
    "workbook_format": 500,
}


# Requests that change the workbook are only taken from the tracker's own page.
LOCAL_HOSTS = ("127.0.0.1", "localhost")
READ_METHODS = ("GET", "HEAD", "OPTIONS")


def _error(code, message, status, fields=None):
    error = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return jsonify({"error": error}), status


def _from_another_site():
    """True when a writing request did not come from the tracker's own page.

    A page on some other website can make the browser send requests here. The
    browser says where such a request came from, and that is what is checked.
    """
    if request.host.rsplit(":", 1)[0].lower() not in LOCAL_HOSTS:
        return True
    origin = request.headers.get("Origin")
    if origin is not None and origin != f"{request.scheme}://{request.host}":
        return True
    return request.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")


def _json_fields():
    """The request body, which must be JSON. Its contents are checked by the store."""
    if not request.is_json:
        raise st.InvalidUpdateError({"body": "Send the fields as JSON (Content-Type: application/json)."})
    body = request.get_json(silent=True)
    if body is None:
        raise st.InvalidUpdateError({"body": "The request body is not valid JSON."})
    return body


def create_app(workbook_path=WORKBOOK_PATH, today=date.today):
    app = Flask(__name__, static_folder=str(FRONTEND_DIR), static_url_path="")
    # Always revalidate the frontend files so edits show up on refresh.
    app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
    store = st.TrackerStore(workbook_path)

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.before_request
    def refuse_writes_from_other_sites():
        if request.method not in READ_METHODS and _from_another_site():
            return _error("forbidden_origin",
                          "Changes are only accepted from the tracker's own page.", 403)
        return None

    @app.errorhandler(st.TrackerError)
    def tracker_error(exc):
        return _error(exc.code, str(exc), STATUS_CODES.get(exc.code, 500), getattr(exc, "fields", None))

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return _error(exc.name.lower().replace(" ", "_"), exc.description, exc.code)

    @app.get("/api/status")
    def status():
        # The page needs the backend's date to know which days are still to come.
        return jsonify({**store.status(), "today": today().isoformat()})

    @app.get("/api/months")
    def list_months():
        return jsonify(store.list_months())

    @app.get("/api/months/<int:year>/<int:month>")
    def get_month(year, month):
        return jsonify(store.get_month(year, month))

    @app.get("/api/months/<int:year>/<int:month>/analytics")
    def get_month_analytics(year, month):
        return jsonify(month_analytics(store.get_month(year, month), today()))

    @app.put("/api/months/<int:year>/<int:month>/days/<int:day>")
    def update_day(year, month, day):
        return jsonify(store.update_day(year, month, day, _json_fields(), today()))

    @app.put("/api/months/<int:year>/<int:month>/measurements/<int:day>")
    def update_measurements(year, month, day):
        return jsonify(store.update_measurements(year, month, day, _json_fields(), today()))

    @app.post("/api/months")
    def create_month():
        body = request.get_json(silent=True)
        if not isinstance(body, dict) or "year" not in body or "month" not in body:
            return _error(
                "invalid_request", 'Send JSON with "year" and "month".', 400
            )
        return jsonify(store.create_month(body["year"], body["month"])), 201

    return app


if __name__ == "__main__":
    create_app().run(host=HOST, port=PORT)
