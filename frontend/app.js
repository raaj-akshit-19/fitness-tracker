"use strict";

// The tracker's one page. Every value shown comes from the local backend;
// nothing is computed or filled in here. Days and Sunday measurements are
// changed through the editors in editor.js, which send them to the backend.

const POLL_MS = 3000;

const MEASUREMENT_FIELDS = [
  "weight_kg", "waist_cm", "chest_cm", "bicep_cm", "thigh_cm", "forearm_cm",
];
const FIELD_LABELS = {
  exercise: "Exercise",
  junk_food: "Junk Food",
  cardio: "Cardio",
  calories_kcal: "Calories",
  protein_g: "Protein",
  weight_lifted_kg: "Weight Lifted",
  weight_kg: "Weight",
  waist_cm: "Waist",
  chest_cm: "Chest",
  bicep_cm: "Bicep",
  thigh_cm: "Thigh",
  forearm_cm: "Forearm",
};

// Daily tracker columns: [heading, class, label]. On a phone each day is shown
// as a block, and every value carries the label.
const DAY_COLUMNS = [["Date"], ["Exercise", "", "Exercise"], ["Junk Food", "", "Junk Food"],
  ["Cardio (min:sec)", "num", "Cardio"], ["Calories (kcal)", "num", "Calories"],
  ["Protein (g)", "num", "Protein (g)"], ["Weight Lifted (kg)", "num", "Lifted (kg)"],
  ["Edit", "action"]];
// The cells of a day. A day still to come with nothing in any of them is shown
// as its date alone.
const DAY_FIELDS = ["exercise", "junk_food", "cardio_display", "calories_kcal", "protein_g", "weight_lifted_kg"];
// The mark that goes with each status, as in the analytics.
const STATUS_MARKS = {
  Completed: "completed", Partial: "partial", "Rest Day": "rest", Missed: "missed",
  None: "completed", Controlled: "partial", Had: "missed",
};
const ISSUES_HELP = "Correct these in Excel and save, or replace the value with Edit on that row. "
  + "They are shown as unreadable, not guessed.";
// What a figure or a table row is known by, so a quiet refresh can tell which ones changed.
const FIGURE_KEYS = ["section", "habit", "stat", "week", "measure", "field", "date", "row"];
// Sunday measurement columns.
const MEASUREMENT_COLUMNS = [["Sunday"], ["Weight (kg)", "num"], ["Waist (cm)", "num"], ["Chest (cm)", "num"],
  ["Bicep (cm)", "num"], ["Thigh (cm)", "num"], ["Forearm (cm)", "num"], ["Edit", "action"]];
const SAVED_NOTE_MS = 8000;

const $ = (id) => document.getElementById(id);
const els = {
  status: $("workbook-status"),
  select: $("month-select"),
  addButton: $("add-month"),
  notice: $("notice"),
  empty: $("empty"),
  view: $("month-view"),
  title: $("month-title"),
  bar: $("month-bar"),
  barMonth: $("bar-month"),
  nav: $("section-nav"),
  todayStrip: $("today-strip"),
  trackerSection: $("section-tracker"),
  sundaySection: $("section-sunday"),
  issuesHelp: $("issues-help"),
  savedNote: $("saved-note"),
  daysTable: $("days-table"),
  daysHead: $("days-head"),
  daysBody: $("days-body"),
  issues: $("issues"),
  issuesList: $("issues-list"),
  measureSavedNote: $("measure-saved-note"),
  measurementsTable: $("measurements-table"),
  measurementsHead: $("measurements-head"),
  measurementsBody: $("measurements-body"),
  analyticsBody: $("analytics-body"),
  dialog: $("add-dialog"),
  form: $("add-form"),
  newMonth: $("new-month"),
  newYear: $("new-year"),
  addError: $("add-error"),
  addSubmit: $("add-submit"),
  addCancel: $("add-cancel"),
};

