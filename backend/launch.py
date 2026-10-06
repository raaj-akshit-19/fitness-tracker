"""Start the tracker on this computer and open it in the browser.

This is what the packaged "Fitness Tracker.exe" runs, and what
"Start Fitness Tracker.bat" runs from source during development. It only ever
listens on 127.0.0.1, so nothing outside this computer can reach it, and it
needs no internet connection.

    python -m backend.launch [--port N] [--no-browser] [--verbose]

It never creates, converts or resets the workbook. If something is wrong it
says what and stops.
"""

import argparse
import importlib.util
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from backend.paths import APP_DIR, FROZEN

HOST = "127.0.0.1"
DEFAULT_PORT = 5000
FALLBACK_PORTS = range(5001, 5011)
READY_TIMEOUT = 30  # seconds
PROJECT_DIR = APP_DIR
REQUIRED_PACKAGES = {"flask": "Flask", "openpyxl": "openpyxl"}
PAGE_FILES = ("index.html", "styles.css", "format.js", "analytics.js", "app.js", "editor.js")
WINDOW_TITLE = "Fitness Tracker"


class LaunchError(Exception):
    """A problem the person starting the app needs to read."""


def check_dependencies():
    missing = [
        name for module, name in REQUIRED_PACKAGES.items()
        if importlib.util.find_spec(module) is None
    ]
    if not missing:
        return
    if FROZEN:
        raise LaunchError(
            f"This copy of Fitness Tracker is incomplete (missing: {', '.join(missing)}).\n"
            "Replace Fitness Tracker.exe with a fresh copy."
        )
    raise LaunchError(
        f"Python is missing: {', '.join(missing)}.\n"
        f"Install with:\n"
        f'  "{sys.executable}" -m pip install -r "{PROJECT_DIR / "requirements.txt"}"'
    )


def check_page_files(folder):
    """The files the browser needs must all be there."""
    missing = [name for name in PAGE_FILES if not (Path(folder) / name).is_file()]
    if missing:
        raise LaunchError(
            f"Files the dashboard needs are missing: {', '.join(missing)}.\n"
            + ("Replace Fitness Tracker.exe with a fresh copy." if FROZEN
               else f"They belong in:\n  {folder}")
        )


def check_workbook(path):
    path = Path(path)
    if not path.is_file():
        raise LaunchError(
            f"The workbook was not found:\n  {path}\n"
            f"Put Fitness_Tracker.xlsx in this folder and start again:\n  {path.parent}\n"
            "Nothing was created: Fitness Tracker never makes or replaces a workbook."
        )


def check_workbook_opens(path):
    """Read the workbook once, so a damaged or unreadable file is reported now.

    A workbook that is only locked for the moment (open in Excel) is not a
    reason to refuse to start: the dashboard loads it as soon as it can be read.
    """
    from backend.store import TrackerError, TrackerStore, WorkbookLockedError

    try:
        TrackerStore(path).list_months()
    except WorkbookLockedError as error:
        say(f"Note: {error}")
        say()
    except TrackerError as error:
        raise LaunchError(
            f"The workbook could not be opened:\n  {path}\n  {error}\n"
            "If it is open in another program, close it there and start again.\n"
            "Nothing was changed."
        ) from error


def port_is_busy(port):
    """True when something on this computer is already using the port."""
    try:
        with socket.create_connection((HOST, port), timeout=0.5):
            return True
    except OSError:
        pass
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((HOST, port))
    except OSError:
        return True
    finally:
        probe.close()
    return False


def _status(port, timeout):
    """The JSON from this app's status endpoint, or None if it is not this app."""
    url = f"http://{HOST}:{port}/api/status"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            body = json.loads(error.read())
        except ValueError:
            return None
    except (OSError, ValueError):
        return None
    if isinstance(body, dict) and ("workbook_modified" in body or "error" in body):
        return body
    return None


def tracker_is_running(port):
    """True when the program on this port answers like the tracker."""
    return _status(port, timeout=2) is not None


def choose_port(preferred, explicit, fallbacks=FALLBACK_PORTS):
    """Pick the port to listen on.

    Returns (port, already_running, note). The app only ever moves to another
    port on 127.0.0.1, says so in the note, and never when the port was asked
    for explicitly.
    """
    if not port_is_busy(preferred):
        return preferred, False, None
    if tracker_is_running(preferred):
        return preferred, True, None
    if explicit:
        raise LaunchError(
            f"Port {preferred} is already in use by another program on this computer.\n"
            "Close that program, or choose a different port."
        )
    for port in fallbacks:
        if not port_is_busy(port):
            return port, False, (
                f"Port {preferred} is in use by another program, "
                f"so the tracker is using port {port} instead."
            )
        if tracker_is_running(port):
            return port, True, None
    raise LaunchError(
        f"Port {preferred} and ports {fallbacks[0]} to {fallbacks[-1]} are all in use.\n"
        "Close the program using them and start again."
    )


