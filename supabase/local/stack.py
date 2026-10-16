"""Start and stop the local stand-in for a Supabase project (development and tests).

    python supabase/local/stack.py up       start it and apply every migration
    python supabase/local/stack.py down     stop it and throw its data away
    python supabase/local/stack.py env      print the settings that point Raft at it

Needs Docker. The deployed app never uses this: it talks to a real Supabase
project, set up from the same migrations in supabase/migrations/.
"""

import base64
import hashlib
import hmac
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MIGRATIONS = HERE.parent / "migrations"
URL = "http://127.0.0.1:54321"
JWT_SECRET = "local-jwt-secret-for-tests-only-0123456789abcdef"     # matches docker-compose.yml


def compose(*args, input=None, check=True):
    return subprocess.run(["docker", "compose", "-f", str(HERE / "docker-compose.yml"), *args],
                          input=input, capture_output=True, text=True, check=check)


def signed_token(claims):
    """A token with these claims, signed with the local stack's secret (for tests)."""
    def part(data):
        return base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).rstrip(b"=")
    head_body = part({"alg": "HS256", "typ": "JWT"}) + b"." + part(claims)
    signature = base64.urlsafe_b64encode(hmac.new(JWT_SECRET.encode(), head_body, hashlib.sha256).digest()).rstrip(b"=")
    return (head_body + b"." + signature).decode()


def anon_key():
    """The local stack's public key: a token for the anon role, signed with its secret."""
    now = int(time.time())
    return signed_token({"role": "anon", "iss": "supabase-local", "iat": now, "exp": now + 10 * 365 * 86400})


def wait_for(url, what, timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3):
                return
        except urllib.error.HTTPError:
            return          # it answered
        except OSError:
            time.sleep(1)
    raise SystemExit(f"The local {what} did not start within {timeout} seconds.")


def up():
    compose("up", "-d", "db", "mail", "auth")
    # The auth server makes its own tables in the auth schema when it starts;
    # the migrations refer to them, so they run once it is ready.
    for _ in range(120):
        if compose("exec", "-T", "db", "psql", "-U", "postgres", "-tAc",
                   "select to_regclass('auth.users') is not null", check=False).stdout.strip() == "t":
            break
        time.sleep(1)
    else:
        raise SystemExit("The local auth server did not make its tables.")
    applied = compose("exec", "-T", "db", "psql", "-U", "postgres", "-tAc",
                      "select to_regclass('public.months') is not null", check=False).stdout.strip() == "t"
    if not applied:
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            result = compose("exec", "-T", "db", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q",
                             input=migration.read_text(encoding="utf-8"), check=False)
            if result.returncode != 0:
                raise SystemExit(f"{migration.name} failed:\n{result.stderr}")
            print(f"applied {migration.name}")
    compose("up", "-d", "rest", "gateway")
    wait_for(f"{URL}/auth/v1/health", "auth server")
    wait_for(f"{URL}/rest/v1/", "REST layer")
    print(f"local Supabase stand-in ready at {URL}")


def down():
    compose("down", "-v", "--remove-orphans")
    print("local Supabase stand-in stopped and its data removed")


def env():
    print(f"SUPABASE_URL={URL}")
    print(f"SUPABASE_ANON_KEY={anon_key()}")


if __name__ == "__main__":
    {"up": up, "down": down, "env": env}.get(sys.argv[1] if len(sys.argv) > 1 else "", lambda: print(__doc__))()