const state = {
  months: [],
  selected: null,   // {year, month} the selector is on
  shown: null,      // {year, month, label} of the data on screen
  data: null,       // the month on screen, as the backend gave it
  analytics: null,  // its analytics, as the backend gave them
  shownToday: null, // the date that month was drawn for
  today: null,      // the backend's date, as YYYY-MM-DD
  editButtons: {},  // the Edit button of each day on screen, by date
  measureButtons: {},   // the Edit button of each Sunday on screen, by date
  todayButton: null,    // the Edit today button, when today is in the month on screen
  editOrigin: "row",    // where the day editor was opened from: "row" or "today"
  enterTurn: "",        // see drawIn
  currentLink: null,    // the section link the window is on
  modified: null,   // workbook_modified of the data currently on screen
  day: null,        // calendar day the analytics on screen were worked out for
  loadId: 0,
};

const savedFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

class ApiError extends Error {
  constructor(code, message, fields) {
    super(message);
    this.code = code;
    this.fields = fields || null;   // for a refused edit: what is wrong with each field
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { cache: "no-store", ...options });
  } catch {
    throw new ApiError(
      "backend_unavailable",
      "Cannot reach the local backend (start it with: python -m backend.app)."
    );
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body === null) {
    const error = body && body.error;
    throw new ApiError(
      error ? error.code : "unexpected_response",
      error ? error.message : `The backend gave an unexpected response (${response.status}).`,
      error ? error.fields : null
    );
  }
  return body;
}

function sameMonth(a, b) {
  return Boolean(a && b) && a.year === b.year && a.month === b.month;
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
}

