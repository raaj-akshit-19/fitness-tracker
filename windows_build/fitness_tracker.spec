# -*- mode: python ; coding: utf-8 -*-
# PyInstaller recipe for "Fitness Tracker.exe". Use windows_build/build.py to run it.
#
# What goes in:   the Python runtime, Flask, openpyxl, pywin32 (to read the
#                 workbook from Excel while Excel has it open), the backend
#                 package and the page files in frontend/.
# What stays out: Fitness_Tracker.xlsx. The workbook is never packed into the
#                 program; it is an ordinary file beside the .exe.

from pathlib import Path

ROOT = Path(SPECPATH).parent

analysis = Analysis(
    [str(ROOT / "windows_build" / "app_entry.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[(str(ROOT / "frontend"), "frontend")],
    # pywin32 loads this by name when it hands over a date from Excel.
    hiddenimports=["win32timezone"],
    # Not used by the app; leaving them out keeps the program smaller.
    excludes=["tkinter", "_tkinter", "setuptools", "pkg_resources", "_distutils_hack"],
    noarchive=False,
)

archive = PYZ(analysis.pure)

exe = EXE(
    archive,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="Fitness Tracker",
    console=True,       # the window shows the address and any problem
    upx=False,
    debug=False,
    strip=False,
)
