"""Where the app's files are, when run from source and when packaged.

APP_DIR       the folder the user sees. The workbook lives here.
RESOURCE_DIR  where the program's own files (the page files) are.

From source both are the project folder. In the packaged Windows application
APP_DIR is the folder holding the .exe, so the workbook stays an ordinary
file beside it, and RESOURCE_DIR is where the program unpacks itself.
Nothing here depends on the current directory or on any fixed path.
"""

import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))

if FROZEN:
    APP_DIR = Path(sys.executable).resolve().parent
    RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
else:
    APP_DIR = RESOURCE_DIR = Path(__file__).resolve().parent.parent
