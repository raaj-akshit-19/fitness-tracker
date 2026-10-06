# Raft

Raft is a personal fitness tracker for Windows that runs entirely on your own
computer. You enter each day on a page in your browser; everything is kept in
an Excel workbook beside the program. Nothing is sent anywhere.

    page in your browser  <->  local Python/Flask backend  <->  Fitness_Tracker.xlsx

## What it does

- **One application.** `Fitness Tracker.exe` is the whole program. It needs
  no Python and no internet connection.
- **Enter and edit on the page.** Today, or any day that has passed, has an
  Edit button: exercise, junk food, cardio, calories, protein and weight
  lifted. Each Sunday has its own Edit for body measurements. Nothing is
  written until Save is pressed.
- **The workbook holds the data.** All of it lives in `Fitness_Tracker.xlsx`,
  one sheet per month. It can also be typed into in Excel.
- **Analytics for the selected month only.** Habit completion and streaks,
  calories and protein, cardio, weight lifted, Monday to Sunday weeks, and
  Sunday-to-Sunday measurement changes, with simple charts. Nothing is
  combined across months.
- **Made for a phone-sized window first.** Each day is a block with its own
  Edit button on a narrow screen and a row of a table on a wide one. The same
  page, the same look.
- **Live refresh.** When the workbook is saved in Excel, the page updates by
  itself within a few seconds, without a reload.
- **Local only.** A small Python/Flask server listens on `127.0.0.1`. There is
  no cloud service, account, database or external request. The frontend is
  plain HTML, CSS and JavaScript with no libraries.

## Requirements and limits

- Windows. It is built and tested for local use on Windows only.
- A browser. It was tested in Microsoft Edge.
- Microsoft Excel is not needed. If you do open the workbook in Excel, the
  page cannot save into it until Excel has closed it.
- Days in the future cannot be edited. Measurements belong to Sundays only.
- The `.exe` is not signed, so Windows may show a "Windows protected your PC"
  notice the first time it runs.

## How to use

1. Open `release/Fitness Tracker/` and double-click `Fitness Tracker.exe`. A
   window opens and stays open.
2. Your browser opens the dashboard by itself.
3. Press "Edit today", or Edit on any day, fill in what you did, and press
   Save. Cancel or Escape throws the changes away.
4. Use Edit on a Sunday to enter body measurements.
5. Use Select Month to look at a different month.
6. Use "+ Add New Month" to create a month.
7. When you are finished, close that window. That stops the tracker.

What each entry is:

| Entry | Values |
| --- | --- |
| Exercise | Completed, Partial, Rest Day or Missed |
| Junk Food | None, Controlled or Had |
| Cardio | minutes and seconds, typed as min:sec, for example `25:30` |
| Calories | kcal for the day, a whole number |
| Protein | grams for the day |
| Weight Lifted | one number in kg for the whole day |
| Measurements | weight in kg and five sizes in cm, on Sundays |

A field left blank is not entered, which is different from zero. For
Exercise and Junk Food, a past day left blank counts as missed; today stays
pending until it is entered.

## The application folder

`release/Fitness Tracker/` is the application, ready to use or to copy
somewhere else:

    Fitness Tracker.exe      the program
    Fitness_Tracker.xlsx     the workbook (starts clean; it becomes your data)
    How to use.txt           a one-page guide

- Keep `Fitness_Tracker.xlsx` in the same folder as the program. The folder
  can be moved or renamed, as long as the two stay together.
- Keep the Fitness Tracker window open while you use the dashboard.
- Back up `Fitness_Tracker.xlsx` from time to time, for example by copying it
  to another drive. It holds all of your data. The program only changes what
  you save from the dashboard and never replaces the workbook with a new one.
- To keep your own data out of the repository, copy the `Fitness Tracker`
  folder somewhere else and use it from there.

The program uses port 5000, or the next free one up to 5010 with a note in
the window, and a second start just reopens the browser. If something is
wrong, for example the workbook is missing or damaged, the window says what
and stays open until Enter is pressed.

## Workbook

Each month is its own sheet, named like `October 2026`. A sheet holds two
Excel tables:

| Table | Range starts | Rows | Columns |
| --- | --- | --- | --- |
| `Daily_YYYY_MM` | A1 | one per day of the month | Date, Exercise, Junk Food, Cardio (min:sec), Calories (kcal), Protein (g), Weight Lifted (kg) |
| `Measurements_YYYY_MM` | J1 | one per Sunday of the month | Sunday, Weight (kg), Waist (cm), Chest (cm), Bicep (cm), Thigh (cm), Forearm (cm) |

- New months start blank.
- Exercise and Junk Food cells have a dropdown of their allowed values, and
  the number cells accept only numbers in range.
- Cardio cells are formatted as text so Excel does not turn `25:30` into a
  time of day.
- A sheet laid out any other way is reported as `workbook_format` and is
  never changed.

## Working alongside Excel

- While the workbook is open in Excel the page cannot save. Save and Add New
  Month then answer with a message to close it in Excel, and the file is left
  untouched. What was typed in the editor stays there to be saved again.
- You can type into the workbook in Excel. Each time it is saved, the
  dashboard updates. Only saved data is ever shown.
- For a workbook in a OneDrive folder, Excel holds the file so that nothing
  else can read it; then the saved contents are read from Excel itself
  (`backend/excel_live.py`, using the pywin32 package). That path only looks:
  it never starts Excel or changes, saves or closes anything.
- The backend rewrites the whole file when it saves: into a temporary file
  beside the workbook, which is checked and then swapped in. Keep charts,
  images and other extras out of this workbook, because they would not
  survive a save.

## Development

