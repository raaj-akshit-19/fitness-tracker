"""Build the Windows application into release/Fitness Tracker/.

Run from the project root:

    .venv\\Scripts\\python -m pip install -r requirements-build.txt
    .venv\\Scripts\\python windows_build\\build.py

The build happens in a temporary folder. Only the finished program is copied
into the release folder. A workbook already in the release folder is never
replaced, moved or opened: if one is there, it is left exactly as it is. If
there is none, the clean template is copied in. The working workbook in the
project folder holds personal data and is never used for the release.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "windows_build" / "fitness_tracker.spec"
RELEASE = ROOT / "release" / "Fitness Tracker"
EXE_NAME = "Fitness Tracker.exe"
WORKBOOK_NAME = "Fitness_Tracker.xlsx"
TEMPLATE_NAME = "Fitness_Tracker_Template.xlsx"     # clean, no entries
GUIDE_NAME = "How to use.txt"
PAGE_FILES = ["index.html", "styles.css", "format.js", "analytics.js", "app.js", "editor.js"]

GUIDE = """\
FITNESS TRACKER

1. Double-click "Fitness Tracker.exe". A window opens and stays open.
2. Your browser opens the dashboard by itself.
3. Enter your day on the dashboard. Press "Edit today", or Edit on any day's
   row, fill in what you did, and press Save. Each Sunday has its own Edit
   for body measurements. Days in the future cannot be edited yet.
4. Save writes the change into Fitness_Tracker.xlsx. Nothing is written until
   you press Save, and Cancel throws your changes away.
5. Use Select Month on the dashboard to look at another month.
6. Use "+ Add New Month" to create a month.
7. When you are finished, close the Fitness Tracker window. That stops it.

Keep Fitness_Tracker.xlsx in the same folder as Fitness Tracker.exe.
You can move the folder anywhere, as long as the two stay together.

What each entry is:
  Exercise        Completed, Partial, Rest Day or Missed
  Junk Food       None, Controlled or Had
  Cardio          minutes and seconds, typed as min:sec, for example 25:30
  Calories        kcal for the day, a whole number
  Protein         grams for the day
  Weight Lifted   one number in kg for the whole day
  Measurements    weight in kg and five sizes in cm, on Sundays
A field left blank is not entered. For Exercise, a past day left blank counts
as missed; today stays pending until you enter it.

Excel
  You do not need Excel to use the tracker. While the workbook is open in
  Excel the dashboard cannot save: close it in Excel, then press Save again.
  You can also type into the workbook in Excel. Save the workbook and the
  dashboard updates by itself within a few seconds.

BACK UP Fitness_Tracker.xlsx from time to time, for example by copying it to
another drive. It holds all of your data. The program only ever changes what
you save from the dashboard, and never replaces the workbook with a new one.

Everything runs on this computer only. No internet connection is needed.
"""


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def archive_contents(exe):
    """Names of everything packed inside the built program."""
    from PyInstaller.archive.readers import CArchiveReader

    return sorted(CArchiveReader(str(exe)).toc)


def check_contents(exe):
    names = archive_contents(exe)
    lowered = [name.lower().replace("\\", "/") for name in names]
    for page_file in PAGE_FILES:
        if f"frontend/{page_file}" not in lowered:
            raise SystemExit(f"Build problem: frontend/{page_file} is not in the program.")
    workbooks = [name for name in lowered if name.endswith((".xlsx", ".xlsm", ".xls"))]
    if workbooks:
        raise SystemExit(f"Build problem: a workbook was packed into the program: {workbooks}")
    return names


def build(work):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    command = [
        sys.executable, "-m", "PyInstaller", str(SPEC), "--noconfirm", "--clean",
        "--distpath", str(work / "dist"), "--workpath", str(work / "build"),
        "--log-level", "WARN",
    ]
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    return work / "dist" / EXE_NAME


def main():
    try:
        import PyInstaller
    except ImportError:
        raise SystemExit("PyInstaller is not installed. Run:\n"
                         f'  "{sys.executable}" -m pip install -r requirements-build.txt')
    print(f"PyInstaller {PyInstaller.__version__}, Python {sys.version.split()[0]}")

    with tempfile.TemporaryDirectory(prefix="fitness-tracker-build-") as temp:
        built = build(Path(temp))
        names = check_contents(built)
        RELEASE.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copyfile(built, RELEASE / EXE_NAME)
        except PermissionError:
            raise SystemExit("Could not replace the program in the release folder. "
                             "Close Fitness Tracker if it is running and build again.")

    (RELEASE / GUIDE_NAME).write_text(GUIDE, encoding="utf-8", newline="\r\n")

    workbook = RELEASE / WORKBOOK_NAME
    if workbook.exists():
        print(f"Workbook: already in the release folder, left untouched ({workbook.name}).")
    elif (ROOT / TEMPLATE_NAME).exists():
        shutil.copyfile(ROOT / TEMPLATE_NAME, workbook)
        print(f"Workbook: the clean template was copied in as {workbook.name}.")
    else:
        print("Workbook: none found. Put Fitness_Tracker.xlsx beside the program before starting it.")

    exe = RELEASE / EXE_NAME
    print(f"Packed {len(names)} items; page files included; no workbook inside the program.")
    print(f"Release folder: {RELEASE}")
    for path in sorted(RELEASE.iterdir()):
        print(f"  {path.stat().st_size:>12,} bytes  {path.name}")
    print(f"{EXE_NAME} SHA-256: {sha256(exe)}")


if __name__ == "__main__":
    main()
