# Raft

Raft is a personal fitness tracker that runs in the browser. Each person signs
in with their own account and sees only their own months. The data is kept in
a Supabase project (PostgreSQL), where row level security keeps every user's
rows apart.

    browser  <->  Flask API (on Render)  <->  Supabase Auth + PostgreSQL (row level security)

An earlier desktop edition, a Windows program that keeps everything in an
Excel workbook on your own computer, is still here: see
[Desktop edition](#desktop-edition-windows-excel).

## What it does

- **Your own account.** Create an account with an email address, a password
  and a display name, then sign in. You stay signed in across visits until you
  sign out. There is no other way to sign in, and no sharing.
- **Enter and edit on the page.** Today, or any day that has passed, has an
  Edit button: exercise, junk food, cardio, calories, protein and weight
  lifted. Each Sunday has its own Edit for body measurements. Nothing is saved
  until Save is pressed.
- **Analytics for the selected month only.** Habit completion and streaks,
  calories and protein, cardio, weight lifted, Monday to Sunday weeks, and
  Sunday-to-Sunday measurement changes, with simple charts. Nothing is
  combined across months.
- **Made for a phone first.** Each day is a block with its own Edit button on
  a narrow screen and a row of a table on a wide one. The same page, the same
  look, from 320 px wide up.
- **Live refresh.** A change saved on another device shows up within a few
  seconds, without a reload, and never overwrites what is being typed in an
  open editor.
- **Plain about problems.** When Raft cannot be reached, the page says so,
  keeps showing the last data that loaded, and keeps what was typed in an
  editor. Nothing is saved twice or behind your back.

## How to use

1. Open Raft's address. Choose "Create an account", enter a display name, your
   email, and a password of at least 8 characters, twice. (If the project asks
   for email confirmation, open the link in the email, then sign in.)
2. Use "+ Add New Month" to create your first month.
3. Press "Edit today", or Edit on any day, fill in what you did, and press
   Save. Cancel or Escape throws the changes away. The daily tracker shows
   five days at a time, with today in the middle; Earlier and Later move to
   the days before and after.
4. Use Edit on a Sunday to enter body measurements.
5. Use Select Month to look at a different month.
6. Use "Delete Month" to remove one. You choose the month and are asked to
   confirm first. Everything entered in it is removed from your account,
   which cannot be undone. The last month cannot be deleted.
7. "Sign out", at the top, ends the session on that device.

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
pending until it is entered. Days in the future cannot be edited, and
measurements belong to Sundays only.

## Setting up Supabase

Raft needs one Supabase project. The free plan is enough.

1. Create a project at supabase.com.
2. Create the tables, their rules and their row level security: open the
   project's SQL Editor, paste the whole of
   `supabase/migrations/20261015000000_initial_schema.sql`, and run it. (With
   the Supabase CLI linked to the project, `supabase db push` does the same.)
   Later changes to the schema come as new files in `supabase/migrations/`,
   applied in name order.
3. Under Authentication > Sign In / Providers, keep **Email** on and every
   other provider off. Choose whether new accounts must confirm their email;
   Raft handles both.
4. Under Authentication > URL Configuration, set the Site URL to Raft's
   address (for example `https://raft.onrender.com`), so confirmation emails
   link back to it.
5. From Project Settings > API, copy the **Project URL** and the **anon
   public** key. These are Raft's two settings.

Raft never uses the service-role key, which gets past row level security.
Do not give it to Raft, and do not put it in this repository, in `.env`, or
in Render's settings.

## Running it locally

Needs Python 3.13.

    python -m venv .venv
    .venv\Scripts\python -m pip install -r requirements.txt
    copy .env.example .env

Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`, then:

    .venv\Scripts\python -m backend.app

and open http://127.0.0.1:5000. `.env` is never committed (`.gitignore`
keeps it out); `.env.example` lists the names with placeholders only.

### A local Supabase, for development and tests

`supabase/local/` holds a small Docker setup with the same parts as a
Supabase project: PostgreSQL, the auth server and the REST layer, behind one
address. It applies the migrations in `supabase/migrations/`. Needs Docker.

    .venv\Scripts\python supabase\local\stack.py up      start it, apply the migrations
    .venv\Scripts\python supabase\local\stack.py env     print the two settings that point Raft at it
    .venv\Scripts\python supabase\local\stack.py down    stop it and throw its data away

New accounts there are confirmed straight away, and any email it sends stays
inside Docker. Its signing secret is a fixed, public test value: it is for
this computer only. Its database is also open on `127.0.0.1:54322` for
looking at the tables directly.

## Deploying on Render

`render.yaml` describes the service: a free Python web service that installs
`requirements.txt`, starts `gunicorn wsgi:app` on Render's `$PORT`, and
checks `/api/health`.

1. Push the repository to GitHub.
2. In Render, choose New > Blueprint and pick the repository. Render reads
   `render.yaml`.
3. When asked, enter `SUPABASE_URL` and `SUPABASE_ANON_KEY`. They are marked
   `sync: false`, so they live only in Render's settings, never in the file.
4. Deploy. The address is `https://<service name>.onrender.com`; set it as the
   Site URL in Supabase (step 4 above).

Render adds its own host name to the hosts Raft accepts. For a custom domain,
set `RAFT_ALLOWED_HOSTS` too. `autoDeploy` is off: deploy from Render's page
when you choose to.

On the free plans (as of writing), a Render service sleeps after a while
without visits and takes up to a minute to wake, and a Supabase project that
sees no use for a week is paused until it is resumed from its dashboard.

### Settings

| Name | Needed | What it is |
| --- | --- | --- |
| `SUPABASE_URL` | yes | The project URL, `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | yes | The project's anon public key |
| `RAFT_TRUST_PROXY` | on Render | `1` behind a proxy that sets `X-Forwarded-*` (Render does) |
| `RAFT_COOKIE_SECURE` | on Render | `1` sends the session cookies over HTTPS only |
| `RAFT_ALLOWED_HOSTS` | no | Extra host names Raft is served at, comma separated |
| `PORT` | no | Where to listen; Render sets it, 5000 locally |
| `PYTHON_VERSION` | on Render | Set in `render.yaml` |

Without the two required settings Raft does not start, and says which is
missing.

## How accounts and data are kept safe

- **The database keeps users apart.** Every table has row level security on,
  with policies that let a signed-in user read and change only rows whose
  `user_id` is their own (`auth.uid() = user_id`). Signed-out requests can
  read nothing.
- **Raft asks the database as the user.** Every request to Supabase carries
  the signed-in user's own access token, so those policies apply to Raft
  itself. Only the public anon key is configured.
- **Identity comes only from the session.** The API never takes a user id
  from the browser: not from the address, the body or a header. A body naming
  a field the API does not know, `user_id` included, is refused.
- **The session is out of the page's reach.** The access and refresh tokens
  live in HttpOnly, SameSite=Lax cookies for `/api` only (Secure on HTTPS).
  The page's script never sees them, and they are never in a response body.
  An expired access token is renewed quietly with the refresh token.
- **Changes come only from Raft's own page.** A request that would change
  anything, sign-in included, is refused when it comes from another site.
- **Errors say what to do, not what broke.** The database's own messages,
  tokens and passwords are never shown or logged.

## Development

### Layout

    wsgi.py                     the web edition as gunicorn serves it
    render.yaml                 the Render service
    .env.example                the settings' names, with placeholders
    supabase/migrations/        the database schema, row level security and its rules
    supabase/local/             a local stand-in for a Supabase project (Docker), for development and tests
    backend/app.py              the HTTP API and the page's files
    backend/config.py           settings from the environment or .env
    backend/auth.py             accounts and sessions, through Supabase Auth
    backend/repository.py       reading and writing the signed-in user's rows, through Supabase's REST layer
    backend/supabase_store.py   months, days and measurements over the repository: the service layer
    backend/supabase_http.py    the one place that talks HTTP to Supabase (standard library only)
    backend/errors.py           the errors the API answers with, and the checks on an edit
    backend/months.py           month names, labels and dates
    backend/validation.py       what each field may hold
    backend/analytics.py        statistics for one month
    backend/paths.py            where the page files (and the desktop edition's workbook) are
    backend/desktop.py          the desktop edition: the same API over the workbook
    backend/launch.py           the desktop edition's startup
    backend/store.py            the desktop edition's workbook store
    backend/workbook.py         the workbook's sheet layout
    backend/excel_live.py       reads the saved workbook from Excel when Excel holds the file
    backend/create_workbook.py  makes a new, empty workbook; refuses to overwrite one
    backend/migrate.py          run by hand only: converts a workbook kept in an earlier five-column layout
    frontend/index.html         the page
    frontend/styles.css         all styling
    frontend/format.js          shared formatting and element helpers
    frontend/analytics.js       the analytics sections and their charts
    frontend/app.js             signing in, loading, month selection, polling, today and the two tables
    frontend/editor.js          the day editor and the measurement editor
    tests/                      automated checks
    requirements.txt            the web edition's Python dependencies (Flask, gunicorn)
    requirements-desktop.txt    the same plus openpyxl and pywin32, for the desktop edition
    requirements-build.txt      the desktop edition's plus PyInstaller, for building the .exe

### API

Every route under `/api/` except the account routes and the health check
needs a signed-in session.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/auth/register` | Create an account. Body: `email`, `password`, `confirm`, `display_name`. Signs in, or says the email must be confirmed first |
| POST | `/api/auth/login` | Sign in. Body: `email`, `password` |
| POST | `/api/auth/logout` | Sign out on this device |
| GET | `/api/auth/session` | Who is signed in |
| GET | `/api/health` | The app is up (for the host's health check) |
| GET | `/api/status` | When this user's data last changed, today's date, and who is signed in |
| GET | `/api/months` | This user's months |
| GET | `/api/months/<year>/<month>` | Daily rows and Sunday measurements for one month |
| GET | `/api/months/<year>/<month>/analytics` | Analytics for that one month |
| POST | `/api/months` | Create a month. Body: `{"year": 2026, "month": 11}` |
| DELETE | `/api/months/<year>/<month>` | Delete a month with all its entries. Body names it: `{"confirm": "November 2026"}` |
| PUT | `/api/months/<year>/<month>/days/<day>` | Save one day's fields |
| PUT | `/api/months/<year>/<month>/measurements/<day>` | Save one Sunday's measurements |

The page sends the user's own date in an `X-Raft-Today` header; the server
takes it when it is within a day of its own date in UTC, so "today" is the
user's today.

Errors come back as `{"error": {"code": "...", "message": "..."}}`, with a
`fields` entry naming each field that was refused.

| Code | Meaning |
| --- | --- |
| `invalid_request` | The body is not JSON, or a field holds something it may not |
| `invalid_month` | Year or month is not a valid whole number in range |
| `not_signed_in` | No session, or it has ended |
| `invalid_credentials` | The email and password do not match an account |
| `email_not_confirmed` | The account's email has not been confirmed yet |
| `account_exists` | An account with that email already exists |
| `too_many_requests` | Too many attempts; wait and try again |
| `month_not_found` | No such month for this user |
| `day_not_found` | No such day, a day in the future, or not a Sunday |
| `month_exists` | That month already exists |
| `last_month` | It is the user's only month, so it cannot be deleted |
| `forbidden_origin` | The request did not come from Raft's own page |
| `service_unavailable` | Supabase could not be reached; nothing was saved |

### Analytics

`backend/analytics.py` turns one month's data into statistics. It uses only
that month and today's date. The page never recalculates it:
`frontend/analytics.js` only formats the figures and draws them. The charts
are plain SVG built in that file; there is no chart library and nothing is
loaded from another site.

- Exercise: Completed counts 1, Partial 0.5 and Missed 0. A Rest Day is left
  out of the count. A streak is extended by Completed, left as it is by a
  Rest Day, and ended by Partial or Missed.
- Junk Food: None counts 1, Controlled 0.5 and Had 0. A streak is extended
  by None.
- A past day left blank is missed. Today left blank, and every day still to
  come, is pending and left out of every count, percentage and streak.
- Weeks run Monday to Sunday and are cut at the edges of the month.
- An empty entry is no entry, not zero. Averages are taken over the days that
  have an entry.
- Streaks start fresh each month. A measurement is compared with the Sunday
  immediately before it in the same month.

### Tests

    .venv\Scripts\python -m pip install -r requirements-desktop.txt
    .venv\Scripts\python -m unittest discover -s tests -v

- `tests/test_cloud.py` runs the web edition against a stand-in for Supabase
  in memory: accounts and sessions, users kept apart, refusals, Supabase
  being unreachable, and the same answers as the desktop edition gives for
  the same months.
- `tests/test_supabase_stack.py` runs it against the local Supabase (see
  above), with the real migrations and row level security, and tries to get
  at another user's rows directly. It is skipped when the local stack is not
  running.
- The frontend tests in `tests/frontend/` run the real page scripts under
  Node against the real backend's answers. They need no packages; without
  Node they are skipped.
- The desktop edition's tests need `Fitness_Tracker.xlsx` in the project
  folder (copy the template) and never write to it. Some start Microsoft
  Excel in the background or run the built `.exe`; they are skipped when
  Excel is not installed or the `.exe` has not been built.

## Desktop edition (Windows, Excel)

The desktop edition runs entirely on one Windows computer, with no account
and no internet connection, and keeps everything in an Excel workbook,
`Fitness_Tracker.xlsx`, one sheet per month.

- `release/Fitness Tracker/` holds the built program: double-click
  `Fitness Tracker.exe`, and keep `Fitness_Tracker.xlsx` in the same folder.
  This build is the version made before the web edition and has not been
  rebuilt since.
- From source: install `requirements-desktop.txt`, copy
  `Fitness_Tracker_Template.xlsx` to `Fitness_Tracker.xlsx`, and double-click
  `Start Fitness Tracker.bat`. It listens on `127.0.0.1` only, on port 5000
  or the next free one up to 5010 (`FITNESS_TRACKER_PORT` or `--port` choose
  one). `FITNESS_TRACKER_WORKBOOK` points it at another workbook.
- To build the `.exe` again: install `requirements-build.txt`, then run
  `windows_build\build.py`.
- Each month sheet holds two Excel tables, `Daily_YYYY_MM` from A1 and
  `Measurements_YYYY_MM` from J1. A sheet laid out any other way is reported
  as `workbook_format` and never changed.
- While Excel has the workbook open the page cannot save, and says so; what
  was typed stays in the editor. Saves made in Excel show up on the page.
  For a workbook in a OneDrive folder, the saved contents are read from
  Excel itself (`backend/excel_live.py`), which never changes anything.
- The backend rewrites the whole file when it saves, through a checked
  temporary copy. Keep charts and images out of the workbook. Back it up from
  time to time: it holds all of your data.
