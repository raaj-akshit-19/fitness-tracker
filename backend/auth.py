"""Accounts, through Supabase Auth: register, sign in, keep signed in, sign out.

The browser never sees a token. Flask keeps the user's access and refresh
tokens in two HttpOnly cookies (see app.py), and on every request asks
Supabase who the access token belongs to. Who the user is comes only from
that answer, never from anything the browser sends. When the access token has
run out, the refresh token gets a new pair, which go back in the cookies.
"""

import base64
import hashlib
import json
import threading
import time
from dataclasses import dataclass

from backend import supabase_http
from backend.errors import (
    AccountExistsError, EmailNotConfirmedError, InvalidCredentialsError, InvalidUpdateError,
    NotSignedInError, TooManyRequestsError,
)

# How long Supabase's word on an access token is trusted before asking again.
VERIFY_CACHE_SECONDS = 60
CACHE_LIMIT = 1000


@dataclass(frozen=True)
class Session:
    user_id: str
    email: str
    display_name: str
    access_token: str
    refresh_token: str
    expires_at: float           # when the access token runs out, as a Unix time

    def public(self):
        """What the page may know about the account."""
        return {"email": self.email, "display_name": self.display_name}


def _token_expiry(token):
    """The exp claim of a JWT, read without checking it (only to know when to ask again)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return float(json.loads(base64.urlsafe_b64decode(payload))["exp"])
    except (IndexError, ValueError, KeyError, TypeError):
        return 0.0


def _digest(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SupabaseAuth:
    def __init__(self, supabase_url, anon_key, clock=time.time):
        self.base = f"{supabase_url.rstrip('/')}/auth/v1"
        self.anon_key = anon_key
        self.clock = clock
        self._lock = threading.Lock()
        self._verified = {}     # digest of an access token -> (Session, trusted until)
        self._refreshed = {}    # digest of a refresh token -> (Session, until): two requests at once refresh once

    def _headers(self, token=None):
        return {"apikey": self.anon_key, "Authorization": f"Bearer {token or self.anon_key}"}

    def _session(self, answer, refresh_token=None):
        body = answer.body or {}
        user = body.get("user") or {}
        access = body.get("access_token", "")
        return Session(
            user_id=user.get("id", ""),
            email=user.get("email", ""),
            display_name=(user.get("user_metadata") or {}).get("display_name", ""),
            access_token=access,
            refresh_token=body.get("refresh_token") or refresh_token or "",
            expires_at=float(body.get("expires_at") or _token_expiry(access) or self.clock() + 3600),
        )

    # ------------------------------------------------------------ the four actions

    def sign_up(self, email, password, display_name):
        """Make an account. Returns a Session, or None when the email must be confirmed first."""
        answer = supabase_http.call("POST", f"{self.base}/signup", self._headers(),
                                    {"email": email, "password": password, "data": {"display_name": display_name}})
        if answer.status == 429:
            raise TooManyRequestsError()
        if not answer.ok:
            code, text = answer.error_code(), answer.error_text().lower()
            if code in ("user_already_exists", "email_exists") or "already registered" in text:
                raise AccountExistsError()
            if code == "weak_password" or "password" in text:
                raise InvalidUpdateError({"password": "Choose a longer password: at least 8 characters."})
            if code == "email_address_invalid" or "email" in text:
                raise InvalidUpdateError({"email": "Enter a valid email address."})
            raise InvalidUpdateError({"email": "The account could not be created. Check the details and try again."})
        if not (answer.body or {}).get("access_token"):
            return None         # Supabase wants the address confirmed before the first sign-in
        return self._remember(self._session(answer))

    def sign_in(self, email, password):
        answer = supabase_http.call("POST", f"{self.base}/token?grant_type=password", self._headers(),
                                    {"email": email, "password": password})
        if answer.status == 429:
            raise TooManyRequestsError()
        if not answer.ok:
            code, text = answer.error_code(), answer.error_text().lower()
            if code == "email_not_confirmed" or "not confirmed" in text:
                raise EmailNotConfirmedError()
            raise InvalidCredentialsError()
        return self._remember(self._session(answer))

    def resume(self, access_token, refresh_token):
        """The session behind the cookies: (Session, renewed). renewed means the tokens changed.

        NotSignedInError when there is no session, or it can no longer be renewed.
        """
        now = self.clock()
        if access_token:
            with self._lock:
                known = self._verified.get(_digest(access_token))
            if known and known[1] > now:
                return known[0], False
            if _token_expiry(access_token) > now + 5:
                answer = supabase_http.call("GET", f"{self.base}/user", self._headers(access_token))
                if answer.ok and isinstance(answer.body, dict) and answer.body.get("id"):
                    user = answer.body
                    session = Session(
                        user_id=user["id"], email=user.get("email", ""),
                        display_name=(user.get("user_metadata") or {}).get("display_name", ""),
                        access_token=access_token, refresh_token=refresh_token or "",
                        expires_at=_token_expiry(access_token),
                    )
                    self._remember(session)
                    return session, False
        if not refresh_token:
            raise NotSignedInError()
        return self._refresh(refresh_token), True

    def _refresh(self, refresh_token):
        now = self.clock()
        key = _digest(refresh_token)
        with self._lock:
            done = self._refreshed.get(key)
        if done and done[1] > now:
            return done[0]
        answer = supabase_http.call("POST", f"{self.base}/token?grant_type=refresh_token", self._headers(),
                                    {"refresh_token": refresh_token})
        if not answer.ok or not (answer.body or {}).get("access_token"):
            raise NotSignedInError("Your session has ended. Sign in again.")
        session = self._remember(self._session(answer, refresh_token))
        with self._lock:
            self._refreshed[key] = (session, now + 10)
            self._trim(self._refreshed)
        return session

    def sign_out(self, session):
        """End the session at Supabase (its refresh token stops working). Best effort."""
        with self._lock:
            self._verified.pop(_digest(session.access_token), None)
        if session.access_token:
            try:
                supabase_http.call("POST", f"{self.base}/logout?scope=local", self._headers(session.access_token))
            except Exception:       # signing out locally still works if Supabase cannot be reached
                pass

    # ------------------------------------------------------------ cache

    def _remember(self, session):
        until = min(self.clock() + VERIFY_CACHE_SECONDS, session.expires_at - 5)
        with self._lock:
            self._verified[_digest(session.access_token)] = (session, until)
            self._trim(self._verified)
        return session

    def _trim(self, cache):
        if len(cache) > CACHE_LIMIT:
            now = self.clock()
            for key in [key for key, (_, until) in cache.items() if until <= now]:
                del cache[key]
            while len(cache) > CACHE_LIMIT:
                cache.pop(next(iter(cache)))