function clearNotice() {
  els.notice.hidden = true;
  els.notice.textContent = "";
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function cardioCell(day) {
  if (day.cardio_seconds !== null) return cell(day.cardio_display, "num");
  if (day.cardio_display !== null) return cell(day.cardio_display, "num unreadable");
  return cell(EMPTY, "num blank");
}

function numberCell(value, unreadable) {
  if (unreadable) return cell("Unreadable", "num unreadable");
  if (typeof value !== "number") return cell(EMPTY, "num blank");
  return cell(numberFormat.format(value), "num");
}

// A status as it is shown: its mark, then the word the workbook
// holds. The mark is the one the analytics use, so a status looks the same
// everywhere and is never told by its colour alone. A past day left blank has
// the mark of a day that was not entered.
function statusParts(value, past) {
  const markClass = value === null ? (past ? "unentered" : "") : STATUS_MARKS[value];
  return [
    make("span", { class: `mark ${markClass}`.trim(), attrs: { "aria-hidden": "true" } }),
    value === null ? "Not entered" : value,
  ];
}

function statusCell(value, unreadable, past) {
  if (unreadable) return cell("Unreadable", "unreadable");
  const td = document.createElement("td");
  td.className = value === null ? "status blank" : "status";
  if (value !== null) td.dataset.status = value.toLowerCase().replace(" ", "-");
  td.append(...statusParts(value, past));
  return td;
}

// The Edit button of a row. what names the row for a screen reader, open is
// what the button does, and buttons is where it is kept so focus can return to it.
function editCell(date, today, what, open, buttons) {
  const future = Boolean(today) && date > today;
  const button = make("button", {
    class: "secondary small",
    text: "Edit",
    attrs: {
      type: "button",
      "aria-label": future ? `Edit ${what}: not available until that day` : `Edit ${what}`,
    },
  });
  if (future) {
    button.disabled = true;
    button.setAttribute("title", "Days in the future cannot be edited yet.");
  }
  button.addEventListener("click", open);
  buttons[date] = button;
  const td = document.createElement("td");
  td.className = "action";
  td.append(button);
  return td;
}

function dayCells(day, data, today, unreadable) {
  const bad = (field) => unreadable.has(`${day.date} ${field}`);
  const past = Boolean(today) && day.date < today;
  return [
    statusCell(day.exercise, bad("exercise"), past),
    statusCell(day.junk_food, bad("junk_food"), past),
    cardioCell(day),
    numberCell(day.calories_kcal, bad("calories_kcal")),
    numberCell(day.protein_g, bad("protein_g")),
    numberCell(day.weight_lifted_kg, bad("weight_lifted_kg")),
    editCell(day.date, today, dayFormat.format(parseDay(day.date)),
      () => openDay(day, data, "row"), state.editButtons),
  ];
}

function openDay(day, data, origin) {
  state.editOrigin = origin;
  openEditor(day, data);
}

// Today's entries, first on the page of the month they belong to: what the
// workbook holds for today, and the way to change it.
function renderToday(data, today, unreadable) {
  const day = data.days.find((entry) => entry.date === today);
  state.todayButton = null;
  // The link to today is offered only in the month that holds today.
  els.nav.dataset.today = day ? "yes" : "no";
  if (!day) {
    els.todayStrip.hidden = true;
    els.todayStrip.replaceChildren();
    return;
  }
  const bad = (field) => unreadable.has(`${day.date} ${field}`);
  const item = (field, label, className, ...content) =>
    make("div", { class: "today-item", data: { field } },
      make("dt", { text: label }),
      make("dd", { class: `value ${className}`.trim() }, ...content));
  // shown is the text to show, or null when nothing is entered.
  const plain = (field, label, shown, isBad) => item(field, label,
    isBad ? "unreadable" : shown === null ? "blank" : "",
    ...(isBad ? ["Unreadable"] : shown === null ? ["Not entered"] : unitParts(shown)));
  const amount = (value, unit) =>
    typeof value === "number" ? `${numberFormat.format(value)} ${unit}` : null;
  const cardio = plain("cardio", "Cardio",
    day.cardio_seconds !== null ? day.cardio_display : null,
    day.cardio_seconds === null && day.cardio_display !== null);

  const status = (field, label) => bad(field)
    ? plain(field, label, null, true)
    : item(field, label, day[field] === null ? "blank" : "", ...statusParts(day[field], false));
  const items = [
    status("exercise", "Exercise"),
    status("junk_food", "Junk Food"),
    cardio,
    plain("calories_kcal", "Calories", amount(day.calories_kcal, "kcal"), bad("calories_kcal")),
    plain("protein_g", "Protein", amount(day.protein_g, "g"), bad("protein_g")),
    plain("weight_lifted_kg", "Weight Lifted", amount(day.weight_lifted_kg, "kg"), bad("weight_lifted_kg")),
  ];

  const label = dayFormat.format(parseDay(day.date));
  // The same editor as the daily tracker's, opened on today.
  const button = make("button", {
    text: "Edit today",
    attrs: { type: "button", id: "edit-today", "aria-label": `Edit today, ${label}` },
  });
  button.addEventListener("click", () => openDay(day, data, "today"));
  state.todayButton = button;
  els.todayStrip.replaceChildren(
    make("div", { class: "today-head" },
      make("span", { class: "today-kicker", text: "Today" }),
      make("span", { class: "today-date", text: label })),
    make("dl", { class: "today-items" }, ...items),
    button);
  els.todayStrip.hidden = false;
}

// today is the backend's date, used only to point out today's row.
function renderMonth(data, today) {
  els.title.textContent = data.label;
  const unreadable = new Set(data.issues.map((issue) => `${issue.date} ${issue.field}`));
  const flagged = new Set(data.issues.map((issue) => issue.date));
  // A day, or a Sunday, that has not come yet and has nothing in it.
  const stillBlank = (date, record, fields) => Boolean(today) && date > today
    && !flagged.has(date) && fields.every((field) => record[field] === null);
  state.data = data;
  state.shownToday = today;
  state.editButtons = {};
  state.measureButtons = {};
  els.barMonth.textContent = data.label;
  renderToday(data, today, unreadable);

  els.daysHead.replaceChildren(...DAY_COLUMNS.map(([heading, className]) => {
    const th = make("th", { text: heading, attrs: { scope: "col" } });
    if (className) th.className = className;
    return th;
  }));

  els.daysBody.replaceChildren(...data.days.map((day) => {
    const date = parseDay(day.date);
    const tr = document.createElement("tr");
    tr.dataset.date = day.date;
    const dateCell = cell(dayFormat.format(date));
    const classes = [];
    if (date.getUTCDay() === 1) classes.push("week-start");
    if (day.date === today) {
      classes.push("today");
      dateCell.append(make("span", { class: "tag", text: "Today" }));
    }
    if (stillBlank(day.date, day, DAY_FIELDS)) classes.push("upcoming");
    tr.className = classes.join(" ");
    const cells = dayCells(day, data, today, unreadable);
    cells.forEach((td, index) => {
      const label = DAY_COLUMNS[index + 1][2];
      if (label) td.dataset.label = label;
    });
    tr.append(dateCell, ...cells);
    return tr;
  }));

  // The measurement table has a row for each Sunday and for no other day, so
  // only a Sunday can be given to the measurement editor.
  els.measurementsHead.replaceChildren(...MEASUREMENT_COLUMNS.map(([heading, className]) => {
    const th = make("th", { text: heading, attrs: { scope: "col" } });
    if (className) th.className = className;
    return th;
  }));
  els.measurementsBody.replaceChildren(...data.measurements.map((row) => {
    const tr = document.createElement("tr");
    const label = dayFormat.format(parseDay(row.sunday));
    tr.dataset.date = row.sunday;
    if (stillBlank(row.sunday, row, MEASUREMENT_FIELDS)) tr.className = "upcoming";
    tr.append(cell(label));
    MEASUREMENT_FIELDS.forEach((field, index) => {
      const td = numberCell(row[field], unreadable.has(`${row.sunday} ${field}`));
      td.dataset.label = MEASUREMENT_COLUMNS[index + 1][0];
      tr.append(td);
    });
    tr.append(editCell(row.sunday, today, `measurements for ${label}`,
      () => openMeasurementEditor(row, data), state.measureButtons));
    return tr;
  }));

  els.issuesList.replaceChildren(...data.issues.map((issue) => {
    const li = document.createElement("li");
    const label = FIELD_LABELS[issue.field] || issue.field;
    li.textContent =
      `${dayFormat.format(parseDay(issue.date))}, ${label}: ` +
      `found "${issue.value}". ${issue.message}`;
    return li;
  }));
  els.issuesHelp.textContent = ISSUES_HELP;
  els.issues.hidden = data.issues.length === 0;

  els.empty.hidden = true;
  els.view.hidden = false;
}

// ---------------------------------------------------------------- quiet updates and motion

function isFigure(node) {
  const tag = node.tagName.toLowerCase();
  return node.classList.contains("value")
    || (tag === "td" && "stat" in node.dataset)
    || (tag === "tr" && "date" in node.dataset);
}

// Every figure and table row under root, named by where it is: its section,
// habit, week and so on. The same figure has the same name after a redraw.
function figures(root) {
  const found = new Map();
  const walk = (node, path) => {
    if (typeof node === "string" || !node.dataset) return;
    const here = FIGURE_KEYS.filter((key) => key in node.dataset)
      .map((key) => `${key}=${node.dataset[key]}`).join(",");
    const where = here ? `${path}/${here}` : path;
    if (isFigure(node)) {
      let name = where;
      for (let copy = 2; found.has(name); copy++) name = `${where}#${copy}`;
      found.set(name, node);
    }
    for (const child of node.children) walk(child, where);
  };
  walk(root, "");
  return found;
}

function figureTexts(root) {
  return new Map([...figures(root)].map(([name, node]) => [name, node.textContent]));
}

// After a save or a refresh has redrawn root: tint, once, the figures and rows
// that now read differently. Nothing else on the page moves.
function markChanges(before, root) {
  for (const [name, node] of figures(root)) {
    if (before.has(name) && before.get(name) !== node.textContent) node.classList.add("changed");
  }
}

// A month arriving on screen is drawn in once: when the page opens and when
// the user goes to another month. The sections of that one load are marked;
// the ones a later refresh builds are not, so a refresh never replays this.
// The three parts that stay on the page take turns with two names for the
// same movement, which is what makes it play again for the next month.
function drawIn(sections) {
  // A "Saved" line left over from the month before does not belong to this one.
  els.savedNote.hidden = true;
  els.measureSavedNote.hidden = true;
  state.enterTurn = state.enterTurn === "a" ? "b" : "a";
  for (const part of [els.todayStrip, els.trackerSection, els.sundaySection]) {
    part.dataset.enter = state.enterTurn;
  }
  for (const section of sections) section.classList.add("reveal");
}

// The bar of section links: how tall it is (sections stop below it), whether
// it has reached the top of the window, and which section the window is on.
function trackBar() {
  if (!document.documentElement) return;
  const bar = els.bar.getBoundingClientRect();
  if (bar.height === 0) return;
  document.documentElement.style.setProperty("--bar", `${Math.round(bar.height)}px`);
  els.bar.classList.toggle("stuck", bar.top <= 0 && els.title.getBoundingClientRect().bottom < 0);
  let current = null;
  let first = null;
  for (const link of els.nav.children) {
    const target = document.getElementById(link.getAttribute("href").slice(1));
    if (!target || link.offsetParent === null) continue;
    first = first || link;
    // The section that has reached the bar; at the very end of the page, the last one.
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atEnd || target.getBoundingClientRect().top <= bar.bottom + 40) current = link;
  }
  // At the top of the page nothing has reached the bar yet: the first area is the one in view.
  current = current || first;
  for (const link of els.nav.children) {
    if (link === current) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }
  // On a phone the links are one row that scrolls: keep the current one in view. Whether
  // the row glides there or jumps is the stylesheet's to say (see reduced motion).
  if (current && current !== state.currentLink && els.nav.scrollWidth > els.nav.clientWidth) {
    els.nav.scrollTo({ left: current.offsetLeft - els.nav.offsetLeft });
  }
  state.currentLink = current;
}

