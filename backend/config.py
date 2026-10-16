"""Settings, from the environment.

Locally they can sit in a .env file in the project folder (never committed;
see .env.example). On Render they are set in the service's environment. A
value already in the environment always wins over the file.

    SUPABASE_URL        the project's URL, https://<project>.supabase.co
    SUPABASE_ANON_KEY   the project's public (anon) key
    RAFT_TRUST_PROXY    1 behind a proxy that sets X-Forwarded-* (Render does)
    RAFT_COOKIE_SECURE  1 to send the session cookies over HTTPS only
                        (default: on whenever the request came in over HTTPS)
    RAFT_ALLOWED_HOSTS  the host names Raft is served at, comma separated.
                        127.0.0.1 and localhost always are, and so is the
                        host name Render gives the service (RENDER_EXTERNAL_HOSTNAME).
    PORT                where to listen (Render sets it; 5000 locally)

The service-role key is not used anywhere: every database request is made as
the signed-in user, so the database's own row level security applies to it.
"""

import os
from dataclasses import dataclass
from pathlib import Path

from backend.paths import APP_DIR


LOCAL_HOSTS = ("127.0.0.1", "localhost")


def allowed_hosts():
    """The host names a request that changes something may be addressed to."""
    hosts = list(LOCAL_HOSTS)
    for name in os.environ.get("RAFT_ALLOWED_HOSTS", "").split(",") + [os.environ.get("RENDER_EXTERNAL_HOSTNAME", "")]:
        name = name.strip().lower()
        if name and name not in hosts:
            hosts.append(name)
    return tuple(hosts)


class ConfigError(Exception):
    """A setting is missing. The message says which, and where to set it."""


def load_env_file(path=None):
    """Read KEY=value lines from a .env file into the environment, without overriding."""
    path = Path(path) if path else APP_DIR / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _flag(name):
    value = os.environ.get(name, "").strip().lower()
    return None if value == "" else value in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    supabase_url: str
    supabase_anon_key: str
    trust_proxy: bool = False
    cookie_secure: object = None        # True, False, or None for "when the request is HTTPS"
    hosts: tuple = LOCAL_HOSTS

    @classmethod
    def from_env(cls):
        load_env_file()
        url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
        key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
        missing = [name for name, value in (("SUPABASE_URL", url), ("SUPABASE_ANON_KEY", key)) if not value]
        if missing:
            raise ConfigError(
                f"Raft needs {' and '.join(missing)} to reach its Supabase project. "
                "Set them in the environment, or copy .env.example to .env and fill them in."
            )
        if not url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
            raise ConfigError("SUPABASE_URL must be the project's https:// address.")
        return cls(supabase_url=url, supabase_anon_key=key, trust_proxy=bool(_flag("RAFT_TRUST_PROXY")),
                   cookie_secure=_flag("RAFT_COOKIE_SECURE"), hosts=allowed_hosts())


def port(default=5000):
    try:
        return int(os.environ.get("PORT", default))
    except ValueError:
        return default
