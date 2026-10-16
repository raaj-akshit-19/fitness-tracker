"""The one place that talks HTTP to Supabase. Standard library only.

Nothing here logs a request's headers or body: they carry access tokens and
passwords.
"""

import json
import socket
import urllib.error
import urllib.request

from backend.errors import ServiceUnavailableError

TIMEOUT = 10        # seconds


class Response:
    def __init__(self, status, body, headers):
        self.status = status
        self.body = body
        self.headers = headers

    @property
    def ok(self):
        return 200 <= self.status < 300

    def error_code(self):
        """The machine-readable code Supabase gave for a refusal, if any."""
        if isinstance(self.body, dict):
            return str(self.body.get("error_code") or self.body.get("code") or self.body.get("error") or "")
        return ""

    def error_text(self):
        if isinstance(self.body, dict):
            return str(self.body.get("msg") or self.body.get("message") or self.body.get("error_description") or "")
        return ""


def call(method, url, headers, body=None, timeout=TIMEOUT):
    """Send one request. Supabase being unreachable, or failing, is ServiceUnavailableError."""
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json", "Accept": "application/json", **headers})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return Response(answer.status, _json(answer.read()), dict(answer.headers))
    except urllib.error.HTTPError as answer:
        response = Response(answer.code, _json(answer.read()), dict(answer.headers or {}))
        if answer.code >= 500 or answer.code in (502, 503, 504):
            raise ServiceUnavailableError() from None
        return response
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError):
        raise ServiceUnavailableError() from None


def _json(raw):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