// After a save: read the analytics of the month on screen again, once, and
// show them without drawing anything in. If this fails the saved row stays as
// it is and the next poll brings the analytics up to date.
async function refreshAnalytics() {
  const shown = state.shown;
  const loadId = state.loadId;
  if (!shown || !state.data) return;
  try {
    const analytics = await api(`/api/months/${shown.year}/${shown.month}/analytics`);
    // A whole load that started in the meantime has the newer picture.
    if (loadId !== state.loadId || !sameMonth(state.shown, shown)) return;
    const sections = buildAnalytics(analytics);
    const before = figureTexts(els.analyticsBody);
    els.analyticsBody.replaceChildren(...sections);
    state.analytics = analytics;
    markChanges(before, els.analyticsBody);
    trackBar();
  } catch (error) {
    if (!(error instanceof ApiError)) console.error(error);
  }
}

// The charts are drawn either for a phone or for a wider window. When the
// window goes from one to the other, the analytics in hand are built again
// for its new width. Nothing is fetched and nothing is drawn in.
function redrawCharts() {
  if (!state.analytics) return;
  els.analyticsBody.replaceChildren(...buildAnalytics(state.analytics));
  trackBar();
}

// Redraw the two tables from the month in hand after a save, tinting what changed.
function redrawAfterSave() {
  const before = figureTexts(els.view);
  renderMonth(state.data, state.shownToday);
  markChanges(before, els.view);
  refreshAnalytics();
}