def wait_until_ready(port, timeout=READY_TIMEOUT, keep_waiting=lambda: True):
    """Ask the status endpoint until the server answers. True once it does."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and keep_waiting():
        if _status(port, timeout=1) is not None:
            return True
        time.sleep(0.2)
    return False


def _open(url, open_browser, enabled):
    if not enabled:
        return
    if not open_browser(url):
        say(f"The browser did not open by itself. Open this address in it: {url}")


def say(message=""):
    print(message, flush=True)


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def _parse(argv):
    parser = argparse.ArgumentParser(description="Start the Fitness Tracker on this computer.")
    parser.add_argument("--port", type=int, default=None,
                        help=f"port on {HOST} (default {DEFAULT_PORT})")
    parser.add_argument("--no-browser", action="store_true", help="do not open the browser")
    parser.add_argument("--verbose", action="store_true", help="print every request")
    parser.add_argument("--excel-status", action="store_true",
                        help="say what Excel reports about the workbook, then stop")
    args = parser.parse_args(argv)
    if args.port is None and os.environ.get("FITNESS_TRACKER_PORT"):
        try:
            args.port = int(os.environ["FITNESS_TRACKER_PORT"])
        except ValueError:
            parser.error("FITNESS_TRACKER_PORT must be a number.")
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("The port must be between 1024 and 65535.")
    return args


def excel_status(path):
    """One line of JSON: whether Excel can be asked, and what it says about the workbook."""
    from backend import excel_live
    from backend import workbook as wbk

    found = excel_live.inspect(path, read=True)
    report = {"reader_available": excel_live.AVAILABLE, "state": found.state, "detail": found.detail}
    if found.workbook is not None:
        report["sheets"] = found.workbook.sheetnames
        report["months"] = [wbk.sheet_name(year, month) for year, month in wbk.list_months(found.workbook)]
    return json.dumps(report)


def main(argv=None, open_browser=webbrowser.open):
    args = _parse(argv)
    if args.excel_status:
        from backend.workbook import WORKBOOK_PATH
        say(excel_status(WORKBOOK_PATH))
        return 0
    say("Fitness Tracker")
    say()
    try:
        check_dependencies()
        # Imported only now, so a missing package gives the message above.
        from werkzeug.serving import make_server

        from backend.app import FRONTEND_DIR, create_app
        from backend.workbook import WORKBOOK_PATH

        check_page_files(FRONTEND_DIR)
        check_workbook(WORKBOOK_PATH)
        check_workbook_opens(WORKBOOK_PATH)
        if os.name == "nt" and importlib.util.find_spec("pythoncom") is None:
            say("Note: the pywin32 package is not installed, so the workbook cannot be read")
            say("while Excel has it open from a OneDrive folder. Install the requirements again.")
            say()
        explicit = args.port is not None
        port, already_running, note = choose_port(args.port or DEFAULT_PORT, explicit)
        url = f"http://{HOST}:{port}/"
        if already_running:
            say(f"The tracker is already running at {url}")
            say("Opening it in the browser. This window can be closed.")
            _open(url, open_browser, not args.no_browser)
            return 0
        logging.getLogger("werkzeug").setLevel(logging.INFO if args.verbose else logging.WARNING)
        if args.verbose:
            logging.basicConfig(level=logging.INFO, format="%(message)s")
        try:
            server = make_server(HOST, port, create_app(WORKBOOK_PATH), threaded=True)
        except (OSError, SystemExit) as error:
            raise LaunchError(f"The server could not start on {url}\n  {error}") from error
    except LaunchError as error:
        say(str(error))
        return 1

    if note:
        say(note)
    say(f"Workbook: {WORKBOOK_PATH}")
    say(f"Address:  {url}  (this computer only)")
    say()

    result = {"code": 0}

    def open_when_ready():
        if wait_until_ready(port):
            say("Ready. Opening the dashboard in the browser.")
            say("Keep this window open while you use the tracker.")
            say("To stop the tracker, close this window.")
            _open(url, open_browser, not args.no_browser)
        else:
            say(f"The server did not answer within {READY_TIMEOUT} seconds, so it was stopped.")
            result["code"] = 1
            server.shutdown()

    # Ctrl+Break stops the server the same way Ctrl+C does.
    if hasattr(signal, "SIGBREAK") and threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGBREAK, _interrupt)
    threading.Thread(target=open_when_ready, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    say()
    say("Stopped.")
    return result["code"]


def run(argv=None):
    """Entry point of the packaged application, started by a double-click.

    A window opened by a double-click closes the moment the program ends, so
    when something went wrong the message stays up until a key is pressed.
    """
    interactive = sys.stdin is not None and sys.stdin.isatty()
    if FROZEN and os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW(WINDOW_TITLE)
        except (OSError, AttributeError):
            pass
    try:
        code = main(argv)
    except SystemExit as stop:      # wrong command-line option
        code = stop.code if isinstance(stop.code, int) else 1
    except Exception as error:      # anything unforeseen: say it, do not just vanish
        say(f"Fitness Tracker stopped because of an unexpected problem:\n  {error!r}")
        code = 1
    if code != 0:
        say()
        say("Fitness Tracker did not start.")
    if interactive:
        if code != 0:
            try:
                input("\nPress Enter to close this window. ")
            except (EOFError, KeyboardInterrupt):
                pass
        else:
            time.sleep(2)   # long enough to read the last line
    return code


if __name__ == "__main__":
    sys.exit(main())