The application is the `.exe`. For working on the code, the same program
runs from source:

    python -m venv .venv
    .venv\Scripts\python -m pip install -r requirements.txt
    copy Fitness_Tracker_Template.xlsx Fitness_Tracker.xlsx

then double-click `Start Fitness Tracker.bat`, which runs `backend/launch.py`
with the project's `.venv`. It is a development convenience and is not part
of the application folder. `Fitness_Tracker.xlsx` in the project folder is
your own working copy and is not part of the repository;
`Fitness_Tracker_Template.xlsx` is the clean starting point.

To choose a port, set `FITNESS_TRACKER_PORT` or pass `--port 5050`; a port
chosen this way is never changed. Setting `FITNESS_TRACKER_WORKBOOK` to
another file makes the app, the launcher and the tests use that file.

To build the application again after changing the code:

    .venv\Scripts\python -m pip install -r requirements-build.txt
    .venv\Scripts\python windows_build\build.py

The build uses PyInstaller and makes one `.exe` containing Python, the
libraries, the backend and the page files. The workbook is never packed into
it, and a workbook already in the release folder is left exactly as it is.

### Layout

    release/Fitness Tracker/    the application
    Start Fitness Tracker.bat   runs it from source, for development
    Fitness_Tracker_Template.xlsx   a clean workbook to copy
    Fitness_Tracker.xlsx        your working copy when running from source (not in the repository)
    backend/launch.py           startup: checks, start the server, open the browser
    backend/paths.py            where the workbook and page files are
    backend/app.py              local HTTP API and frontend files (127.0.0.1 only)
    backend/store.py            reads months, creates months, saves days and measurements safely
    backend/validation.py       what each field may hold
    backend/excel_live.py       reads the saved workbook from Excel when Excel holds the file
    backend/analytics.py        statistics for one month
    backend/workbook.py         defines the sheet layout, builds month sheets
    backend/create_workbook.py  makes a new, empty workbook; refuses to overwrite one
    backend/migrate.py          run by hand only: converts a workbook kept in an earlier five-column layout
    frontend/index.html         the page
    frontend/styles.css         all styling
    frontend/format.js          shared formatting and element helpers
    frontend/analytics.js       the analytics sections and their charts
    frontend/app.js             loading, month selection, polling, today and the two tables
    frontend/editor.js          the day editor and the measurement editor
    windows_build/              recipe and script that build the .exe
    tests/                      automated checks
    requirements.txt            Python dependencies (openpyxl, Flask, pywin32)
    requirements-build.txt      the same plus PyInstaller, for building the .exe

### API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/status` | Workbook last-saved time, whether it is locked for writing, and whether Excel has unsaved changes |
| GET | `/api/months` | List the months that exist as sheets |
| GET | `/api/months/<year>/<month>` | Daily rows and Sunday measurements for one month |
| GET | `/api/months/<year>/<month>/analytics` | Analytics for that one month |
| POST | `/api/months` | Create a month. Body: `{"year": 2026, "month": 11}` |
| PUT | `/api/months/<year>/<month>/days/<day>` | Save one day's fields |
| PUT | `/api/months/<year>/<month>/measurements/<day>` | Save one Sunday's measurements |

Errors come back as `{"error": {"code": "...", "message": "..."}}`, with a
`fields` entry naming each field that was refused.

| Code | Meaning |
| --- | --- |
| `invalid_request` | The body is not JSON, or a field holds something it may not |
| `invalid_month` | Year or month is not a valid whole number in range |
| `month_not_found` | No sheet for that month |
| `day_not_found` | No such day, a day in the future, or not a Sunday |
| `month_exists` | That month already has a sheet |
| `workbook_locked` | The workbook is open in Excel or locked |
| `workbook_missing` | Fitness_Tracker.xlsx is not there |
| `workbook_unreadable` | The file is not a readable workbook |
| `workbook_format` | A sheet does not have the expected tables, columns or dates |
| `forbidden_origin` | The request did not come from the tracker's own page |

A cell holding a value of the wrong kind does not fail a read. That field is
returned as null and the cell is described in the month's `issues` list.

### Analytics

`backend/analytics.py` turns one month's data into statistics. It uses only
that month's sheet and today's date. The page never recalculates it:
`frontend/analytics.js` only formats the figures and draws them. The charts
are plain SVG built in that file; there is no chart library and nothing is
loaded from the internet.

- Exercise: Completed counts 1, Partial 0.5 and Missed 0. A Rest Day is left
  out of the count. A streak is extended by Completed, left as it is by a
  Rest Day, and ended by Partial or Missed.
- Junk Food: None counts 1, Controlled 0.5 and Had 0. A streak is extended
  by None.
- A past day left blank is missed. Today left blank, and every day still to
  come, is pending and left out of every count, percentage and streak.
- Weeks run Monday to Sunday and are cut at the edges of the month.
- An empty cell is no entry, not zero. Averages are taken over the days that
  have an entry.
- Streaks start fresh each month. A measurement is compared with the Sunday
  immediately before it in the same month.

### Tests

    .venv\Scripts\python -m unittest discover -s tests -v

The same command also runs the frontend tests in `tests/frontend/` when
Node.js is installed. They run the real frontend scripts under Node against
responses from the real backend for a temporary workbook. They need no
packages; without Node they are skipped.

The tests need `Fitness_Tracker.xlsx` in the project folder (copy the
template). They never write to it. Tests that need an empty workbook or test
data build a temporary one. Some tests start Microsoft Excel in the
background or run the built `.exe` on a spare port with a temporary
workbook; they are skipped when Excel is not installed or the `.exe` has not
been built, and the `.exe` tests are also skipped while it is older than the
source.