const noteTurns = new Map();

// Show a short confirmation in one of the note lines, and take it away after a while.
function showSavedNote(note, message) {
  const turn = (noteTurns.get(note) || 0) + 1;
  noteTurns.set(note, turn);
  note.textContent = message;
  note.hidden = false;
  setTimeout(() => {
    if (noteTurns.get(note) === turn) note.hidden = true;
  }, SAVED_NOTE_MS);
}

function focusButton(button) {
  if (button && button.focus) button.focus();
}

// The editor saved a day: show the record the backend returned at once, and
// ask for the month's analytics again, without reloading the page.
// changes holds the fields that were sent, which the backend has now checked.
function daySaved(result, changes) {
  const date = result.day.date;
  if (state.data && sameMonth(state.data, result)) {
    const index = state.data.days.findIndex((day) => day.date === date);
    if (index !== -1) state.data.days[index] = result.day;
    state.data.issues = state.data.issues.filter((issue) =>
      issue.date !== date || !(issue.field in changes));
    redrawAfterSave();
  }
  showSavedNote(els.savedNote, `Saved: ${dayFormat.format(parseDay(date))} was written to the workbook.`);
  focusDayButton(date);
}

function dayUnchanged(date) {
  showSavedNote(els.savedNote,
    `Nothing was changed for ${dayFormat.format(parseDay(date))}, so nothing was saved.`);
  focusDayButton(date);
}

// Back to the button the day editor was opened with: Edit today, or the row's own.
function focusDayButton(date) {
  focusButton(state.editOrigin === "today" && state.todayButton ? state.todayButton : state.editButtons[date]);
}

// The same for a Sunday's measurements.
function measurementSaved(result, changes) {
  const date = result.measurement.sunday;
  if (state.data && sameMonth(state.data, result)) {
    const index = state.data.measurements.findIndex((row) => row.sunday === date);
    if (index !== -1) state.data.measurements[index] = result.measurement;
    state.data.issues = state.data.issues.filter((issue) =>
      issue.date !== date || !(issue.field in changes));
    redrawAfterSave();
  }
  showSavedNote(els.measureSavedNote,
    `Saved: measurements for ${dayFormat.format(parseDay(date))} were written to the workbook.`);
  focusButton(state.measureButtons[date]);
}

function measurementUnchanged(date) {
  showSavedNote(els.measureSavedNote,
    `Nothing was changed for ${dayFormat.format(parseDay(date))}, so nothing was saved.`);
  focusButton(state.measureButtons[date]);
}

function renderMonthOptions() {
  els.select.replaceChildren(...state.months.map((month) => {
    const option = document.createElement("option");
    option.value = `${month.year}-${month.month}`;
    option.textContent = month.label;
    option.selected = sameMonth(month, state.selected);
    return option;
  }));
  els.select.disabled = state.months.length === 0;
}

function chooseMonth(preferred) {
  const exists = (wanted) => state.months.find((month) => sameMonth(month, wanted));
  const now = new Date();
  const current = { year: now.getFullYear(), month: now.getMonth() + 1 };
  return exists(preferred) || exists(state.selected) || exists(current)
    || state.months[state.months.length - 1] || null;
}

// Reload the month list and the selected month. Returns true when the screen
// now matches the workbook.
async function reload(preferred) {
  const loadId = ++state.loadId;
  try {
    const months = await api("/api/months");
    if (loadId !== state.loadId) return false;
    state.months = months;
    state.selected = chooseMonth(preferred);
    renderMonthOptions();

    if (!state.selected) {
      els.view.hidden = true;
      els.empty.hidden = false;
      clearNotice();
      return true;
    }
    // The selected month drives both the tables and the analytics.
    const { year, month } = state.selected;
    const [data, analytics] = await Promise.all([
      api(`/api/months/${year}/${month}`),
      api(`/api/months/${year}/${month}/analytics`),
    ]);
    if (loadId !== state.loadId) return false;
    // Build the analytics first. If anything fails up to here, nothing on the
    // page has been touched and the last good dashboard stays.
    const sections = buildAnalytics(analytics);
    // A month coming onto the screen is drawn in. The same month read again,
    // which is what a poll does, is redrawn quietly: nothing moves, and only
    // the figures that changed are tinted. Either way an open editor keeps
    // what was typed into it.
    const entering = !sameMonth(state.shown, { year, month });
    const before = entering ? null : figureTexts(els.view);
    renderMonth(data, analytics.month.today);
    els.analyticsBody.replaceChildren(...sections);
    state.analytics = analytics;
    if (entering) drawIn(sections);
    else markChanges(before, els.view);
    state.shown = { year, month, label: data.label };
    clearNotice();
    trackBar();
    return true;
  } catch (error) {
    if (loadId !== state.loadId) return false;
    reportFailure(error);
    return false;
  } finally {
    if (loadId === state.loadId) els.view.setAttribute("aria-busy", "false");
  }
}

// Show what went wrong and say what is still on screen. Nothing is cleared.
function reportFailure(error) {
  if (!(error instanceof ApiError)) console.error(error);
  // Forget the timestamp so the next poll tries again.
  state.modified = null;
  let message = error instanceof ApiError
    ? error.message
    : `The page could not display this data (${error.message}).`;
  if (state.shown) {
    const wanted = state.months.find((month) => sameMonth(month, state.selected));
    message = wanted && !sameMonth(wanted, state.shown)
      ? `Could not load ${wanted.label}. ${message} Still showing ${state.shown.label}, the last data that loaded.`
      : `${message} Still showing the last data that loaded for ${state.shown.label}.`;
  }
  showNotice(message);
}

function setStatus(text) {
  if (els.status.textContent !== text) els.status.textContent = text;
}

async function poll() {
  try {
    const status = await api("/api/status");
    state.today = status.today || null;
    const saved = savedFormat.format(new Date(status.workbook_modified));
    setStatus(
      status.unsaved_changes
        ? `Workbook last saved ${saved}. Excel has unsaved changes; showing the last saved data.`
        : status.locked
          ? `Workbook last saved ${saved}. It is open in Excel; changes appear here each time you save.`
          : `Workbook last saved ${saved}.`
    );
    // Reload when the workbook was saved, or when the date has changed, since
    // which days are pending depends on today.
    const day = new Date().toDateString();
    if (status.workbook_modified !== state.modified || day !== state.day) {
      if (await reload()) {
        state.modified = status.workbook_modified;
        state.day = day;
      }
    }
  } catch (error) {
    setStatus("");
    reportFailure(error);
  }
}

async function pollLoop() {
  if (!document.hidden) await poll();
  setTimeout(pollLoop, POLL_MS);
}

els.select.addEventListener("change", () => {
  const [year, month] = els.select.value.split("-").map(Number);
  state.selected = { year, month };
  // Shown only if the month takes a moment to arrive; see the stylesheet.
  els.view.setAttribute("aria-busy", "true");
  reload();
});

els.addButton.addEventListener("click", () => {
  // Suggest the month after the latest existing one, or the current month.
  const last = state.months[state.months.length - 1];
  const now = new Date();
  let year = last ? last.year : now.getFullYear();
  let month = last ? last.month + 1 : now.getMonth() + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  els.newMonth.value = String(month);
  els.newYear.value = String(year);
  els.addError.hidden = true;
  els.dialog.showModal();
});

els.addCancel.addEventListener("click", () => els.dialog.close());

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const wanted = { year: Number(els.newYear.value), month: Number(els.newMonth.value) };
  els.addSubmit.disabled = true;
  els.addError.hidden = true;
  try {
    await api("/api/months", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wanted),
    });
    els.dialog.close();
    await reload(wanted);
  } catch (error) {
    els.addError.textContent = error.message;
    els.addError.hidden = false;
  } finally {
    els.addSubmit.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});

setupTooltip(els.analyticsBody);

// Follow the window as it scrolls, at most once a frame.
if (window.addEventListener) {
  let queued = false;
  const follow = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      trackBar();
    });
  };
  window.addEventListener("scroll", follow, { passive: true });
  window.addEventListener("resize", follow);
}

if (window.matchMedia) window.matchMedia(NARROW).addEventListener("change", redrawCharts);

pollLoop();
