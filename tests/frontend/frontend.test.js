"use strict";

// Runs the real frontend scripts against a fake DOM and a fake fetch that
// serves responses produced by the real backend (see tests/test_frontend_js.py,
// which builds the fixture file and starts this suite).
//
// Two workbooks in the fixtures, with today fixed at 20 Oct 2026:
//
// FIXTURES itself (shown by boot()) holds four months:
//   October 2026   exercise, junk food, cardio, weight and measurements entered
//   November 2026  one day entered, one measurement on its first Sunday
//   December 2026  nothing entered
//   January 2027   a cardio entry of 0:00 and a weight entry of 0
//
// FIXTURES.editing (shown by boot({ editing: true })) is the one the editors'
// tests work in; it is described where those tests begin.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FakeDocument, findAll, find, hasClass, hasData, both } = require("./fake_dom");

const FRONTEND = path.join(__dirname, "..", "..", "frontend");
const SCRIPTS = ["format.js", "analytics.js", "app.js", "editor.js"].map((name) => ({
  name, source: fs.readFileSync(path.join(FRONTEND, name), "utf8"),
}));
const FIXTURES = JSON.parse(fs.readFileSync(process.env.FIXTURES, "utf8"));

const settle = async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function respond(server, url) {
  if (server.override && server.override[url]) return server.override[url];
  if (url === "/api/status") return { status: 200, body: server.status };
  if (url === "/api/months") return { status: 200, body: server.months };
  const match = url.match(/^\/api\/months\/(\d+)\/(\d+)(\/analytics)?$/);
  const entry = match && server.data[`${match[1]}-${match[2]}`];
  if (!entry) {
    return { status: 404, body: { error: { code: "month_not_found", message: "No such month." } } };
  }
  if (match[3] && !entry.analytics) {
    return { status: 501, body: { error: { code: "analytics_not_ready", message: "Not available yet." } } };
  }
  return { status: 200, body: match[3] ? entry.analytics : entry.month };
}

// What the backend does with an accepted edit of one day: change those fields
// of that day and answer with the saved record. server.reply, when set, is
// given as the answer instead (a reply, or a function returning one).
function write(server, url, changes) {
  if (server.reply) return typeof server.reply === "function" ? server.reply(url, changes) : server.reply;
  const match = url.match(/^\/api\/months\/(\d+)\/(\d+)\/(days|measurements)\/(\d+)$/);
  const month = server.data[`${match[1]}-${match[2]}`].month;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[4].padStart(2, "0")}`;
  const saved = {};
  if (match[3] === "days") {
    const day = month.days.find((row) => row.date === date);
    for (const [name, value] of Object.entries(changes)) {
      if (name === "cardio") {
        const [minutes, seconds] = value === null ? [] : value.split(":").map(Number);
        day.cardio_display = value;
        day.cardio_seconds = value === null ? null : minutes * 60 + seconds;
      } else {
        day[name] = value;
      }
    }
    saved.day = { ...day };
  } else {
    const row = month.measurements.find((item) => item.sunday === date);
    Object.assign(row, changes);
    saved.measurement = { ...row };
  }
  month.issues = month.issues.filter((issue) => issue.date !== date || !(issue.field in changes));
  server.writes += 1;
  server.status.workbook_modified = `2026-10-20T22:00:${String(server.writes).padStart(2, "0")}`;
  return {
    status: 200,
    body: {
      year: month.year, month: month.month, label: month.label,
      ...saved, workbook_modified: server.status.workbook_modified,
    },
  };
}

// What the backend does with an accepted deletion: the month is gone from the
// list and can no longer be read. It refuses the only month, and a request
// that does not name the month, as the real one does.
function remove(server, url, body) {
  if (server.reply) return typeof server.reply === "function" ? server.reply(url, body) : server.reply;
  const match = url.match(/^\/api\/months\/(\d+)\/(\d+)$/);
  const found = server.months.find((month) => month.year === Number(match[1]) && month.month === Number(match[2]));
  if (!found) return { status: 404, body: { error: { code: "month_not_found", message: "No such month." } } };
  if (!body || body.confirm !== found.label) {
    return { status: 400, body: { error: { code: "invalid_request", message: "Name the month." } } };
  }
  if (server.months.length <= 1) {
    return { status: 409, body: { error: { code: "last_month", message: "It is the only month." } } };
  }
  server.months = server.months.filter((month) => month !== found);
  delete server.data[`${found.year}-${found.month}`];
  server.writes += 1;
  server.status.workbook_modified = `2026-10-20T22:00:${String(server.writes).padStart(2, "0")}`;
  return { status: 200, body: { deleted: found, months: server.months } };
}

const parseDayOfWeek =(iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// boot() starts the page on the four-month workbook; boot({ editing: true }) on
// the editors' one.
async function boot({ editing = false, narrow = null } = {}) {
  const document = new FakeDocument();
  // The parts of index.html that hold one another, nested as they are there.
  const nest = (parent, ...ids) => document.getElementById(parent).append(...ids.map((id) => document.getElementById(id)));
  nest("month-view", "today-strip", "section-tracker", "analytics-body", "section-sunday");
  nest("section-tracker", "days-body");
  nest("section-sunday", "measurements-body");
  document.getElementById("section-tracker").dataset.section = "tracker";
  document.getElementById("section-sunday").dataset.section = "sunday";
  const source = editing ? FIXTURES.editing : FIXTURES;
  const server = {
    months: source.months,
    status: { ...source.status },
    data: structuredClone(source.data),
    down: false,
    override: null,
    reply: null,
    writes: 0,
  };
  const calls = [];       // the address of every read
  const requests = [];    // every request that would change the workbook
  const errors = [];
  let lastReply = null;
  const fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (method === "GET") calls.push(url);
    else requests.push({ method, url, headers: options.headers, body: options.body });
    if (server.down) throw new TypeError("Failed to fetch");
    const reply = method === "GET" ? respond(server, url)
      : method === "DELETE" ? remove(server, url, JSON.parse(options.body))
        : await write(server, url, JSON.parse(options.body));
    if (method !== "GET") lastReply = reply;
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  const media = { matches: narrow === true, listeners: [], queries: [] };
  const window = { innerWidth: narrow ? 375 : 1200 };
  if (narrow !== null) {
    window.matchMedia = (query) => {
      media.queries.push(query);
      return {
        get matches() { return media.matches; },
        addEventListener: (type, handler) => media.listeners.push({ query, type, handler }),
      };
    };
  }
  const context = vm.createContext({
    document, fetch, window, setTimeout: () => 0,
    console: { ...console, error: (...args) => errors.push(args) },
  });
  for (const script of SCRIPTS) vm.runInContext(script.source, context, { filename: script.name });
  await settle();

  let saves = 0;
  const app = {
    document, server, calls, requests, errors, context, media,
    get lastReply() { return lastReply; },
    body: document.getElementById("analytics-body"),
    tracker: document.getElementById("days-body"),
    title: document.getElementById("month-title"),
    notice: document.getElementById("notice"),
    async select(key) {
      const select = document.getElementById("month-select");
      select.value = key;
      select.fire("change");
      await settle();
    },
    async poll() {
      await context.poll();
      await settle();
    },
    // Pretend the workbook was saved, then let the page notice.
    async save() {
      saves += 1;
      server.status.workbook_modified = `2026-10-20T21:00:${String(saves).padStart(2, "0")}`;
      await app.poll();
    },
    section: (name) => find(app.body, hasData("section", name)),
    tile: (name) => value(app.body, name),
  };
  await app.select("2026-10");
  return app;
}

// The text of a figure: the element marked data-stat or data-field, or the
// part of it marked as the value.
function value(root, name) {
  const node = find(root, (n) => n.dataset.stat === name || n.dataset.field === name);
  return node.className.split(/\s+/).includes("value")
    ? node.textContent : find(node, hasClass("value")).textContent;
}

const gridRow = (app, habit) =>
  find(app.section("daily"), (node) => node.tagName === "tr" && node.dataset.habit === habit);
const dayMark = (app, habit, date) =>
  find(find(gridRow(app, habit), (node) => node.tagName === "td" && node.dataset.date === date),
    hasClass("mark"));
const weekRow = (app, number) =>
  find(app.section("weekly"), (node) => node.tagName === "tr" && node.dataset.week === String(number));
const weekCell = (app, number, habit, stat) =>
  find(weekRow(app, number), both(hasData("habit", habit), hasData("stat", stat))).textContent;
const measureCard = (app, key) => find(app.section("measurements"), hasData("measure", key));
// The daily tracker shows five days at a time. A test reaches a day as a user
// does: with Earlier and Later, until that day is one of the five.
function showDay(app, date) {
  const body = app.document.getElementById("days-body");
  const shown = () => body.children.some((row) => row.dataset.date === date);
  for (let presses = 0; presses < 12 && !shown() && body.children.length > 0; presses++) {
    const button = app.document.getElementById(date < body.children[0].dataset.date ? "days-earlier" : "days-later");
    if (button.disabled) break;
    button.fire("click");
  }
}
const trackerRow = (app, date) => {
  showDay(app, date);
  return find(app.tracker, (node) => node.tagName === "tr" && node.dataset.date === date);
};
// Every row of the month on screen, read by going through all of its windows
// and coming back to the one that was showing. Used where a test is about the
// whole month, as the tracker's rows used to be.
function monthRows(app) {
  const body = app.document.getElementById("days-body");
  const earlier = app.document.getElementById("days-earlier"), later = app.document.getElementById("days-later");
  let net = 0;
  for (let i = 0; i < 12 && earlier.disabled === false; i++) { earlier.fire("click"); net -= 1; }
  const rows = new Map(body.children.map((row) => [row.dataset.date, row]));
  for (let i = 0; i < 12 && later.disabled === false; i++) {
    later.fire("click");
    net += 1;
    for (const row of body.children) if (!rows.has(row.dataset.date)) rows.set(row.dataset.date, row);
  }
  for (; net > 0; net--) earlier.fire("click");
  for (; net < 0; net++) later.fire("click");
  return [...rows.values()];
}
const wholeMonth = (app) => {
  const children = monthRows(app);
  return { children, dataset: {}, className: "", tagName: "tbody", textContent: children.map((row) => row.textContent).join("") };
};
const weekTotals = (root, stat) => findAll(root, hasData("stat", stat)).map((cell) => cell.textContent);

// ---------------------------------------------------------------- the day editor
//
// FIXTURES.editing is the editors' workbook, again with today fixed at 20 Oct 2026:
//   October 2026   1 to 4 Oct entered, 5 Oct blank, 6 Oct typed wrongly in Excel;
//                  measurements on its first two Sundays
//   November 2026  nothing entered, every day still to come
// FIXTURES.editing.replies holds what the real backend answered to each kind of
// refused edit, and FIXTURES.editing.edit one accepted edit with its answer.

const EDITING = FIXTURES.editing;
const FIELD_IDS = {
  exercise: "edit-exercise", junk_food: "edit-junk-food", cardio: "edit-cardio",
  calories_kcal: "edit-calories", protein_g: "edit-protein", weight_lifted_kg: "edit-weight",
};
const LOCKED_TEXT = "Close Fitness_Tracker.xlsx in Excel before saving changes. Then click Save again.";

const el = (app, id) => app.document.getElementById(id);
const field = (app, name) => el(app, FIELD_IDS[name]);
const fieldError = (app, name) => el(app, `${FIELD_IDS[name]}-error`);
const editButton = (app, date) => find(trackerRow(app, date), (node) => node.tagName === "button");
const rowText = (app, date) => trackerRow(app, date).children.map((child) => child.textContent);
const editorValues = (app) =>
  Object.fromEntries(Object.keys(FIELD_IDS).map((name) => [name, field(app, name).value]));
const isOpen = (app) => el(app, "edit-dialog").open === true;
const sent = (app) => app.requests.map((request) => JSON.parse(request.body));

function openDay(app, date) {
  editButton(app, date).fire("click");
}

function type(app, entries) {
  for (const [name, text] of Object.entries(entries)) field(app, name).value = text;
}

async function pressSave(app) {
  el(app, "edit-form").fire("submit");
  await settle();
}

test("a month shows its fields as words and numbers, with an Edit column", async () => {
  const app = await boot({ editing: true });
  assert.equal(app.title.textContent, "October 2026");
  assert.deepEqual(el(app, "days-head").children.map((th) => th.textContent), [
    "Date", "Exercise", "Junk Food", "Cardio (min:sec)", "Calories (kcal)", "Protein (g)",
    "Weight Lifted (kg)", "Edit",
  ]);
  assert.ok(el(app, "days-head").children.every((th) => th.tagName === "th" && th.attributes.scope === "col"));
  assert.deepEqual(rowText(app, "2026-10-01"),
    ["Thu 01 Oct", "Completed", "None", "25:30", "2,200", "140.5", "2,450", "Edit"]);
  assert.deepEqual(rowText(app, "2026-10-02"),
    ["Fri 02 Oct", "Partial", "Controlled", "-", "1,800", "-", "-", "Edit"]);
  assert.deepEqual(rowText(app, "2026-10-03").slice(1, 3), ["Rest Day", "Had"]);
  // A recorded zero is a value; a blank cell is not a zero.
  assert.deepEqual(rowText(app, "2026-10-04"), ["Sun 04 Oct", "Missed", "Not entered", "0:00", "0", "0", "0", "Edit"]);
  assert.deepEqual(rowText(app, "2026-10-05"),
    ["Mon 05 Oct", "Not entered", "Not entered", "-", "-", "-", "-", "Edit"]);
  // Cells typed wrongly in Excel are shown as unreadable, not guessed.
  assert.deepEqual(rowText(app, "2026-10-06"),
    ["Tue 06 Oct", "Unreadable", "Not entered", "25:75", "Unreadable", "-", "-", "Edit"]);
  assert.match(rowText(app, "2026-10-20")[0], /^Tue 20 OctToday$/);
  assert.equal(wholeMonth(app).children.length, 31);
  assert.ok(wholeMonth(app).children.every((row) => row.children.length === 8));

  // The table is a display: one Edit button a row, and no inputs or dropdowns in it.
  const controls = findAll(wholeMonth(app), (node) => ["input", "select", "textarea", "button"].includes(node.tagName));
  assert.equal(controls.length, 31);
  assert.ok(controls.every((node) => node.tagName === "button" && node.textContent === "Edit"));
  assert.doesNotMatch(wholeMonth(app).textContent, /\b(true|false|null|undefined|NaN)\b/i);
  assert.equal(findAll(wholeMonth(app), hasClass("box")).length, 0);          // statuses are words with marks, never tick boxes
});

test("a month keeps its two tables, with the editors' notes, above the analytics", async () => {
  const app = await boot({ editing: true });
  assert.ok(app.calls.includes("/api/months/2026/10"));
  assert.equal(app.notice.hidden, true);
  assert.equal(el(app, "month-view").hidden, false);
  // The Sunday measurements are still shown.
  const sundays = el(app, "measurements-body").children;
  assert.deepEqual(sundays.map((row) => row.children[1].textContent), ["72.5", "72", "-", "-"]);
});

test("the dropdowns offer exactly the agreed statuses, and a blank", async () => {
  const app = await boot({ editing: true });
  const options = (name) => field(app, name).children.map((option) => [option.attributes.value, option.textContent]);
  assert.deepEqual(options("exercise"), [
    ["", "Not entered"], ["Completed", "Completed"], ["Partial", "Partial"],
    ["Rest Day", "Rest Day"], ["Missed", "Missed"],
  ]);
  assert.deepEqual(options("junk_food"), [
    ["", "Not entered"], ["None", "None"], ["Controlled", "Controlled"], ["Had", "Had"],
  ]);
  assert.ok(field(app, "exercise").children.every((option) => option.tagName === "option"));
});

test("the editor opens on the chosen day with that day's values", async () => {
  const app = await boot({ editing: true });
  assert.ok(!isOpen(app));
  openDay(app, "2026-10-01");
  assert.ok(isOpen(app));
  assert.match(el(app, "edit-date").textContent, /^Thursday,? 1 October 2026$/);
  assert.deepEqual(editorValues(app), {
    exercise: "Completed", junk_food: "None", cardio: "25:30",
    calories_kcal: "2200", protein_g: "140.5", weight_lifted_kg: "2450",
  });
  assert.equal(el(app, "edit-error").hidden, true);
  assert.equal(el(app, "edit-save").disabled, false);
  assert.equal(el(app, "edit-save").textContent, "Save");
  assert.equal(app.requests.length, 0);
  assert.deepEqual(app.calls.filter((url) => url.includes("/days/")), []);     // filled from what is loaded
});

test("blank values open as empty fields, and a recorded zero as zero", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-05");
  assert.deepEqual(editorValues(app), {
    exercise: "", junk_food: "", cardio: "", calories_kcal: "", protein_g: "", weight_lifted_kg: "",
  });
  el(app, "edit-cancel").fire("click");

  openDay(app, "2026-10-04");
  assert.deepEqual(editorValues(app), {
    exercise: "Missed", junk_food: "", cardio: "0:00", calories_kcal: "0", protein_g: "0", weight_lifted_kg: "0",
  });
  el(app, "edit-cancel").fire("click");

  openDay(app, "2026-10-02");
  assert.deepEqual(editorValues(app), {
    exercise: "Partial", junk_food: "Controlled", cardio: "", calories_kcal: "1800", protein_g: "", weight_lifted_kg: "",
  });
});

test("Cancel closes the editor, sends nothing and discards what was typed", async () => {
  const app = await boot({ editing: true });
  const before = rowText(app, "2026-10-01");
  openDay(app, "2026-10-01");
  type(app, { exercise: "Missed", calories_kcal: "9999", cardio: "1:00" });
  app.calls.length = 0;
  el(app, "edit-cancel").fire("click");
  await settle();
  assert.ok(!isOpen(app));
  assert.equal(app.requests.length, 0);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(rowText(app, "2026-10-01"), before);
  assert.equal(el(app, "saved-note").textContent, "");          // nothing claims to have been saved

  // Opening it again starts from the workbook's values, not from what was thrown away.
  openDay(app, "2026-10-01");
  assert.equal(field(app, "exercise").value, "Completed");
  assert.equal(field(app, "calories_kcal").value, "2200");
  assert.equal(field(app, "cardio").value, "25:30");
});

test("Save sends one PUT to that day with the changed fields as JSON", async () => {
  const app = await boot({ editing: true });
  app.server.reply = EDITING.edit.reply;                 // what the real backend answered to this edit
  openDay(app, "2026-10-02");
  type(app, { exercise: "Completed", cardio: "30:00", calories_kcal: "", protein_g: "120.5" });
  app.calls.length = 0;
  await pressSave(app);

  assert.equal(app.requests.length, 1);
  const request = app.requests[0];
  assert.equal(request.method, "PUT");
  assert.equal(request.url, "/api/months/2026/10/days/2");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), EDITING.edit.request);
  assert.deepEqual(JSON.parse(request.body),
    { exercise: "Completed", cardio: "30:00", calories_kcal: null, protein_g: 120.5 });
  // Junk Food and Weight Lifted were not touched, so they are not sent at all.
  assert.equal("junk_food" in JSON.parse(request.body), false);
  assert.equal(typeof JSON.parse(request.body).protein_g, "number");

  // The saved record replaces the row, the editor closes, and nothing was reloaded.
  assert.ok(!isOpen(app));
  assert.deepEqual(rowText(app, "2026-10-02"),
    ["Fri 02 Oct", "Completed", "Controlled", "30:00", "-", "120.5", "-", "Edit"]);
  assert.deepEqual(app.calls, ["/api/months/2026/10/analytics"]);     // the analytics, once; nothing else is read
  assert.equal(app.title.textContent, "October 2026");
  assert.equal(el(app, "saved-note").hidden, false);
  assert.equal(el(app, "saved-note").textContent, "Saved: Fri 02 Oct was written to the workbook.");
  // Other days are as they were.
  assert.deepEqual(rowText(app, "2026-10-01"),
    ["Thu 01 Oct", "Completed", "None", "25:30", "2,200", "140.5", "2,450", "Edit"]);
  assert.equal(wholeMonth(app).children.length, 31);
});

test("the stand-in backend in these tests answers an edit as the real one does", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-02");
  type(app, { exercise: "Completed", cardio: "30:00", calories_kcal: "", protein_g: "120.5" });
  await pressSave(app);
  assert.deepEqual(app.server.data["2026-10"].month.days[1], EDITING.edit.reply.body.day);
  assert.deepEqual(Object.keys(app.lastReply.body).sort(), Object.keys(EDITING.edit.reply.body).sort());
});

test("only what changed is sent: one field, a cleared field, or nothing at all", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-01");
  type(app, { calories_kcal: "2300" });
  await pressSave(app);
  assert.deepEqual(sent(app), [{ calories_kcal: 2300 }]);
  assert.equal(rowText(app, "2026-10-01")[4], "2,300");

  // Emptying a field clears it in the workbook: null, not zero and not left out.
  openDay(app, "2026-10-01");
  type(app, { cardio: "  ", junk_food: "" });
  await pressSave(app);
  assert.deepEqual(sent(app)[1], { junk_food: null, cardio: null });
  assert.deepEqual(rowText(app, "2026-10-01").slice(1, 4), ["Completed", "Not entered", "-"]);

  // A blank day keeps its other fields blank when one is filled in.
  openDay(app, "2026-10-05");
  type(app, { exercise: "Rest Day" });
  await pressSave(app);
  assert.deepEqual(sent(app)[2], { exercise: "Rest Day" });
  assert.deepEqual(rowText(app, "2026-10-05"), ["Mon 05 Oct", "Rest Day", "Not entered", "-", "-", "-", "-", "Edit"]);

  // Save with nothing changed closes the editor and sends nothing.
  openDay(app, "2026-10-03");
  await pressSave(app);
  assert.equal(app.requests.length, 3);
  assert.ok(!isOpen(app));
  assert.equal(el(app, "saved-note").textContent, "Nothing was changed for Sat 03 Oct, so nothing was saved.");

  // Typing the same value again, with spaces around it, is not a change either.
  openDay(app, "2026-10-01");
  type(app, { calories_kcal: " 2300 " });
  await pressSave(app);
  assert.equal(app.requests.length, 3);
});

test("a value the backend refuses (400) keeps the editor open with what was typed", async () => {
  const app = await boot({ editing: true });
  app.server.reply = EDITING.replies.invalid;
  const before = rowText(app, "2026-10-02");
  openDay(app, "2026-10-02");
  type(app, { exercise: "Completed", cardio: "30:00", calories_kcal: "1900" });
  await pressSave(app);

  assert.ok(isOpen(app));
  assert.equal(app.requests.length, 1);
  assert.deepEqual(editorValues(app), {
    exercise: "Completed", junk_food: "Controlled", cardio: "30:00",
    calories_kcal: "1900", protein_g: "", weight_lifted_kg: "",
  });
  // Each refused field carries the backend's own words.
  const fields = EDITING.replies.invalid.body.error.fields;
  for (const name of ["exercise", "cardio", "calories_kcal"]) {
    assert.equal(fieldError(app, name).hidden, false, name);
    assert.equal(fieldError(app, name).textContent, fields[name], name);
    assert.equal(field(app, name).attributes["aria-invalid"], "true", name);
  }
  assert.equal(fieldError(app, "protein_g").hidden, true);
  assert.equal(field(app, "protein_g").attributes["aria-invalid"], "false");
  assert.equal(el(app, "edit-error").hidden, false);
  assert.match(el(app, "edit-error").textContent, /^Not saved\./);
  assert.deepEqual(rowText(app, "2026-10-02"), before);
  assert.equal(el(app, "edit-save").disabled, false);

  // Correct it and save again: the same editor, a second request.
  app.server.reply = null;
  await pressSave(app);
  assert.equal(app.requests.length, 2);
  assert.ok(!isOpen(app));
  assert.equal(rowText(app, "2026-10-02")[1], "Completed");

  // The marks are gone the next time the editor opens.
  openDay(app, "2026-10-03");
  assert.equal(fieldError(app, "exercise").hidden, true);
  assert.equal(field(app, "exercise").attributes["aria-invalid"], "false");
  assert.equal(el(app, "edit-error").hidden, true);
});

test("a locked workbook (423) asks for Excel to be closed and does not retry by itself", async () => {
  const app = await boot({ editing: true });
  app.server.reply = EDITING.replies.locked;
  assert.equal(EDITING.replies.locked.status, 423);
  openDay(app, "2026-10-02");
  type(app, { calories_kcal: "2000", weight_lifted_kg: "1500.5" });
  await pressSave(app);

  assert.ok(isOpen(app));
  assert.equal(el(app, "edit-error").hidden, false);
  assert.equal(el(app, "edit-error").textContent, LOCKED_TEXT);
  assert.equal(field(app, "calories_kcal").value, "2000");
  assert.equal(field(app, "weight_lifted_kg").value, "1500.5");
  assert.equal(el(app, "edit-save").disabled, false);
  assert.equal(el(app, "edit-cancel").disabled, false);

  // Time passes and the page polls: still one request, still the same editor.
  for (let turn = 0; turn < 3; turn++) await app.poll();
  assert.equal(app.requests.length, 1);
  assert.ok(isOpen(app));
  assert.equal(field(app, "calories_kcal").value, "2000");

  // Excel is closed, and Save is pressed again.
  app.server.reply = null;
  await pressSave(app);
  assert.equal(app.requests.length, 2);
  assert.deepEqual(sent(app)[1], { calories_kcal: 2000, weight_lifted_kg: 1500.5 });
  assert.ok(!isOpen(app));
  assert.deepEqual(rowText(app, "2026-10-02").slice(4), ["2,000", "-", "1,500.5", "Edit"]);
});

test("a month that has gone (404) and other refusals keep the editor open and say why", async () => {
  const app = await boot({ editing: true });
  const cases = [
    [EDITING.replies.missing, EDITING.replies.missing.body.error.message],
    [EDITING.replies.other_layout, EDITING.replies.other_layout.body.error.message],
    [EDITING.replies.future, EDITING.replies.future.body.error.fields.day],
    [{ status: 500, body: { error: { code: "workbook_unreadable", message: "The saved workbook failed verification." } } },
      "The saved workbook failed verification."],
  ];
  assert.equal(EDITING.replies.missing.status, 404);
  assert.equal(EDITING.replies.other_layout.body.error.code, "workbook_format");    // a sheet the tracker did not lay out
  openDay(app, "2026-10-02");
  type(app, { protein_g: "108" });
  for (const [reply, message] of cases) {
    app.server.reply = reply;
    await pressSave(app);
    assert.ok(isOpen(app), message);
    assert.equal(el(app, "edit-error").hidden, false);
    assert.equal(el(app, "edit-error").textContent, message);
    assert.equal(field(app, "protein_g").value, "108");
    assert.equal(el(app, "edit-save").disabled, false);
  }
  // The backend cannot be reached at all.
  app.server.down = true;
  await pressSave(app);
  assert.ok(isOpen(app));
  assert.match(el(app, "edit-error").textContent, /^Cannot reach the local backend/);
  assert.equal(field(app, "protein_g").value, "108");
  assert.equal(app.requests.length, cases.length + 1);
  assert.equal(rowText(app, "2026-10-02")[5], "-");

  app.server.down = false;
  app.server.reply = null;
  await pressSave(app);
  assert.ok(!isOpen(app));
  assert.equal(rowText(app, "2026-10-02")[5], "108");
});

test("pressing Save again while a save is on its way sends nothing more", async () => {
  const app = await boot({ editing: true });
  let release;
  app.server.reply = () => new Promise((resolve) => { release = resolve; });
  openDay(app, "2026-10-02");
  type(app, { exercise: "Completed" });
  el(app, "edit-form").fire("submit");
  await settle();

  assert.equal(app.requests.length, 1);
  assert.equal(el(app, "edit-save").disabled, true);
  assert.equal(el(app, "edit-cancel").disabled, true);
  assert.equal(el(app, "edit-save").textContent, "Saving");
  for (let turn = 0; turn < 3; turn++) {
    el(app, "edit-form").fire("submit");
    el(app, "edit-cancel").fire("click");
    await settle();
  }
  assert.equal(app.requests.length, 1);
  assert.ok(isOpen(app));                              // Cancel does nothing mid-save
  // Escape is held back too, so the answer is not lost.
  let held = false;
  el(app, "edit-dialog").fire("cancel", { preventDefault() { held = true; } });
  assert.equal(held, true);

  app.server.reply = null;
  release({ status: 200, body: { ...EDITING.edit.reply.body, day: { ...EDITING.edit.reply.body.day } } });
  await settle();
  assert.ok(!isOpen(app));
  assert.equal(app.requests.length, 1);
  assert.equal(el(app, "edit-save").disabled, false);
  assert.equal(el(app, "edit-save").textContent, "Save");

  // With no save under way, Escape is left to close the dialog.
  openDay(app, "2026-10-03");
  held = false;
  el(app, "edit-dialog").fire("cancel", { preventDefault() { held = true; } });
  assert.equal(held, false);
});

test("a day in the future cannot be saved", async () => {
  const app = await boot({ editing: true });
  assert.equal(editButton(app, "2026-10-19").disabled, false);
  assert.equal(editButton(app, "2026-10-20").disabled, false);         // today
  assert.equal(editButton(app, "2026-10-21").disabled, true);
  assert.equal(editButton(app, "2026-10-31").disabled, true);
  assert.equal(editButton(app, "2026-10-21").attributes.title, "Days in the future cannot be edited yet.");
  assert.equal(findAll(wholeMonth(app), (node) => node.tagName === "button" && node.disabled).length, 11);

  // Even if the editor were opened on such a day, it will not save.
  openDay(app, "2026-10-21");
  assert.equal(el(app, "edit-save").disabled, true);
  assert.equal(el(app, "edit-error").hidden, false);
  assert.equal(el(app, "edit-error").textContent, "This day is in the future, so it cannot be edited yet.");
  type(app, { exercise: "Completed" });
  await pressSave(app);
  assert.equal(app.requests.length, 0);
  el(app, "edit-cancel").fire("click");

  // Today can be edited.
  openDay(app, "2026-10-20");
  assert.equal(el(app, "edit-save").disabled, false);
  assert.equal(el(app, "edit-error").hidden, true);
  type(app, { exercise: "Completed" });
  await pressSave(app);
  assert.equal(app.requests[0].url, "/api/months/2026/10/days/20");
  assert.match(rowText(app, "2026-10-20").join("|"), /^Tue 20 OctToday\|Completed\|/);

  // A month that has not started: every day waits.
  await app.select("2026-11");
  assert.equal(wholeMonth(app).children.length, 30);
  assert.equal(findAll(wholeMonth(app), (node) => node.tagName === "button" && !node.disabled).length, 0);

  // When the date moves on, the next day opens up.
  await app.select("2026-10");
  app.server.status.today = "2026-10-21";                       // the backend's date, in both answers
  app.server.data["2026-10"].analytics.month.today = "2026-10-21";
  await app.save();
  assert.equal(editButton(app, "2026-10-21").disabled, false);
  assert.equal(editButton(app, "2026-10-22").disabled, true);
});

test("a refresh from the workbook never overwrites what is being typed", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-02");
  assert.equal(field(app, "calories_kcal").value, "1800");
  type(app, { calories_kcal: "2000", cardio: "12:34" });

  // Meanwhile the workbook is saved from Excel with other values for that very day.
  const day = app.server.data["2026-10"].month.days[1];
  Object.assign(day, { calories_kcal: 1500, exercise: "Missed", protein_g: 99 });
  app.server.data["2026-10"].month.days[2].exercise = "Completed";
  app.calls.length = 0;
  await app.save();
  assert.ok(app.calls.includes("/api/months/2026/10"));

  // The table behind shows the workbook; the editor still shows the user's work.
  assert.deepEqual(rowText(app, "2026-10-02").slice(1, 6), ["Missed", "Controlled", "-", "1,500", "99"]);
  assert.equal(rowText(app, "2026-10-03")[1], "Completed");
  assert.ok(isOpen(app));
  assert.deepEqual(editorValues(app), {
    exercise: "Partial", junk_food: "Controlled", cardio: "12:34",
    calories_kcal: "2000", protein_g: "", weight_lifted_kg: "",
  });
  for (let turn = 0; turn < 3; turn++) await app.save();
  assert.equal(field(app, "calories_kcal").value, "2000");
  assert.equal(field(app, "cardio").value, "12:34");
  assert.equal(el(app, "edit-error").hidden, true);
  assert.equal(app.requests.length, 0);

  // Save sends the user's two changes; the fields left alone keep the workbook's values.
  await pressSave(app);
  assert.deepEqual(sent(app), [{ cardio: "12:34", calories_kcal: 2000 }]);
  assert.deepEqual(rowText(app, "2026-10-02"),
    ["Fri 02 Oct", "Missed", "Controlled", "12:34", "2,000", "99", "-", "Edit"]);
});

test("a failed refresh while the editor is open leaves it alone too", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-02");
  type(app, { weight_lifted_kg: "1500" });
  app.server.down = true;
  await app.poll();
  assert.equal(app.notice.hidden, false);
  assert.ok(isOpen(app));
  assert.equal(field(app, "weight_lifted_kg").value, "1500");
  app.server.down = false;
  await app.poll();
  assert.equal(field(app, "weight_lifted_kg").value, "1500");
  await pressSave(app);
  assert.deepEqual(sent(app), [{ weight_lifted_kg: 1500 }]);
});

test("obviously wrong entries are caught before anything is sent", async () => {
  const app = await boot({ editing: true });
  const wrong = {
    cardio: ["25:75", "25", "25.30", "1000:00", "-1:00", "2:5", "abc", "1:2:3"],
    calories_kcal: ["12.5", "20001", "-1", "2k", "1,800", "1e3"],
    protein_g: ["12.55", "1000.1", "-0.1", "lots", ".5", "1e2"],
    weight_lifted_kg: ["5.55", "100000.5", "-5", "heavy", "1 500"],
  };
  for (const [name, entries] of Object.entries(wrong)) {
    for (const text of entries) {
      openDay(app, "2026-10-05");
      type(app, { [name]: text, exercise: "Completed" });
      await pressSave(app);
      assert.equal(app.requests.length, 0, `${name} ${text}`);
      assert.ok(isOpen(app), `${name} ${text}`);
      assert.equal(field(app, name).value, text);                  // left as typed, to be corrected
      assert.equal(field(app, "exercise").value, "Completed");
      assert.equal(fieldError(app, name).hidden, false);
      assert.match(fieldError(app, name).textContent, /^Enter /);
      assert.equal(field(app, name).attributes["aria-invalid"], "true");
      assert.match(el(app, "edit-error").textContent, /^Not saved\. Correct the marked fields/);
      assert.equal(app.document.activeElement, field(app, name));  // the cursor goes to the slip
      el(app, "edit-cancel").fire("click");
    }
  }

  // Several slips are all marked at once.
  openDay(app, "2026-10-05");
  type(app, { cardio: "99", calories_kcal: "x", protein_g: "150" });
  await pressSave(app);
  assert.deepEqual(["cardio", "calories_kcal", "protein_g", "weight_lifted_kg"].map((name) => fieldError(app, name).hidden),
    [false, false, true, true]);
  assert.equal(app.requests.length, 0);

  // The limits themselves, and their smallest values, are accepted.
  type(app, { cardio: "999:59", calories_kcal: "20000", protein_g: "1000", weight_lifted_kg: "100000.0" });
  await pressSave(app);
  assert.deepEqual(sent(app), [{ cardio: "999:59", calories_kcal: 20000, protein_g: 1000, weight_lifted_kg: 100000 }]);
  openDay(app, "2026-10-05");
  type(app, { cardio: "0:00", calories_kcal: "0", protein_g: "0.5", weight_lifted_kg: "0" });
  await pressSave(app);
  assert.deepEqual(sent(app)[1], { cardio: "0:00", calories_kcal: 0, protein_g: 0.5, weight_lifted_kg: 0 });
  assert.deepEqual(rowText(app, "2026-10-05").slice(3, 7), ["0:00", "0", "0.5", "0"]);
});

test("a cell typed wrongly in Excel is not sent back unless the user changes it", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-06");
  // The unreadable cardio text is shown so it can be corrected; unreadable others open empty.
  assert.deepEqual(editorValues(app), {
    exercise: "", junk_food: "", cardio: "25:75", calories_kcal: "", protein_g: "", weight_lifted_kg: "",
  });
  type(app, { exercise: "Completed" });
  await pressSave(app);
  assert.deepEqual(sent(app), [{ exercise: "Completed" }]);            // cardio and calories untouched
  assert.deepEqual(rowText(app, "2026-10-06"),
    ["Tue 06 Oct", "Completed", "Not entered", "25:75", "Unreadable", "-", "-", "Edit"]);

  openDay(app, "2026-10-06");
  type(app, { cardio: "25:15", calories_kcal: "2100" });
  await pressSave(app);
  assert.deepEqual(sent(app)[1], { cardio: "25:15", calories_kcal: 2100 });
  assert.deepEqual(rowText(app, "2026-10-06"),
    ["Tue 06 Oct", "Completed", "Not entered", "25:15", "2,100", "-", "-", "Edit"]);
});

test("the editor can be used from the keyboard and by a screen reader", async () => {
  const app = await boot({ editing: true });
  assert.equal(editButton(app, "2026-10-01").attributes["aria-label"], "Edit Thu 01 Oct");
  assert.equal(editButton(app, "2026-10-01").attributes.type, "button");
  assert.equal(editButton(app, "2026-10-21").attributes["aria-label"], "Edit Wed 21 Oct: not available until that day");
  const labels = findAll(wholeMonth(app), (node) => node.tagName === "button").map((node) => node.attributes["aria-label"]);
  assert.equal(new Set(labels).size, 31);                              // every button says which day

  // After a save the focus goes back to that day's Edit button, in the redrawn table.
  openDay(app, "2026-10-02");
  type(app, { exercise: "Completed" });
  await pressSave(app);
  assert.equal(app.document.activeElement, editButton(app, "2026-10-02"));

  // Errors are text, announced, and tied to their field; not only a colour.
  app.server.reply = EDITING.replies.invalid;
  openDay(app, "2026-10-03");
  type(app, { exercise: "Missed" });
  await pressSave(app);
  assert.equal(fieldError(app, "exercise").hidden, false);
  assert.ok(fieldError(app, "exercise").textContent.length > 20);
  assert.equal(field(app, "exercise").attributes["aria-invalid"], "true");
  assert.ok(el(app, "edit-error").textContent.length > 20);
  assert.match(el(app, "saved-note").textContent, /^Saved: /);        // the confirmation is words too
});

test("the page writes only through Add New Month, Delete Month and the editors", async () => {
  const app = await boot();
  // Add New Month, Delete Month, and the one PUT both editors share.
  const methods = SCRIPTS.map((script) => script.source).join("\n").match(/method:\s*"\w+"/g);
  assert.deepEqual(methods, ['method: "POST"', 'method: "DELETE"', 'method: "PUT"']);
  const controls = (root) => findAll(root, (node) => ["input", "select", "button", "textarea"].includes(node.tagName));
  assert.equal(controls(app.body).length, 0);
  // The tracker is a display with one Edit button for each day; nothing is typed into it.
  assert.equal(controls(wholeMonth(app)).length, 31);
  assert.ok(controls(wholeMonth(app)).every((node) => node.tagName === "button" && node.textContent === "Edit"));

  // Nothing is saved while fields are being changed: no listeners on the fields themselves.
  const editor = await boot({ editing: true });
  openDay(editor, "2026-10-01");
  for (const name of Object.keys(FIELD_IDS)) {
    assert.deepEqual(Object.keys(field(editor, name).listeners), [], name);
    field(editor, name).value = name === "cardio" ? "1:00" : "1";
    for (const kind of ["input", "change", "blur", "keyup"]) field(editor, name).fire(kind);
  }
  await settle();
  assert.equal(editor.requests.length, 0);
  assert.equal(controls(editor.body).length, 0);
});

// ---------------------------------------------------------------- the Sunday measurement editor
//
// In the editors' workbook, October's Sundays are 4, 11, 18 and 25 Oct:
//   4 Oct   weight 72.5, waist 84
//   11 Oct  weight 72, forearm 28.5, and a chest cell typed wrongly in Excel
//   18 Oct  nothing entered
//   25 Oct  still to come
// FIXTURES.editing.measure holds the real backend's answers, as FIXTURES.editing.replies does for days.

const MEASURE = EDITING.measure;
const MEASURE_IDS = {
  weight_kg: "measure-weight", waist_cm: "measure-waist", chest_cm: "measure-chest",
  bicep_cm: "measure-bicep", thigh_cm: "measure-thigh", forearm_cm: "measure-forearm",
};
const mField = (app, name) => el(app, MEASURE_IDS[name]);
const mError = (app, name) => el(app, `${MEASURE_IDS[name]}-error`);
const sundayRow = (app, date) =>
  find(el(app, "measurements-body"), (node) => node.tagName === "tr" && node.dataset.date === date);
const sundayText = (app, date) => sundayRow(app, date).children.map((child) => child.textContent);
const sundayButton = (app, date) => find(sundayRow(app, date), (node) => node.tagName === "button");
const mValues = (app) =>
  Object.fromEntries(Object.keys(MEASURE_IDS).map((name) => [name, mField(app, name).value]));
const mOpen = (app) => el(app, "measure-dialog").open === true;
const BLANK = { weight_kg: "", waist_cm: "", chest_cm: "", bicep_cm: "", thigh_cm: "", forearm_cm: "" };

function openSunday(app, date) {
  sundayButton(app, date).fire("click");
}

function mType(app, entries) {
  for (const [name, text] of Object.entries(entries)) mField(app, name).value = text;
}

async function mSave(app) {
  el(app, "measure-form").fire("submit");
  await settle();
}

test("each Sunday of a month can be edited, and only Sundays", async () => {
  const app = await boot({ editing: true });
  assert.deepEqual(el(app, "measurements-head").children.map((th) => th.textContent),
    ["Sunday", "Weight (kg)", "Waist (cm)", "Chest (cm)", "Bicep (cm)", "Thigh (cm)", "Forearm (cm)", "Edit"]);
  assert.deepEqual(sundayText(app, "2026-10-04"), ["Sun 04 Oct", "72.5", "84", "-", "-", "-", "-", "Edit"]);
  assert.deepEqual(sundayText(app, "2026-10-11"), ["Sun 11 Oct", "72", "-", "Unreadable", "-", "-", "28.5", "Edit"]);
  assert.deepEqual(sundayText(app, "2026-10-18"), ["Sun 18 Oct", "-", "-", "-", "-", "-", "-", "Edit"]);

  // One measurement button for each Sunday, and none for any other day.
  const rows = el(app, "measurements-body").children;
  assert.deepEqual(rows.map((row) => row.dataset.date), ["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]);
  assert.ok(rows.every((row) => parseDayOfWeek(row.dataset.date) === 0));
  const buttons = findAll(el(app, "measurements-body"), (node) => node.tagName === "button");
  assert.equal(buttons.length, 4);
  assert.deepEqual(buttons.map((button) => button.attributes["aria-label"]), [
    "Edit measurements for Sun 04 Oct", "Edit measurements for Sun 11 Oct",
    "Edit measurements for Sun 18 Oct", "Edit measurements for Sun 25 Oct: not available until that day",
  ]);
  const everyButton = findAll({ children: [wholeMonth(app), el(app, "measurements-body"), app.body], dataset: {}, className: "" },
    (node) => node.tagName === "button");
  assert.equal(everyButton.filter((button) => /measurements/.test(button.attributes["aria-label"])).length, 4);
  assert.equal(findAll(wholeMonth(app), (node) => node.tagName === "button"
    && /measurements/.test(node.attributes["aria-label"])).length, 0);
  // The table itself stays a display.
  assert.equal(findAll(el(app, "measurements-body"), (node) => ["input", "select", "textarea"].includes(node.tagName)).length, 0);

  // A day's Edit button opens the day editor, never the measurement one, even on a Sunday.
  openDay(app, "2026-10-04");
  assert.ok(isOpen(app));
  assert.ok(!mOpen(app));
  el(app, "edit-cancel").fire("click");
  openSunday(app, "2026-10-04");
  assert.ok(mOpen(app));
  assert.ok(!isOpen(app));
});

test("the measurement editor opens with that Sunday's values, blanks left blank", async () => {
  const app = await boot({ editing: true });
  assert.ok(!mOpen(app));
  openSunday(app, "2026-10-04");
  assert.ok(mOpen(app));
  assert.match(el(app, "measure-date").textContent, /^Sunday,? 4 October 2026$/);
  assert.deepEqual(mValues(app), { ...BLANK, weight_kg: "72.5", waist_cm: "84" });
  assert.equal(el(app, "measure-error").hidden, true);
  assert.equal(el(app, "measure-save").disabled, false);
  assert.equal(el(app, "measure-save").textContent, "Save");
  el(app, "measure-cancel").fire("click");

  openSunday(app, "2026-10-11");
  // The chest cell is unreadable in the workbook: it opens empty and is not guessed.
  assert.deepEqual(mValues(app), { ...BLANK, weight_kg: "72", forearm_cm: "28.5" });
  el(app, "measure-cancel").fire("click");

  openSunday(app, "2026-10-18");
  assert.deepEqual(mValues(app), BLANK);
  assert.equal(app.requests.length, 0);
  assert.doesNotMatch(Object.values(mValues(app)).join(""), /0/);       // blank is never shown as zero
});

test("each of the six measurements is saved under its own field name", async () => {
  const app = await boot({ editing: true });
  const entries = { weight_kg: "70.5", waist_cm: "80", chest_cm: "98.5", bicep_cm: "35", thigh_cm: "59.5", forearm_cm: "28" };
  const columns = Object.keys(MEASURE_IDS);
  for (const [name, text] of Object.entries(entries)) {
    openSunday(app, "2026-10-18");
    mType(app, { [name]: text });
    await mSave(app);
    const request = app.requests[app.requests.length - 1];
    assert.equal(request.method, "PUT", name);
    assert.equal(request.url, "/api/months/2026/10/measurements/18", name);
    assert.deepEqual(JSON.parse(request.body), { [name]: Number(text) }, name);
    assert.ok(!mOpen(app), name);
    assert.equal(sundayText(app, "2026-10-18")[1 + columns.indexOf(name)], text, name);
  }
  assert.equal(app.requests.length, 6);
  assert.deepEqual(sundayText(app, "2026-10-18"), ["Sun 18 Oct", "70.5", "80", "98.5", "35", "59.5", "28", "Edit"]);
  // Decimals come back as they were entered.
  openSunday(app, "2026-10-18");
  assert.deepEqual(mValues(app), entries);
});

test("Save sends one PUT with the changed measurements and shows the saved record", async () => {
  const app = await boot({ editing: true });
  app.server.reply = MEASURE.edit.reply;            // what the real backend answered to this edit
  const days = wholeMonth(app).textContent;
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "70.5", waist_cm: "", chest_cm: "98" });
  app.calls.length = 0;
  await mSave(app);

  assert.equal(app.requests.length, 1);
  const request = app.requests[0];
  assert.equal(request.method, "PUT");
  assert.equal(request.url, "/api/months/2026/10/measurements/4");
  assert.equal(request.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), MEASURE.edit.request);
  assert.deepEqual(JSON.parse(request.body), { weight_kg: 70.5, waist_cm: null, chest_cm: 98 });
  assert.equal("bicep_cm" in JSON.parse(request.body), false);        // untouched, so not sent

  assert.ok(!mOpen(app));
  assert.deepEqual(sundayText(app, "2026-10-04"), ["Sun 04 Oct", "70.5", "-", "98", "-", "-", "-", "Edit"]);
  assert.deepEqual(sundayText(app, "2026-10-11"), ["Sun 11 Oct", "72", "-", "Unreadable", "-", "-", "28.5", "Edit"]);
  assert.deepEqual(app.calls, ["/api/months/2026/10/analytics"]);      // the analytics, once; nothing else is read
  assert.equal(el(app, "measure-saved-note").hidden, false);
  assert.equal(el(app, "measure-saved-note").textContent,
    "Saved: measurements for Sun 04 Oct were written to the workbook.");
  assert.equal(el(app, "saved-note").textContent, "");                 // the daily note is not used for this
  assert.ok(app.document.activeElement === sundayButton(app, "2026-10-04"));
  assert.equal(wholeMonth(app).textContent, days);                         // the daily table is as it was
});

test("the stand-in backend answers a measurement edit as the real one does", async () => {
  const app = await boot({ editing: true });
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "70.5", waist_cm: "", chest_cm: "98" });
  await mSave(app);
  assert.deepEqual(app.server.data["2026-10"].month.measurements[0], MEASURE.edit.reply.body.measurement);
  assert.deepEqual(Object.keys(app.lastReply.body).sort(), Object.keys(MEASURE.edit.reply.body).sort());
});

test("Cancel, or Save with nothing changed, sends no request", async () => {
  const app = await boot({ editing: true });
  const before = sundayText(app, "2026-10-04");
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "99", thigh_cm: "60" });
  el(app, "measure-cancel").fire("click");
  await settle();
  assert.ok(!mOpen(app));
  assert.equal(app.requests.length, 0);
  assert.deepEqual(sundayText(app, "2026-10-04"), before);
  // The discarded text is gone the next time.
  openSunday(app, "2026-10-04");
  assert.deepEqual(mValues(app), { ...BLANK, weight_kg: "72.5", waist_cm: "84" });

  await mSave(app);
  assert.ok(!mOpen(app));
  assert.equal(app.requests.length, 0);
  assert.equal(el(app, "measure-saved-note").textContent, "Nothing was changed for Sun 04 Oct, so nothing was saved.");

  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: " 72.5 " });               // the same value again
  await mSave(app);
  assert.equal(app.requests.length, 0);

  // Nothing is sent while typing either.
  openSunday(app, "2026-10-18");
  for (const name of Object.keys(MEASURE_IDS)) {
    assert.deepEqual(Object.keys(mField(app, name).listeners), [], name);
    mField(app, name).value = "50";
    for (const kind of ["input", "change", "blur", "keyup"]) mField(app, name).fire(kind);
  }
  await settle();
  assert.equal(app.requests.length, 0);
});

test("a second press of Save while measurements are being saved sends nothing more", async () => {
  const app = await boot({ editing: true });
  let release;
  app.server.reply = () => new Promise((resolve) => { release = resolve; });
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "70.5", waist_cm: "", chest_cm: "98" });
  el(app, "measure-form").fire("submit");
  await settle();
  assert.equal(el(app, "measure-save").disabled, true);
  assert.equal(el(app, "measure-cancel").disabled, true);
  assert.equal(el(app, "measure-save").textContent, "Saving");
  for (let turn = 0; turn < 3; turn++) {
    el(app, "measure-form").fire("submit");
    el(app, "measure-cancel").fire("click");
    await settle();
  }
  assert.equal(app.requests.length, 1);
  assert.ok(mOpen(app));
  let held = false;
  el(app, "measure-dialog").fire("cancel", { preventDefault() { held = true; } });
  assert.equal(held, true);

  release(structuredClone(MEASURE.edit.reply));
  await settle();
  assert.ok(!mOpen(app));
  assert.equal(app.requests.length, 1);
  assert.equal(el(app, "measure-save").disabled, false);
  assert.equal(el(app, "measure-save").textContent, "Save");
});

test("refused measurements (400) keep the editor open with what was typed", async () => {
  const app = await boot({ editing: true });
  app.server.reply = MEASURE.replies.invalid;
  assert.equal(MEASURE.replies.invalid.status, 400);
  const before = sundayText(app, "2026-10-04");
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "70.5", waist_cm: "80", bicep_cm: "35.5" });
  await mSave(app);

  assert.ok(mOpen(app));
  assert.deepEqual(mValues(app), { ...BLANK, weight_kg: "70.5", waist_cm: "80", bicep_cm: "35.5" });
  const fields = MEASURE.replies.invalid.body.error.fields;
  for (const name of ["weight_kg", "waist_cm"]) {
    assert.equal(mError(app, name).hidden, false, name);
    assert.equal(mError(app, name).textContent, fields[name], name);       // the backend's own words
    assert.equal(mField(app, name).attributes["aria-invalid"], "true", name);
  }
  assert.equal(mError(app, "bicep_cm").hidden, true);
  assert.match(el(app, "measure-error").textContent, /^Not saved\./);
  assert.equal(el(app, "measure-error").hidden, false);
  assert.deepEqual(sundayText(app, "2026-10-04"), before);
  assert.equal(el(app, "measure-save").disabled, false);

  app.server.reply = null;
  await mSave(app);
  assert.equal(app.requests.length, 2);
  assert.ok(!mOpen(app));
  assert.deepEqual(sundayText(app, "2026-10-04").slice(1, 5), ["70.5", "80", "-", "35.5"]);
});

test("a locked workbook (423) keeps the measurement editor open and waits for Save", async () => {
  const app = await boot({ editing: true });
  app.server.reply = MEASURE.replies.locked;
  assert.equal(MEASURE.replies.locked.status, 423);
  openSunday(app, "2026-10-18");
  mType(app, { weight_kg: "71.2" });
  await mSave(app);
  assert.ok(mOpen(app));
  assert.equal(el(app, "measure-error").hidden, false);
  assert.equal(el(app, "measure-error").textContent, LOCKED_TEXT);
  assert.equal(mField(app, "weight_kg").value, "71.2");
  for (let turn = 0; turn < 3; turn++) await app.poll();
  assert.equal(app.requests.length, 1);                  // no retry by itself
  assert.equal(mField(app, "weight_kg").value, "71.2");

  app.server.reply = null;
  await mSave(app);
  assert.equal(app.requests.length, 2);
  assert.ok(!mOpen(app));
  assert.equal(sundayText(app, "2026-10-18")[1], "71.2");
});

test("other refusals are shown in the backend's words and nothing typed is lost", async () => {
  const app = await boot({ editing: true });
  const cases = [
    [MEASURE.replies.not_sunday, MEASURE.replies.not_sunday.body.error.fields.day],
    [MEASURE.replies.future, MEASURE.replies.future.body.error.fields.day],
    [MEASURE.replies.missing, MEASURE.replies.missing.body.error.message],
    [MEASURE.replies.other_layout, MEASURE.replies.other_layout.body.error.message],
  ];
  assert.match(cases[0][1], /is not a Sunday/);
  assert.match(cases[1][1], /future/);
  assert.equal(MEASURE.replies.missing.status, 404);
  assert.equal(MEASURE.replies.other_layout.status, 500);
  openSunday(app, "2026-10-18");
  mType(app, { thigh_cm: "59" });
  for (const [reply, message] of cases) {
    app.server.reply = reply;
    await mSave(app);
    assert.ok(mOpen(app), message);
    assert.equal(el(app, "measure-error").hidden, false);
    assert.equal(el(app, "measure-error").textContent, message);
    assert.equal(mField(app, "thigh_cm").value, "59");
    assert.equal(el(app, "measure-save").disabled, false);
  }
  app.server.down = true;
  await mSave(app);
  assert.ok(mOpen(app));
  assert.match(el(app, "measure-error").textContent, /^Cannot reach the local backend/);
  assert.equal(mField(app, "thigh_cm").value, "59");
  assert.equal(sundayText(app, "2026-10-18")[5], "-");

  app.server.down = false;
  app.server.reply = null;
  await mSave(app);
  assert.ok(!mOpen(app));
  assert.equal(sundayText(app, "2026-10-18")[5], "59");
});

test("a Sunday in the future cannot be saved", async () => {
  const app = await boot({ editing: true });
  assert.equal(sundayButton(app, "2026-10-18").disabled, false);
  assert.equal(sundayButton(app, "2026-10-25").disabled, true);
  assert.equal(sundayButton(app, "2026-10-25").attributes.title, "Days in the future cannot be edited yet.");

  openSunday(app, "2026-10-25");                     // even if it were opened
  assert.equal(el(app, "measure-save").disabled, true);
  assert.equal(el(app, "measure-error").hidden, false);
  assert.equal(el(app, "measure-error").textContent, "This Sunday is in the future, so it cannot be edited yet.");
  mType(app, { weight_kg: "70" });
  await mSave(app);
  assert.equal(app.requests.length, 0);
  el(app, "measure-cancel").fire("click");

  // A month that has not started.
  await app.select("2026-11");
  const november = findAll(el(app, "measurements-body"), (node) => node.tagName === "button");
  assert.equal(november.length, 5);
  assert.ok(november.every((button) => button.disabled));

  // On the Sunday itself it opens up.
  await app.select("2026-10");
  app.server.status.today = "2026-10-25";                       // the backend's date, in both answers
  app.server.data["2026-10"].analytics.month.today = "2026-10-25";
  await app.save();
  assert.equal(sundayButton(app, "2026-10-25").disabled, false);
  openSunday(app, "2026-10-25");
  assert.equal(el(app, "measure-save").disabled, false);
  assert.equal(el(app, "measure-error").hidden, true);
  mType(app, { weight_kg: "70" });
  await mSave(app);
  assert.equal(app.requests[0].url, "/api/months/2026/10/measurements/25");
  assert.equal(sundayText(app, "2026-10-25")[1], "70");
});

test("a refresh from the workbook never overwrites measurements being typed", async () => {
  const app = await boot({ editing: true });
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "70.5" });

  // Meanwhile that Sunday is changed in Excel and saved.
  Object.assign(app.server.data["2026-10"].month.measurements[0], { weight_kg: 73, chest_cm: 99, waist_cm: 85 });
  app.server.data["2026-10"].month.measurements[2].weight_kg = 71;
  app.calls.length = 0;
  await app.save();
  assert.ok(app.calls.includes("/api/months/2026/10"));

  assert.deepEqual(sundayText(app, "2026-10-04").slice(1, 4), ["73", "85", "99"]);     // the table follows the workbook
  assert.equal(sundayText(app, "2026-10-18")[1], "71");
  assert.ok(mOpen(app));
  assert.deepEqual(mValues(app), { ...BLANK, weight_kg: "70.5", waist_cm: "84" });      // the editor does not
  for (let turn = 0; turn < 3; turn++) await app.save();
  assert.equal(mField(app, "weight_kg").value, "70.5");
  assert.equal(app.requests.length, 0);

  // Only the weight was changed by the user, so only the weight is sent.
  await mSave(app);
  assert.deepEqual(sent(app), [{ weight_kg: 70.5 }]);
  assert.deepEqual(sundayText(app, "2026-10-04").slice(1, 4), ["70.5", "85", "99"]);

  // A failed refresh leaves an open editor alone as well.
  openSunday(app, "2026-10-11");
  mType(app, { waist_cm: "83.5" });
  app.server.down = true;
  await app.poll();
  assert.equal(app.notice.hidden, false);
  assert.ok(mOpen(app));
  assert.equal(mField(app, "waist_cm").value, "83.5");
});

test("obviously wrong measurements are caught before anything is sent", async () => {
  const app = await boot({ editing: true });
  for (const name of Object.keys(MEASURE_IDS)) {
    for (const text of ["0", "0.0", "-1", "500.1", "501", "70.55", "abc", "1e2", ".5", "70 kg", "70,5"]) {
      openSunday(app, "2026-10-18");
      mType(app, { [name]: text });
      await mSave(app);
      assert.equal(app.requests.length, 0, `${name} ${text}`);
      assert.ok(mOpen(app), `${name} ${text}`);
      assert.equal(mField(app, name).value, text);
      assert.equal(mError(app, name).hidden, false);
      assert.equal(mError(app, name).textContent,
        "Enter a number above 0 and up to 500, with at most one decimal place.");
      assert.equal(mField(app, name).attributes["aria-invalid"], "true");
      assert.match(el(app, "measure-error").textContent, /^Not saved\. Correct the marked fields/);
      assert.equal(app.document.activeElement, mField(app, name));
      el(app, "measure-cancel").fire("click");
    }
  }
  // The edges of what is allowed go through, as numbers.
  openSunday(app, "2026-10-18");
  mType(app, { weight_kg: "500", waist_cm: "0.1", chest_cm: "98.0", bicep_cm: " 35.5 " });
  await mSave(app);
  assert.deepEqual(sent(app), [{ weight_kg: 500, waist_cm: 0.1, chest_cm: 98, bicep_cm: 35.5 }]);
  assert.ok(Object.values(sent(app)[0]).every((value) => typeof value === "number"));
});

test("an unreadable measurement is left alone unless the user replaces it", async () => {
  const app = await boot({ editing: true });
  openSunday(app, "2026-10-11");
  mType(app, { waist_cm: "83" });
  await mSave(app);
  assert.deepEqual(sent(app), [{ waist_cm: 83 }]);
  assert.deepEqual(sundayText(app, "2026-10-11"), ["Sun 11 Oct", "72", "83", "Unreadable", "-", "-", "28.5", "Edit"]);

  openSunday(app, "2026-10-11");
  mType(app, { chest_cm: "99.5" });
  await mSave(app);
  assert.deepEqual(sent(app)[1], { chest_cm: 99.5 });
  assert.deepEqual(sundayText(app, "2026-10-11"), ["Sun 11 Oct", "72", "83", "99.5", "-", "-", "28.5", "Edit"]);
});

test("both editors share one way of working", async () => {
  const app = await boot({ editing: true });
  // One editor is set up twice, so Save, Cancel, errors and focus behave the same in both.
  const source = SCRIPTS.find((script) => script.name === "editor.js").source;
  assert.equal(source.match(/function setupEditor\(/g).length, 1);
  assert.equal(source.match(/= setupEditor\(\{/g).length, 2);
  assert.equal(source.match(/method: "PUT"/g).length, 1);
  assert.equal(source.match(/LOCKED_MESSAGE\b/g).length, 2);          // defined once, shown from one place

  // Saving a day does not disturb the measurements, and the other way round.
  const sundays = el(app, "measurements-body").textContent;
  openDay(app, "2026-10-04");
  type(app, { exercise: "Completed" });
  await pressSave(app);
  assert.equal(el(app, "measurements-body").textContent, sundays);
  assert.equal(app.requests[0].url, "/api/months/2026/10/days/4");

  const days = wholeMonth(app).textContent;
  openSunday(app, "2026-10-04");
  mType(app, { thigh_cm: "59" });
  await mSave(app);
  assert.equal(wholeMonth(app).textContent, days);
  assert.equal(app.requests[1].url, "/api/months/2026/10/measurements/4");
  assert.deepEqual(sent(app)[1], { thigh_cm: 59 });
});

// ---------------------------------------------------------------- the dashboard
//
// The analytics shown for the editors' workbook are the real backend's answers
// (FIXTURES.editing.data[...].analytics), with today fixed at 20 Oct 2026:
//   1 Oct  Completed, None, cardio 25:30, 2200 kcal, 140.5 g, 2450 kg
//   2 Oct  Partial, Controlled, 1800 kcal
//   3 Oct  Rest Day, Had
//   4 Oct  Missed, junk food blank, and a recorded zero for cardio, calories, protein and weight
//   5 to 19 Oct  blank (6 Oct has cells typed wrongly in Excel)
//   20 Oct  today, blank

const A_OCT = EDITING.data["2026-10"].analytics;
const A_NOV = EDITING.data["2026-11"].analytics;
const SECTIONS = ["habits", "daily", "calories", "protein", "cardio", "weight", "weekly", "measurements"];
const habitCard = (app, habit) => find(app.section("habits"), both(hasClass("card"), hasData("habit", habit)));
const weeklyColumn = (app, name, stat) =>
  findAll(app.section(name), (node) => node.tagName === "td" && node.dataset.stat === stat).map((cell) => cell.textContent);
const bars = (app, name) => findAll(app.section(name), hasClass("bar")).map((bar) => bar.dataset.date);
const emptyNotes = (app, name) => findAll(app.section(name), hasData("empty")).map((node) => node.textContent);

test("a month asks for its analytics and shows eight sections", async () => {
  const app = await boot({ editing: true });
  assert.equal(EDITING.analytics.status, 200);
  assert.equal("version" in A_OCT, false);
  assert.ok(app.calls.includes("/api/months/2026/10"));
  assert.ok(app.calls.includes("/api/months/2026/10/analytics"));
  assert.equal(app.notice.hidden, true);
  const sections = findAll(app.body, hasData("section"));
  assert.deepEqual(sections.map((node) => node.dataset.section), SECTIONS);
  assert.deepEqual(sections.map((node) => node.children[0].textContent), [
    "Habit Overview", "Daily Habit Progress", "Calories", "Protein", "Cardio", "Weight Lifted",
    "Weekly Habit Analytics", "Body Measurements",
  ]);
  for (const node of sections) {
    assert.equal(node.attributes.id, `section-${node.dataset.section}`);
    assert.equal(node.attributes["aria-labelledby"], node.children[0].attributes.id);
  }
  assert.doesNotMatch(app.body.textContent, /not available yet/);
  assert.doesNotMatch(app.body.textContent, /\b(true|false|null|undefined|NaN|Infinity)\b/i);
  // One read of each kind per load, and nothing more until something changes.
  app.calls.length = 0;
  await app.poll();
  assert.deepEqual(app.calls, ["/api/status"]);
  await app.save();
  assert.deepEqual(app.calls.slice(1).sort(),
    ["/api/months", "/api/months/2026/10", "/api/months/2026/10/analytics", "/api/status"].sort());
});

test("the exercise card shows the backend's counts, percentage and streaks", async () => {
  const app = await boot({ editing: true });
  const card = habitCard(app, "exercise");
  assert.equal(card.children[0].textContent, "Exercise");
  assert.equal(value(card, "percentage"), "8.33%");
  assert.equal(value(card, "percentage"), `${A_OCT.exercise.completion_percentage}%`);
  assert.equal(value(card, "completed"), "1 day");
  assert.equal(value(card, "partial"), "1 day");
  assert.equal(value(card, "rest_day"), "1 day");
  assert.equal(value(card, "missed"), "16 days");
  assert.equal(value(card, "pending"), "12 days");
  assert.equal(value(card, "current-streak"), "0 days");
  assert.equal(value(card, "longest-streak"), "1 day");
  assert.deepEqual(A_OCT.exercise.counts, { completed: 1, partial: 1, rest_day: 1, missed: 16, pending: 12 });
  // The five statuses, in order, each with its name and how it counts.
  const counts = findAll(card, hasClass("count"));
  assert.deepEqual(counts.map((node) => node.dataset.stat), ["completed", "partial", "rest_day", "missed", "pending"]);
  assert.deepEqual(counts.map((node) => node.children[0].textContent),
    ["Completed", "Partial", "Rest Day", "Missed", "Pending"]);
  assert.deepEqual(counts.map((node) => node.children[2].textContent), [
    "counted in full", "counted as half", "left out of the percentage", "counted as nothing", "not counted yet",
  ]);
  // Rest Day, Missed and Pending are three different things, each with its own mark.
  assert.deepEqual(counts.map((node) => node.children[0].children[0].className),
    ["mark completed", "mark partial", "mark rest", "mark missed", "mark"]);
  assert.equal(find(card, hasData("stat", "missed-not-entered")).textContent,
    "Of the missed days, 15 days were left blank.");
  assert.deepEqual(findAll(card, hasClass("row")).map((row) => row.children[0].textContent),
    ["Current streak", "Longest streak"]);
  assert.equal(find(card, hasClass("figure-label")).textContent, "completion of counted days");
  // The bar is split by the same counts, and says so in words.
  const bar = find(card, hasClass("stack"));
  assert.equal(bar.attributes["aria-label"], "1 Completed, 1 Partial, 1 Rest Day, 16 Missed, 12 Pending");
  assert.deepEqual(findAll(bar, hasClass("seg")).map((seg) => [seg.dataset.status, seg.style.flexGrow]),
    [["completed", "1"], ["partial", "1"], ["rest_day", "1"], ["missed", "16"], ["pending", "12"]]);
});

test("the junk food card shows the backend's counts, percentage and clean streaks", async () => {
  const app = await boot({ editing: true });
  const card = habitCard(app, "junk_food");
  assert.equal(card.children[0].textContent, "Junk Food");
  assert.equal(value(card, "percentage"), "50%");
  assert.equal(A_OCT.junk_food.success_percentage, 50);
  assert.equal(value(card, "none"), "1 day");
  assert.equal(value(card, "controlled"), "1 day");
  assert.equal(value(card, "had"), "1 day");
  assert.equal(value(card, "missed"), "16 days");
  assert.equal(value(card, "pending"), "12 days");
  assert.equal(value(card, "current-streak"), "0 days");
  assert.equal(value(card, "longest-streak"), "1 day");
  const counts = findAll(card, hasClass("count"));
  assert.deepEqual(counts.map((node) => node.children[0].textContent), ["None", "Controlled", "Had", "Missed", "Pending"]);
  // Had and Missed are told apart in words and by their marks.
  assert.deepEqual(counts.map((node) => node.children[2].textContent), [
    "counted in full", "counted as half", "counted as nothing", "past day left blank", "not counted yet",
  ]);
  assert.deepEqual(counts.map((node) => node.children[0].children[0].className),
    ["mark completed", "mark partial", "mark missed", "mark unentered", "mark"]);
  assert.deepEqual(findAll(card, hasClass("row")).map((row) => row.children[0].textContent),
    ["Current clean streak", "Longest clean streak"]);
  assert.equal(find(card, hasClass("figure-label")).textContent, "success on days with an entry");
  assert.equal(findAll(card, hasData("stat", "missed-not-entered")).length, 0);
});

test("the percentages and streaks shown are the backend's, not worked out on the page", async () => {
  const app = await boot({ editing: true });
  // Numbers that no calculation from the counts could produce.
  const changed = structuredClone(EDITING.data["2026-10"]);
  Object.assign(changed.analytics.exercise, { completion_percentage: 91.23, current_streak: 7, longest_streak: 11 });
  Object.assign(changed.analytics.junk_food, { success_percentage: 12.5, current_streak: 3, longest_streak: 4 });
  changed.analytics.weekly[0].exercise.completion_percentage = 77.7;
  changed.analytics.weekly[0].junk_food.success_percentage = 66.6;
  app.server.data["2026-10"] = changed;
  await app.save();
  assert.equal(value(habitCard(app, "exercise"), "percentage"), "91.23%");
  assert.equal(value(habitCard(app, "exercise"), "current-streak"), "7 days");
  assert.equal(value(habitCard(app, "exercise"), "longest-streak"), "11 days");
  assert.equal(value(habitCard(app, "junk_food"), "percentage"), "12.5%");
  assert.equal(value(habitCard(app, "junk_food"), "current-streak"), "3 days");
  assert.equal(weekCell(app, 1, "exercise", "percentage"), "77.7%");
  assert.equal(weekCell(app, 1, "junk_food", "percentage"), "66.6%");
  // The only arithmetic in the page's analytics is chart geometry: the part that builds the
  // sections and their figures, up to where the charts begin, has none.
  const source = SCRIPTS.find((script) => script.name === "analytics.js").source;
  const sections = source.slice(source.indexOf("const HABIT_KEYS"), source.indexOf("function niceTicks("));
  assert.ok(sections.includes("function buildAnalytics(") && sections.includes("function measurementCard("));
  assert.doesNotMatch(sections, /reduce\(|\/ \(|\* 100|\+= /);
});

test("in the month that holds today, the days already past are marked only for their look", async () => {
  const app = await boot({ editing: true });
  const daily = app.section("daily");
  const isPast = (node) => /\bpast\b/.test(node.className);
  for (let day = 1; day <= 31; day++) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    const cells = findAll(daily, (node) => (node.tagName === "th" || node.tagName === "td") && node.dataset.date === date);
    assert.equal(cells.length, 3, date);                     // the day's number and its two habits
    for (const cell of cells) assert.equal(isPast(cell), day < 20, `${date} ${cell.tagName}`);
  }
  // The weekday letters follow their columns.
  const letters = find(daily, (node) => node.tagName === "tr" && hasClass("weekdays")(node));
  assert.deepEqual(letters.children.filter((node) => node.tagName === "td").map(isPast),
    Array.from({ length: 31 }, (_, index) => index < 19));
  // Today keeps its own column, a Monday keeps its line, and a past day keeps its mark and words.
  const head = (date) => find(daily, (node) => node.tagName === "th" && node.dataset.date === date);
  assert.equal(head("2026-10-20").className, "today");
  assert.equal(head("2026-10-05").className, "week-start past");
  assert.equal(dayMark(app, "exercise", "2026-10-01").className, "mark completed");
  assert.equal(dayMark(app, "exercise", "2026-10-01").attributes["aria-label"], "Thu 01 Oct, Exercise: Completed");
  // Nothing is disabled: the past days are the same cells as before, with one more class.
  assert.equal(findAll(daily, (node) => node.attributes && ("disabled" in node.attributes || "aria-disabled" in node.attributes)).length, 0);
  // A month that has not started has no past days.
  await app.select("2026-11");
  assert.equal(findAll(app.section("daily"), (node) => typeof node.className === "string" && isPast(node)).length, 0);
});

test("the daily grid marks each status, and a blank past day differently from a recorded one", async () => {
  const app = await boot({ editing: true });
  const seen = (habit, date) => {
    const mark = dayMark(app, habit, date);
    return [mark.dataset.status, mark.className, mark.attributes["aria-label"]];
  };
  assert.deepEqual(seen("exercise", "2026-10-01"), ["completed", "mark completed", "Thu 01 Oct, Exercise: Completed"]);
  assert.deepEqual(seen("exercise", "2026-10-02"), ["partial", "mark partial", "Fri 02 Oct, Exercise: Partial"]);
  assert.deepEqual(seen("exercise", "2026-10-03"), ["rest_day", "mark rest", "Sat 03 Oct, Exercise: Rest Day"]);
  assert.deepEqual(seen("exercise", "2026-10-04"), ["missed", "mark missed", "Sun 04 Oct, Exercise: Missed"]);
  assert.deepEqual(seen("exercise", "2026-10-05"),
    ["missed", "mark unentered", "Mon 05 Oct, Exercise: Missed (left blank)"]);
  assert.deepEqual(seen("exercise", "2026-10-20"), ["pending", "mark", "Tue 20 Oct, Exercise: Pending"]);
  assert.deepEqual(seen("exercise", "2026-10-31"), ["pending", "mark", "Sat 31 Oct, Exercise: Pending"]);
  assert.deepEqual(seen("junk_food", "2026-10-01"), ["none", "mark completed", "Thu 01 Oct, Junk Food: None"]);
  assert.deepEqual(seen("junk_food", "2026-10-02"), ["controlled", "mark partial", "Fri 02 Oct, Junk Food: Controlled"]);
  assert.deepEqual(seen("junk_food", "2026-10-03"), ["had", "mark missed", "Sat 03 Oct, Junk Food: Had"]);
  assert.deepEqual(seen("junk_food", "2026-10-04"),
    ["missed", "mark unentered", "Sun 04 Oct, Junk Food: Missed (left blank)"]);
  assert.equal(dayMark(app, "junk_food", "2026-10-03").dataset.tip, "Had");
  assert.equal(dayMark(app, "junk_food", "2026-10-03").dataset.tipLabel, "Sat 03 Oct, Junk Food");

  // The marks agree with the backend's counts, status by status.
  for (const habit of ["exercise", "junk_food"]) {
    for (const [status, count] of Object.entries(A_OCT[habit].counts)) {
      assert.equal(findAll(gridRow(app, habit), both(hasClass("mark"), hasData("status", status))).length, count,
        `${habit} ${status}`);
    }
  }
  assert.deepEqual(findAll(app.section("daily"), (node) => node.tagName === "tr" && "habit" in node.dataset)
    .map((row) => row.children[0].textContent), ["Exercise", "Junk Food"]);
  const today = findAll(app.section("daily"), (node) => node.tagName === "th" && node.attributes["aria-current"] === "date");
  assert.deepEqual(today.map((node) => node.dataset.date), ["2026-10-20"]);
  // The legend explains every mark in words.
  const legend = find(app.section("habits"), hasClass("legend")).textContent;
  for (const word of ["Completed", "Partial", "Rest Day", "Missed", "left blank", "Pending"]) {
    assert.ok(legend.includes(word), word);
  }
});

test("today's panel says what was entered today, or that it is still pending", async () => {
  const app = await boot({ editing: true });
  const item = (habit) => find(find(app.section("habits"), hasClass("today-panel")),
    (node) => node.tagName === "li" && node.dataset.habit === habit);
  assert.equal(find(app.section("habits"), hasClass("today-panel")).dataset.today, "2026-10-20");
  assert.equal(item("exercise").dataset.status, "pending");
  assert.equal(find(item("exercise"), hasClass("value")).textContent, "Not entered yet");
  assert.match(item("exercise").textContent, /It is not counted as a miss\./);
  assert.equal(find(item("junk_food"), hasClass("value")).textContent, "Not entered yet");

  const changed = structuredClone(EDITING.data["2026-10"]);
  Object.assign(changed.analytics.daily[19], {
    exercise: "Rest Day", exercise_status: "rest_day", junk_food: "Controlled", junk_food_status: "controlled",
  });
  app.server.data["2026-10"] = changed;
  await app.save();
  assert.equal(find(item("exercise"), hasClass("value")).textContent, "Rest Day");
  assert.match(item("exercise").textContent, /left out of the percentage/);
  assert.equal(find(item("junk_food"), hasClass("value")).textContent, "Controlled");

  // No panel in a month that does not hold today.
  await app.select("2026-11");
  assert.equal(findAll(app.section("habits"), hasClass("today-panel")).length, 0);
});

test("weekly habit rows show every status and the backend's percentage for each week", async () => {
  const app = await boot({ editing: true });
  const rows = findAll(app.section("weekly"), (node) => node.tagName === "tr" && "week" in node.dataset);
  assert.equal(rows.length, 5);
  assert.match(rows[0].textContent, /Thu 01 Oct to Sun 04 Oct/);
  assert.match(rows[4].textContent, /Mon 26 Oct to Sat 31 Oct/);
  assert.deepEqual(rows.map((row) => find(row, hasData("stat", "week-length")).textContent),
    ["4 days", "7 days", "7 days", "7 days", "6 days"]);
  const exercise = (week) => ["completed", "partial", "rest_day", "missed", "pending", "percentage"]
    .map((stat) => weekCell(app, week, "exercise", stat));
  const junk = (week) => ["none", "controlled", "had", "missed", "pending", "percentage"]
    .map((stat) => weekCell(app, week, "junk_food", stat));
  assert.deepEqual(exercise(1), ["1", "1", "1", "1", "0", "50%"]);
  assert.deepEqual(junk(1), ["1", "1", "1", "1", "0", "50%"]);
  assert.deepEqual(exercise(2), ["0", "0", "0", "7", "0", "0%"]);
  assert.deepEqual(junk(2), ["0", "0", "0", "7", "0", "-"]);          // no entries: a dash, not 0%
  assert.deepEqual(exercise(4), ["0", "0", "0", "1", "6", "0%"]);
  assert.deepEqual(exercise(5), ["0", "0", "0", "0", "6", "-"]);
  A_OCT.weekly.forEach((week) => {
    for (const status of ["completed", "partial", "rest_day", "missed", "pending"]) {
      assert.equal(weekCell(app, week.week, "exercise", status), String(week.exercise[status]));
    }
    for (const status of ["none", "controlled", "had", "missed", "pending"]) {
      assert.equal(weekCell(app, week.week, "junk_food", status), String(week.junk_food[status]));
    }
  });
  const headings = findAll(app.section("weekly"), (node) => node.tagName === "th" && node.attributes.scope === "col")
    .map((node) => node.textContent);
  assert.deepEqual(headings, ["Week", "Completed", "Partial", "Rest Day", "Missed", "Pending", "%",
    "None", "Controlled", "Had", "Missed", "Pending", "%"]);
});

test("cardio is shown as min:sec with a recorded 0:00 kept and blanks left out", async () => {
  const app = await boot({ editing: true });
  assert.equal(app.tile("cardio-total"), "25:30");
  assert.equal(app.tile("cardio-average"), "12:45");
  assert.equal(app.tile("cardio-longest"), "25:30");
  assert.equal(app.tile("cardio-days"), "2");
  assert.equal(app.tile("cardio-total"), A_OCT.cardio.total_display);
  assert.equal(app.tile("cardio-average"), A_OCT.cardio.average_display);
  // A bar for each day with an entry, the 0:00 day included; none for blanks or the unreadable cell.
  assert.deepEqual(bars(app, "cardio"), ["2026-10-01", "2026-10-04"]);
  assert.deepEqual(findAll(app.section("cardio"), hasClass("hit")).map((hit) => hit.dataset.tip), ["25:30", "0:00"]);
  assert.deepEqual(weeklyColumn(app, "cardio", "week-days"), ["2", "0", "0", "0", "0"]);
  assert.deepEqual(weeklyColumn(app, "cardio", "week-total"), ["25:30", "-", "-", "-", "-"]);
  assert.doesNotMatch(app.section("cardio").textContent, /1530|765/);
  assert.equal(emptyNotes(app, "cardio").length, 0);
});

test("weight lifted shows total, average, highest and lowest in kg", async () => {
  const app = await boot({ editing: true });
  assert.equal(app.tile("weight-total"), "2,450 kg");
  assert.equal(app.tile("weight-average"), "1,225 kg");
  assert.equal(app.tile("weight-highest"), "2,450 kg");
  assert.equal(app.tile("weight-lowest"), "0 kg");
  assert.equal(app.tile("weight-days"), "2");
  assert.match(find(app.section("weight"), hasData("stat", "weight-highest")).textContent, /Thu 01 Oct$/);
  assert.match(find(app.section("weight"), hasData("stat", "weight-lowest")).textContent, /Sun 04 Oct$/);
  assert.deepEqual(bars(app, "weight"), ["2026-10-01", "2026-10-04"]);       // the zero is drawn, blanks are not
  assert.deepEqual(weeklyColumn(app, "weight", "week-total"), ["2,450 kg", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "weight", "week-average"), ["1,225 kg", "-", "-", "-", "-"]);
  assert.deepEqual(findAll(app.section("weight"), hasClass("axis-title")).map((node) => node.textContent),
    ["kg", "Day of month"]);
});

test("calories show total, average, days recorded, highest and lowest, and the weekly figures", async () => {
  const app = await boot({ editing: true });
  assert.equal(app.tile("calories-total"), "4,000 kcal");
  assert.equal(app.tile("calories-average"), "1,333.33 kcal");
  assert.equal(app.tile("calories-days"), "3");
  assert.equal(app.tile("calories-highest"), "2,200 kcal");
  assert.equal(app.tile("calories-lowest"), "0 kcal");
  assert.equal(A_OCT.calories.average_kcal, 1333.33);
  assert.match(find(app.section("calories"), hasData("stat", "calories-highest")).textContent, /Thu 01 Oct$/);
  assert.match(find(app.section("calories"), hasData("stat", "calories-lowest")).textContent, /Sun 04 Oct$/);
  assert.match(find(app.section("calories"), hasData("stat", "calories-total")).textContent, /over 3 days$/);
  assert.deepEqual(bars(app, "calories"), ["2026-10-01", "2026-10-02", "2026-10-04"]);
  assert.deepEqual(findAll(app.section("calories"), hasClass("hit")).map((hit) => hit.dataset.tip),
    ["2,200 kcal", "1,800 kcal", "0 kcal"]);
  assert.deepEqual(weeklyColumn(app, "calories", "week-days"), ["3", "0", "0", "0", "0"]);
  assert.deepEqual(weeklyColumn(app, "calories", "week-total"), ["4,000 kcal", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "calories", "week-average"), ["1,333.33 kcal", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "calories", "week-highest"), ["2,200 kcal", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "calories", "week-lowest"), ["0 kcal", "-", "-", "-", "-"]);
  assert.doesNotMatch(app.section("calories").textContent, /goal|target|remaining|left to|over by|limit/i);
});

test("protein shows total, average, days recorded, highest and lowest, and the weekly figures", async () => {
  const app = await boot({ editing: true });
  assert.equal(app.tile("protein-total"), "140.5 g");
  assert.equal(app.tile("protein-average"), "70.25 g");
  assert.equal(app.tile("protein-days"), "2");
  assert.equal(app.tile("protein-highest"), "140.5 g");
  assert.equal(app.tile("protein-lowest"), "0 g");
  assert.deepEqual(bars(app, "protein"), ["2026-10-01", "2026-10-04"]);
  assert.deepEqual(weeklyColumn(app, "protein", "week-days"), ["2", "0", "0", "0", "0"]);
  assert.deepEqual(weeklyColumn(app, "protein", "week-total"), ["140.5 g", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "protein", "week-average"), ["70.25 g", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "protein", "week-highest"), ["140.5 g", "-", "-", "-", "-"]);
  assert.deepEqual(weeklyColumn(app, "protein", "week-lowest"), ["0 g", "-", "-", "-", "-"]);
  assert.doesNotMatch(app.section("protein").textContent, /goal|target|remaining|left to|over by|limit/i);
});

test("body measurements keep the six cards", async () => {
  const app = await boot({ editing: true });
  assert.deepEqual(findAll(app.section("measurements"), hasData("measure")).map((node) => node.dataset.measure),
    ["weight_kg", "waist_cm", "chest_cm", "bicep_cm", "thigh_cm", "forearm_cm"]);
  const weight = measureCard(app, "weight_kg");
  assert.equal(value(weight, "current"), "72 kg");
  assert.match(find(weight, hasData("field", "current")).textContent, /current, Sun 11 Oct/);
  assert.equal(value(weight, "previous"), "72.5 kg");
  assert.equal(value(weight, "change"), "-0.5 kg");
  assert.equal(value(weight, "change-percentage"), "-0.69%");
  assert.equal(findAll(weight, hasClass("dot")).length, 2);
  const waist = measureCard(app, "waist_cm");
  assert.equal(value(waist, "current"), "84 cm");
  assert.equal(value(waist, "previous"), "-");
  assert.equal(find(waist, hasData("note", "previous")).textContent,
    "No earlier Sunday in this month, so there is no previous value.");
  // The chest cell is unreadable in the workbook: no value is made up for it.
  assert.equal(find(measureCard(app, "chest_cm"), hasData("empty")).textContent, "No values recorded this month.");
  // The measurement editor is still there beside them.
  assert.equal(findAll(el(app, "measurements-body"), (node) => node.tagName === "button").length, 4);
  openSunday(app, "2026-10-04");
  assert.ok(mOpen(app));
});

test("a month with nothing recorded shows empty states, never zeroes", async () => {
  const app = await boot({ editing: true });
  await app.select("2026-11");
  assert.equal(app.title.textContent, "November 2026");
  assert.ok(app.calls.includes("/api/months/2026/11/analytics"));
  assert.deepEqual(findAll(app.body, hasData("section")).map((node) => node.dataset.section), SECTIONS);
  assert.equal(A_NOV.calories.total_kcal, null);
  assert.match(emptyNotes(app, "habits")[0], /^This month has not started yet\.All 30 days are pending\./);
  for (const habit of ["exercise", "junk_food"]) {
    assert.equal(value(habitCard(app, habit), "percentage"), "-");
    assert.equal(value(habitCard(app, habit), "pending"), "30 days");
    assert.equal(value(habitCard(app, habit), "missed"), "0 days");
    assert.equal(find(habitCard(app, habit), hasClass("figure-label")).textContent, "nothing counted yet");
  }
  for (const [name, tiles] of Object.entries({
    cardio: ["cardio-total", "cardio-average", "cardio-longest"],
    weight: ["weight-total", "weight-average", "weight-highest", "weight-lowest"],
    calories: ["calories-total", "calories-average", "calories-highest", "calories-lowest"],
    protein: ["protein-total", "protein-average", "protein-highest", "protein-lowest"],
  })) {
    for (const stat of tiles) assert.equal(app.tile(stat), "-", stat);
    assert.equal(app.tile(`${name}-days`), "0");
    assert.equal(emptyNotes(app, name).length, 1, name);
    assert.equal(bars(app, name).length, 0);
  }
  assert.match(emptyNotes(app, "calories")[0], /^No calories recorded this month\./);
  assert.match(emptyNotes(app, "protein")[0], /^No protein recorded this month\./);
  assert.match(emptyNotes(app, "cardio")[0], /^No cardio recorded this month\./);
  assert.match(emptyNotes(app, "measurements")[0], /^No Sunday measurements recorded this month\./);
  assert.equal(findAll(app.body, (node) => node.tagName === "svg").length, 0);
  const numbers = ["cardio", "weight", "calories", "protein"].map((name) => app.section(name).textContent).join(" ");
  assert.doesNotMatch(numbers, /\d:\d\d|\d (kg|kcal|g)\b/);
  assert.doesNotMatch(app.body.textContent, /\b(null|undefined|NaN|Infinity)\b/);
  assert.equal(findAll(app.section("daily"), both(hasClass("mark"), hasData("status", "pending"))).length, 60);
  for (const cell of findAll(app.section("weekly"), hasData("stat", "percentage"))) assert.equal(cell.textContent, "-");
});

test("switching between months shows each month's own analytics", async () => {
  const app = await boot({ editing: true });
  assert.equal(app.tile("calories-total"), "4,000 kcal");
  app.calls.length = 0;
  await app.select("2026-11");
  assert.ok(app.calls.includes("/api/months/2026/11/analytics"));
  assert.ok(!app.calls.includes("/api/months/2026/10/analytics"));
  assert.equal(app.tile("calories-total"), "-");
  assert.doesNotMatch(app.body.textContent, /4,000|140\.5|Oct/);
  app.calls.length = 0;
  await app.select("2026-10");
  assert.ok(!app.calls.includes("/api/months/2026/11/analytics"));
  assert.equal(app.tile("calories-total"), "4,000 kcal");
  assert.equal(value(habitCard(app, "exercise"), "percentage"), "8.33%");
});

test("a refresh updates the analytics behind an open editor without touching it", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-02");
  type(app, { calories_kcal: "2000", exercise: "Completed" });

  const changed = structuredClone(EDITING.data["2026-10"]);
  changed.analytics.calories.total_kcal = 9000;
  changed.analytics.exercise.counts.completed = 5;
  changed.analytics.cardio.total_display = "99:59";
  app.server.data["2026-10"] = changed;
  await app.save();
  assert.equal(app.tile("calories-total"), "9,000 kcal");
  assert.equal(value(habitCard(app, "exercise"), "completed"), "5 days");
  assert.equal(app.tile("cardio-total"), "99:59");
  assert.ok(isOpen(app));
  assert.equal(field(app, "calories_kcal").value, "2000");
  assert.equal(field(app, "exercise").value, "Completed");

  // The same with the measurement editor.
  el(app, "edit-cancel").fire("click");
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "70.5" });
  changed.analytics.protein.total_g = 555;
  await app.save();
  assert.equal(app.tile("protein-total"), "555 g");
  assert.ok(mOpen(app));
  assert.equal(mField(app, "weight_kg").value, "70.5");
  assert.equal(app.requests.length, 0);
});

test("after a save the analytics follow at once, and the next poll reads the month once more", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-05");
  type(app, { exercise: "Completed", calories_kcal: "2100" });
  app.server.data["2026-10"].analytics.calories.total_kcal = 6100;
  app.calls.length = 0;
  await pressSave(app);
  // The save asks for the analytics, once; it does not reload the page or the month.
  assert.deepEqual(app.calls, ["/api/months/2026/10/analytics"]);
  assert.equal(rowText(app, "2026-10-05")[1], "Completed");
  assert.equal(app.tile("calories-total"), "6,100 kcal");
  // The workbook changed, so the next poll fetches the month and its analytics once.
  app.calls.length = 0;
  await app.poll();
  assert.deepEqual(app.calls.filter((url) => url.endsWith("/analytics")), ["/api/months/2026/10/analytics"]);
  assert.equal(app.tile("calories-total"), "6,100 kcal");
  app.calls.length = 0;
  await app.poll();
  assert.deepEqual(app.calls, ["/api/status"]);
});

test("failed or unusable analytics keep the last dashboard and say so", async () => {
  const app = await boot({ editing: true });
  const before = app.body.textContent;
  const table = wholeMonth(app).textContent;
  const locked = { status: 423, body: { error: { code: "workbook_locked", message: "The workbook is locked." } } };

  app.server.override = { "/api/months/2026/10/analytics": locked };
  await app.save();
  assert.equal(app.notice.hidden, false);
  assert.equal(app.notice.textContent,
    "The workbook is locked. Still showing the last data that loaded for October 2026.");
  assert.equal(app.body.textContent, before);
  app.server.override = null;
  await app.poll();
  assert.equal(app.notice.hidden, true);

  // Analytics with a part missing, or with values of the wrong kind: nothing is half-drawn.
  for (const spoil of [
    (analytics) => { delete analytics.calories; },
    (analytics) => { analytics.exercise.counts = null; },
    (analytics) => { analytics.weekly = null; },
    (analytics) => { analytics.daily[0].exercise_status = "superb"; },
  ]) {
    const broken = structuredClone(EDITING.data["2026-10"]);
    spoil(broken.analytics);
    broken.month.days[0].calories_kcal = 9999;
    app.server.data["2026-10"] = broken;
    await app.save();
    assert.equal(app.notice.hidden, false);
    assert.match(app.notice.textContent, /^The page could not display this data/);
    assert.equal(app.body.textContent, before);
    assert.equal(wholeMonth(app).textContent, table);
  }

  app.server.data["2026-10"] = structuredClone(EDITING.data["2026-10"]);
  await app.poll();
  assert.equal(app.notice.hidden, true);
  assert.equal(app.body.textContent, before);

  // A month that fails to load keeps the one on screen.
  app.server.override = { "/api/months/2026/11": locked };
  await app.select("2026-11");
  assert.match(app.notice.textContent, /^Could not load November 2026\./);
  assert.equal(app.title.textContent, "October 2026");
  assert.equal(app.body.textContent, before);
});

test("null figures from the backend are shown as a dash, not as zero", async () => {
  const app = await boot({ editing: true });
  const changed = structuredClone(EDITING.data["2026-10"]);
  changed.analytics.exercise.completion_percentage = null;
  changed.analytics.junk_food.success_percentage = null;
  Object.assign(changed.analytics.protein, {
    days_recorded: 1, total_g: 0, average_g: 0, highest_g: 0, lowest_g: 0,
    highest_date: "2026-10-04", lowest_date: "2026-10-04",
  });
  changed.analytics.daily[0].protein_g = null;
  changed.analytics.weekly[0].protein = { days_recorded: 1, total_g: 0, average_g: 0, highest_g: 0, lowest_g: 0 };
  app.server.data["2026-10"] = changed;
  await app.save();
  assert.equal(value(habitCard(app, "exercise"), "percentage"), "-");
  assert.equal(value(habitCard(app, "junk_food"), "percentage"), "-");
  // A month whose only protein entry is a recorded zero: zero is shown, as data.
  assert.equal(app.tile("protein-total"), "0 g");
  assert.equal(app.tile("protein-average"), "0 g");
  assert.equal(app.tile("protein-days"), "1");
  assert.deepEqual(bars(app, "protein"), ["2026-10-04"]);
  assert.deepEqual(weeklyColumn(app, "protein", "week-total"), ["0 g", "-", "-", "-", "-"]);
  assert.equal(emptyNotes(app, "protein").length, 0);
});

test("no goals, scores or rankings appear in a month", async () => {
  const app = await boot({ editing: true });
  for (const key of ["2026-10", "2026-11"]) {
    await app.select(key);
    const text = app.body.textContent + wholeMonth(app).textContent;
    assert.doesNotMatch(text, /year|annual|goal|target|score|rating|\bgrade|rank|winner/i, key);
    assert.doesNotMatch(text, /muscle|1RM|bench|squat|deadlift/i, key);
  }
});

// ---------------------------------------------------------------- motion, today, and quiet updates
//
// What moves is decided by classes and attributes the page sets; the movement
// itself is in the stylesheet. These tests check when those are set, and that
// a refresh in the background sets none of the ones that draw a month in.

const drawnIn = (app) => findAll(app.body, hasData("section")).filter(hasClass("reveal")).length;
const tinted = (app) => findAll(el(app, "month-view"), hasClass("changed"));
const todayStrip = (app) => el(app, "today-strip");
const todayItem2 = (app, name) => find(todayStrip(app), both(hasClass("today-item"), hasData("field", name)));
const todayButton = (app) => findAll(todayStrip(app), (node) => node.tagName === "button");

test("a month coming onto the screen is drawn in once, and a refresh draws nothing in", async () => {
  const app = await boot({ editing: true });
  await app.select("2026-11");
  assert.equal(drawnIn(app), 8);                                 // every section of the month that arrived
  const turn = el(app, "section-tracker").dataset.enter;
  assert.ok(["a", "b"].includes(turn));
  assert.equal(el(app, "section-sunday").dataset.enter, turn);
  assert.equal(todayStrip(app).dataset.enter, turn);

  // The workbook is saved and the page refreshes, several times: nothing is drawn in again.
  for (let round = 0; round < 3; round++) {
    await app.save();
    assert.equal(drawnIn(app), 0);
    assert.equal(findAll(app.body, hasData("section")).length, 8);
    assert.equal(el(app, "section-tracker").dataset.enter, turn);  // unchanged, so it does not replay
  }
  await app.poll();
  assert.equal(drawnIn(app), 0);

  // Going to another month draws that month in, with the other turn.
  await app.select("2026-10");
  assert.equal(drawnIn(app), 8);
  assert.notEqual(el(app, "section-tracker").dataset.enter, turn);
  assert.equal(el(app, "section-sunday").dataset.enter, el(app, "section-tracker").dataset.enter);

  // The same holds for the other workbook.
  const old = await boot();
  await old.select("2026-11");
  assert.equal(drawnIn(old), 8);
  await old.save();
  assert.equal(drawnIn(old), 0);
});

test("a refresh tints only the figures and rows that changed", async () => {
  const app = await boot({ editing: true });
  await app.save();
  assert.equal(tinted(app).length, 0);                           // nothing changed, nothing tinted

  showDay(app, "2026-10-02");            // a row can only be tinted while its day is one of the five on screen
  const changed = structuredClone(EDITING.data["2026-10"]);
  changed.analytics.calories.total_kcal = 9000;
  changed.analytics.exercise.counts.completed = 5;
  changed.month.days[1].calories_kcal = 1900;
  changed.month.measurements[0].weight_kg = 73;
  app.server.data["2026-10"] = changed;
  await app.save();

  const names = tinted(app).map((node) => node.dataset.date || node.textContent).sort();
  assert.deepEqual(names, ["2026-10-02", "2026-10-04", "5 days", "9,000 kcal"]);
  assert.ok(hasClass("changed")(trackerRow(app, "2026-10-02")));
  assert.ok(!hasClass("changed")(trackerRow(app, "2026-10-01")));
  assert.ok(hasClass("changed")(sundayRow(app, "2026-10-04")));
  assert.equal(app.tile("calories-total"), "9,000 kcal");
  assert.ok(hasClass("changed")(find(find(app.section("calories"), hasData("stat", "calories-total")), hasClass("value"))));
  assert.ok(!hasClass("changed")(find(find(app.section("calories"), hasData("stat", "calories-average")), hasClass("value"))));
  assert.equal(drawnIn(app), 0);                                 // tinted, not drawn in

  // The next refresh brings nothing new, so the tint is not given again.
  await app.save();
  assert.equal(tinted(app).length, 0);

  // A month that has just arrived is drawn in, not tinted.
  await app.select("2026-11");
  assert.equal(tinted(app).length, 0);
});

test("a saved row is shown and tinted at once, and the analytics are asked for once", async () => {
  const app = await boot({ editing: true });
  await app.save();
  openDay(app, "2026-10-05");
  type(app, { exercise: "Completed", calories_kcal: "2100" });
  // What the backend says about the month once the save is in.
  app.server.data["2026-10"].analytics.calories.total_kcal = 6100;
  app.calls.length = 0;
  await pressSave(app);

  assert.deepEqual(app.calls, ["/api/months/2026/10/analytics"]);       // one request, for the analytics only
  assert.equal(rowText(app, "2026-10-05")[1], "Completed");
  assert.equal(app.tile("calories-total"), "6,100 kcal");                // without waiting for a poll
  assert.deepEqual(tinted(app).map((node) => node.dataset.date || node.textContent).sort(),
    ["2026-10-05", "6,100 kcal"]);
  assert.equal(drawnIn(app), 0);                                         // the dashboard is not drawn in again
  assert.equal(app.title.textContent, "October 2026");
  assert.equal(app.notice.hidden, true);

  // The same after a measurement save.
  openSunday(app, "2026-10-18");
  mType(app, { weight_kg: "71" });
  app.calls.length = 0;
  await mSave(app);
  assert.deepEqual(app.calls, ["/api/months/2026/10/analytics"]);
  assert.ok(hasClass("changed")(sundayRow(app, "2026-10-18")));
  assert.equal(drawnIn(app), 0);

  // The poll that follows reads the month again, once, quietly.
  app.calls.length = 0;
  await app.poll();
  assert.deepEqual(app.calls.filter((url) => url.endsWith("/analytics")), ["/api/months/2026/10/analytics"]);
  assert.equal(drawnIn(app), 0);
  app.calls.length = 0;
  await app.poll();
  assert.deepEqual(app.calls, ["/api/status"]);
});

test("if the analytics cannot be read after a save, the saved row stays and nothing else changes", async () => {
  const app = await boot({ editing: true });
  const before = app.body.textContent;
  const locked = { status: 423, body: { error: { code: "workbook_locked", message: "The workbook is locked." } } };
  for (const failure of [locked, { status: 200, body: { month: {} } }]) {
    app.server.override = { "/api/months/2026/10/analytics": failure };
    openDay(app, "2026-10-07");
    type(app, { protein_g: failure === locked ? "111" : "112" });
    await pressSave(app);
    assert.ok(!isOpen(app));
    assert.equal(rowText(app, "2026-10-07")[5], failure === locked ? "111" : "112");   // the save is on screen
    assert.match(el(app, "saved-note").textContent, /^Saved: Wed 07 Oct/);
    assert.equal(app.body.textContent, before);                          // the dashboard is as it was
    assert.equal(app.notice.hidden, true);                               // and no error is put in the way
  }
  // Normal polling then brings the analytics up to date.
  app.server.override = null;
  app.server.data["2026-10"].analytics.protein.total_g = 363.5;
  await app.poll();
  assert.equal(app.tile("protein-total"), "363.5 g");
  assert.equal(app.notice.hidden, true);
});

test("today's entries come first, with Edit today in a month", async () => {
  const app = await boot({ editing: true });
  const strip = todayStrip(app);
  assert.equal(strip.hidden, false);
  assert.equal(find(strip, hasClass("today-kicker")).textContent, "Today");
  assert.equal(find(strip, hasClass("today-date")).textContent, "Tue 20 Oct");
  assert.deepEqual(findAll(strip, hasClass("today-item")).map((item) => [item.dataset.field, item.children[0].textContent]), [
    ["exercise", "Exercise"], ["junk_food", "Junk Food"], ["cardio", "Cardio"],
    ["calories_kcal", "Calories"], ["protein_g", "Protein"], ["weight_lifted_kg", "Weight Lifted"],
  ]);
  // Nothing is entered for today: said in words, never shown as zero.
  for (const item of findAll(strip, hasClass("today-item"))) {
    assert.equal(find(item, hasClass("value")).textContent, "Not entered", item.dataset.field);
  }
  assert.equal(todayButton(app).length, 1);
  assert.equal(todayButton(app)[0].textContent, "Edit today");
  assert.equal(todayButton(app)[0].attributes["aria-label"], "Edit today, Tue 20 Oct");
  assert.equal(todayButton(app)[0].attributes.type, "button");

  // It opens the same editor, on today.
  todayButton(app)[0].fire("click");
  assert.ok(isOpen(app));
  assert.match(el(app, "edit-date").textContent, /^Tuesday,? 20 October 2026$/);
  type(app, { exercise: "Rest Day", junk_food: "Controlled", cardio: "25:30", calories_kcal: "2100", weight_lifted_kg: "0" });
  await pressSave(app);
  assert.equal(app.requests[0].url, "/api/months/2026/10/days/20");
  const shown = (name) => find(todayItem2(app, name), hasClass("value"));
  assert.equal(shown("exercise").textContent, "Rest Day");
  assert.equal(shown("exercise").children[0].className, "mark rest");
  assert.equal(shown("junk_food").textContent, "Controlled");
  assert.equal(shown("cardio").textContent, "25:30");
  assert.equal(shown("calories_kcal").textContent, "2,100 kcal");
  assert.equal(shown("protein_g").textContent, "Not entered");
  assert.equal(shown("weight_lifted_kg").textContent, "0 kg");            // a recorded zero is a value
  assert.match(rowText(app, "2026-10-20").join("|"), /^Tue 20 OctToday\|Rest Day\|Controlled\|25:30\|2,100\|-\|0\|Edit$/);
  // Focus goes back to the button that opened the editor, in the redrawn strip.
  assert.equal(app.document.activeElement, todayButton(app)[0]);
  // Opened from the row instead, it goes back to the row.
  openDay(app, "2026-10-20");
  type(app, { protein_g: "120" });
  await pressSave(app);
  assert.equal(app.document.activeElement, editButton(app, "2026-10-20"));

  // A month that does not hold today has no strip.
  await app.select("2026-11");
  assert.equal(todayStrip(app).hidden, true);
  assert.equal(todayStrip(app).children.length, 0);
});

test("each status is shown with its own mark and its word, and each value with a label for small screens", async () => {
  const app = await boot({ editing: true });
  const cellOf = (date, index) => trackerRow(app, date).children[index];
  const seen = (date, index) => {
    const td = cellOf(date, index);
    return [td.children[0].className, td.children[0].attributes["aria-hidden"], td.children[1], td.className];
  };
  assert.deepEqual(seen("2026-10-01", 1), ["mark completed", "true", "Completed", "status"]);
  assert.deepEqual(seen("2026-10-02", 1), ["mark partial", "true", "Partial", "status"]);
  assert.deepEqual(seen("2026-10-03", 1), ["mark rest", "true", "Rest Day", "status"]);
  assert.deepEqual(seen("2026-10-04", 1), ["mark missed", "true", "Missed", "status"]);
  assert.deepEqual(seen("2026-10-01", 2), ["mark completed", "true", "None", "status"]);
  assert.deepEqual(seen("2026-10-02", 2), ["mark partial", "true", "Controlled", "status"]);
  assert.deepEqual(seen("2026-10-03", 2), ["mark missed", "true", "Had", "status"]);
  // A blank: on a past day it has the mark of a day that was not entered; today and later, an empty box.
  assert.deepEqual(seen("2026-10-04", 2), ["mark unentered", "true", "Not entered", "status blank"]);
  assert.deepEqual(seen("2026-10-05", 1), ["mark unentered", "true", "Not entered", "status blank"]);
  assert.deepEqual(seen("2026-10-20", 1), ["mark", "true", "Not entered", "status blank"]);
  assert.deepEqual(seen("2026-10-25", 2), ["mark", "true", "Not entered", "status blank"]);
  // The seven statuses and the two kinds of blank use six looks between them, and every one has its word.
  const marks = new Set(findAll(wholeMonth(app), hasClass("mark")).map((node) => node.className));
  assert.deepEqual([...marks].sort(), ["mark", "mark completed", "mark missed", "mark partial", "mark rest", "mark unentered"]);
  assert.equal(findAll(wholeMonth(app), hasClass("mark")).length, 61);           // one cell is unreadable instead

  assert.deepEqual(trackerRow(app, "2026-10-01").children.map((td) => td.dataset.label),
    [undefined, "Exercise", "Junk Food", "Cardio", "Calories", "Protein (g)", "Lifted (kg)", undefined]);
  assert.deepEqual(sundayRow(app, "2026-10-04").children.map((td) => td.dataset.label),
    [undefined, "Weight (kg)", "Waist (cm)", "Chest (cm)", "Bicep (cm)", "Thigh (cm)", "Forearm (cm)", undefined]);

  // The other workbook is labelled and marked in the same way.
  const old = await boot();
  assert.deepEqual(trackerRow(old, "2026-10-01").children.map((td) => td.dataset.label),
    [undefined, "Exercise", "Junk Food", "Cardio", "Calories", "Protein (g)", "Lifted (kg)", undefined]);
  assert.equal(findAll(wholeMonth(old), hasClass("mark")).length, 62);
  assert.equal(findAll(wholeMonth(old), hasClass("box")).length, 0);
});

test("the note about unreadable cells says where they can be corrected", async () => {
  const app = await boot({ editing: true });
  assert.equal(el(app, "issues").hidden, false);
  assert.equal(el(app, "issues-help").textContent,
    "Correct these in Excel and save, or replace the value with Edit on that row. They are shown as unreadable, not guessed.");
  // Every month that is drawn can be edited, so the note is the same everywhere.
  const old = await boot();
  assert.equal(el(old, "issues-help").textContent, el(app, "issues-help").textContent);
  assert.equal(el(old, "issues").hidden, true);              // and this workbook has nothing unreadable in it
});

test("choosing a month marks the view as loading only until the month arrives", async () => {
  const app = await boot({ editing: true });
  const view = el(app, "month-view");
  const select = el(app, "month-select");
  assert.equal(view.attributes["aria-busy"], "false");
  select.value = "2026-11";
  select.fire("change");
  assert.equal(view.attributes["aria-busy"], "true");            // straight away, before the answer
  await settle();
  assert.equal(view.attributes["aria-busy"], "false");
  assert.equal(app.title.textContent, "November 2026");

  // A month that fails to load is not left looking as if it were still loading.
  app.server.override = { "/api/months/2026/10": { status: 423, body: { error: { code: "workbook_locked", message: "The workbook is locked." } } } };
  await app.select("2026-10");
  assert.equal(view.attributes["aria-busy"], "false");
  assert.equal(app.notice.hidden, false);
  // Polling never marks it as loading.
  app.server.override = null;
  await app.save();
  assert.equal(view.attributes["aria-busy"], "false");
});

test("the motion is in the stylesheet and needs no library", async () => {
  const sources = SCRIPTS.map((script) => script.source).join("\n");
  assert.doesNotMatch(sources, /\.animate\(|setInterval|import\s|require\(|gsap|anime\(/);
  // The page draws a month in from exactly one place, and only for a month that is arriving.
  const app = SCRIPTS.find((script) => script.name === "app.js").source;
  assert.equal(app.match(/drawIn\(/g).length, 2);                // its definition and its one use
  assert.match(app, /if \(entering\) drawIn\(sections\);\s*else markChanges\(before, els\.view\);/);
  assert.equal(app.match(/classList\.add\("reveal"\)/g).length, 1);
});

test("a saved confirmation does not follow the user to another month", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-02");
  type(app, { exercise: "Completed" });
  await pressSave(app);
  openSunday(app, "2026-10-04");
  mType(app, { weight_kg: "72" });
  await mSave(app);
  assert.equal(el(app, "saved-note").hidden, false);
  assert.equal(el(app, "measure-saved-note").hidden, false);
  // A refresh of the same month leaves them be.
  await app.poll();
  assert.equal(el(app, "saved-note").hidden, false);
  // Another month arrives: they were about the month before, so they go.
  await app.select("2026-11");
  assert.equal(el(app, "saved-note").hidden, true);
  assert.equal(el(app, "measure-saved-note").hidden, true);
});

// ---------------------------------------------------------------- the page on a phone
//
// The layout is in the stylesheet. These tests check what the page gives it to
// work with: the unit of a figure as a part of its own, the days that have not
// come yet, the link to today, and the charts drawn for the width of a phone.

const unitsOf = (node) => findAll(node, hasClass("unit")).map((unit) => unit.textContent);
// The element holding a figure: the one marked as the value, under the stat or field of that name.
const figureOf = (root, name) => {
  const node = find(root, (n) => n.dataset.stat === name || n.dataset.field === name);
  return hasClass("value")(node) ? node : find(node, hasClass("value"));
};
const upcomingRows = (root) =>
  findAll(root, (node) => node.tagName === "tr" && hasClass("upcoming")(node)).map((tr) => tr.dataset.date);
const chartOf = (root) => find(root, (node) => node.tagName === "svg");
const dayTicks = (svg) =>
  findAll(svg, both(hasClass("tick"), (node) => node.attributes["text-anchor"] === "middle")).map((node) => node.textContent);

test("a figure carries its unit in a part of its own and still reads the same", async () => {
  const app = await boot({ editing: true });
  const parts = (node) => [node.children[0], unitsOf(node)];

  const calories = figureOf(app.section("calories"), "calories-total");
  assert.equal(calories.textContent, "4,000 kcal");
  assert.deepEqual(parts(calories), ["4,000", [" kcal"]]);
  assert.deepEqual(parts(figureOf(app.section("protein"), "protein-total")), ["140.5", [" g"]]);
  assert.deepEqual(parts(figureOf(app.section("weight"), "weight-total")), ["2,450", [" kg"]]);
  assert.deepEqual(parts(figureOf(measureCard(app, "weight_kg"), "current")), ["72", [" kg"]]);

  const exercise = habitCard(app, "exercise");
  const percentage = figureOf(exercise, "percentage");
  assert.match(percentage.children[0], /^\d+(\.\d+)?$/);
  assert.deepEqual(unitsOf(percentage), ["%"]);
  assert.equal(percentage.textContent, `${percentage.children[0]}%`);
  assert.deepEqual(parts(figureOf(exercise, "completed")), ["1", [" day"]]);
  assert.equal(unitsOf(figureOf(exercise, "current-streak")).length, 1);
  assert.match(figureOf(exercise, "longest-streak").textContent, /^\d+ days?$/);

  // A duration, a count on its own and a dash have no unit to set apart.
  for (const [section, stat, text] of [
    ["cardio", "cardio-total", "25:30"], ["cardio", "cardio-days", "2"], ["calories", "calories-days", "3"],
  ]) {
    const node = figureOf(app.section(section), stat);
    assert.equal(node.textContent, text);
    assert.deepEqual(unitsOf(node), [], stat);
  }
  await app.select("2026-11");
  assert.deepEqual(parts(figureOf(app.section("calories"), "calories-total")), ["-", []]);

  // Today's figures are set the same way, and words never are.
  await app.select("2026-10");
  openDay(app, "2026-10-20");
  type(app, { calories_kcal: "2100", cardio: "25:30" });
  await pressSave(app);
  const shown = (name) => find(todayItem2(app, name), hasClass("value"));
  assert.deepEqual(parts(shown("calories_kcal")), ["2,100", [" kcal"]]);
  assert.deepEqual(parts(shown("cardio")), ["25:30", []]);
  assert.deepEqual(parts(shown("protein_g")), ["Not entered", []]);
  // The daily tracker keeps plain numbers: each of its columns names the unit once.
  assert.equal(findAll(wholeMonth(app), hasClass("unit")).length, 0);
  assert.equal(findAll(el(app, "measurements-body"), hasClass("unit")).length, 0);

  // The same in the other workbook.
  const old = await boot();
  assert.deepEqual(unitsOf(figureOf(habitCard(old, "exercise"), "percentage")), ["%"]);
  assert.deepEqual(parts(figureOf(habitCard(old, "exercise"), "completed")), ["8", [" days"]]);
  assert.deepEqual(parts(figureOf(old.section("weight"), "weight-total")), ["7,270.5", [" kg"]]);
  assert.deepEqual(unitsOf(figureOf(old.section("cardio"), "cardio-total")), []);
});

test("days and Sundays still to come with nothing in them are marked, so a phone can show only their dates", async () => {
  const app = await boot({ editing: true });
  // Today is 20 October: the 21st to the 31st have not come and hold nothing.
  const rest = Array.from({ length: 11 }, (_, index) => `2026-10-${21 + index}`);
  assert.deepEqual(upcomingRows(wholeMonth(app)), rest);
  assert.deepEqual(upcomingRows(el(app, "measurements-body")), ["2026-10-25"]);
  // Today and the days before it never are, entered or not.
  assert.ok(!hasClass("upcoming")(trackerRow(app, "2026-10-20")));
  assert.ok(!hasClass("upcoming")(trackerRow(app, "2026-10-19")));
  assert.ok(!hasClass("upcoming")(sundayRow(app, "2026-10-18")));
  // The row itself is whole: every cell, its label and its Edit button are there for a wider screen.
  assert.equal(trackerRow(app, "2026-10-25").children.length, 8);
  assert.equal(trackerRow(app, "2026-10-25").children[4].dataset.label, "Calories");
  assert.equal(editButton(app, "2026-10-25").disabled, true);
  assert.match(trackerRow(app, "2026-10-26").className, /\bweek-start\b/);     // and it keeps its other marks

  // A day to come that already holds something, or a cell that could not be read, is shown in full.
  const changed = structuredClone(EDITING.data["2026-10"]);
  changed.month.days[24].calories_kcal = 2000;                                 // 25 October
  changed.month.measurements[3].weight_kg = 71;                                // Sunday 25 October
  changed.month.issues.push({ date: "2026-10-27", field: "protein_g", value: "lots", message: "Not a number." });
  app.server.data["2026-10"] = changed;
  await app.save();
  assert.deepEqual(upcomingRows(wholeMonth(app)), rest.filter((date) => !["2026-10-25", "2026-10-27"].includes(date)));
  assert.deepEqual(upcomingRows(el(app, "measurements-body")), []);

  // A whole month that has not started: every day of it.
  await app.select("2026-11");
  assert.equal(upcomingRows(wholeMonth(app)).length, 30);
  assert.equal(upcomingRows(el(app, "measurements-body")).length, 5);

  // The same in the other workbook.
  const old = await boot();
  assert.deepEqual(upcomingRows(wholeMonth(old)), rest);
  assert.deepEqual(upcomingRows(el(old, "measurements-body")), ["2026-10-25"]);
  await old.select("2026-11");
  assert.equal(upcomingRows(wholeMonth(old)).length, 29);                          // 2 November has an entry
  assert.ok(!hasClass("upcoming")(trackerRow(old, "2026-11-02")));
  assert.equal(upcomingRows(el(old, "measurements-body")).length, 4);          // and so has Sunday 1 November
});

test("the link to today is offered only in the month that holds today", async () => {
  const app = await boot({ editing: true });
  const nav = el(app, "section-nav");
  assert.equal(nav.dataset.today, "yes");
  assert.equal(todayStrip(app).hidden, false);
  await app.select("2026-11");
  assert.equal(nav.dataset.today, "no");
  assert.equal(todayStrip(app).hidden, true);
  await app.select("2026-10");
  assert.equal(nav.dataset.today, "yes");
  // A refresh keeps it, and so does a save.
  await app.save();
  assert.equal(nav.dataset.today, "yes");

  const old = await boot();
  assert.equal(el(old, "section-nav").dataset.today, "yes");
  await old.select("2026-12");
  assert.equal(el(old, "section-nav").dataset.today, "no");
});

test("a phone gets charts drawn for its width, and they are drawn again when the window is no longer one", async () => {
  const wide = await boot({ editing: true, narrow: false });
  const app = await boot({ editing: true, narrow: true });
  const everyDay = Array.from({ length: 31 }, (_, index) => String(index + 1));
  const hits = (page, name) => findAll(page.section(name), hasClass("hit"))
    .map((hit) => [hit.dataset.tip, hit.dataset.tipLabel, hit.attributes["aria-label"], hit.attributes.tabindex]);

  const full = chartOf(wide.section("calories"));
  assert.equal(full.className, "chart");
  assert.equal(full.attributes.viewBox, "0 0 760 270");
  assert.deepEqual(dayTicks(full), everyDay);

  const small = chartOf(app.section("calories"));
  assert.equal(small.className, "chart compact");
  assert.equal(small.attributes.viewBox, "0 0 340 232");
  assert.deepEqual(dayTicks(small), ["1", "5", "10", "15", "20", "25", "30"]);     // the first, then every fifth
  // Nothing is left out of it: the same bars, the same values to point at, the same words for a screen reader.
  assert.deepEqual(bars(app, "calories"), bars(wide, "calories"));
  assert.equal(bars(app, "calories").length, 3);
  assert.deepEqual(hits(app, "calories"), hits(wide, "calories"));
  assert.equal(small.attributes["aria-label"], full.attributes["aria-label"]);
  assert.deepEqual(findAll(small, hasClass("point-label")).map((node) => node.textContent),
    findAll(full, hasClass("point-label")).map((node) => node.textContent));
  assert.deepEqual(findAll(small, hasClass("axis-title")).map((node) => node.textContent), ["kcal", "Day of month"]);
  // Everything that can be pointed at lies inside the drawing.
  for (const hit of findAll(small, hasClass("hit"))) {
    const [x, width] = [Number(hit.attributes.x), Number(hit.attributes.width)];
    assert.ok(x >= 0 && x + width <= 340 && width > 0, `${x} ${width}`);
  }
  for (const name of ["protein", "cardio", "weight"]) {
    assert.equal(chartOf(app.section(name)).className, "chart compact", name);
    assert.deepEqual(hits(app, name), hits(wide, name), name);
  }

  // The line of a measurement is a small one with nothing written on it. Its points are still
  // there to point at, and a screen reader is told the same as on a wide screen.
  const line = chartOf(measureCard(app, "weight_kg"));
  const fullLine = chartOf(measureCard(wide, "weight_kg"));
  assert.equal(fullLine.className, "chart small");
  assert.equal(findAll(fullLine, hasClass("tick")).length, 4);                    // the four Sundays
  assert.equal(line.className, "chart small compact");
  assert.equal(line.attributes.viewBox, "0 0 160 64");
  assert.equal(findAll(line, (node) => node.tagName === "text").length, 0);
  assert.equal(findAll(line, hasClass("dot")).length, 2);
  assert.equal(findAll(line, hasClass("line")).length, 1);
  assert.deepEqual(findAll(line, hasClass("hit")).map((hit) => hit.attributes["aria-label"]),
    ["Sun 04 Oct: 72.5 kg", "Sun 11 Oct: 72 kg"]);
  assert.equal(line.attributes["aria-label"], fullLine.attributes["aria-label"]);
  // The figures around the charts are the same on both.
  assert.equal(app.tile("calories-total"), wide.tile("calories-total"));

  // The page asks the window about the one width, and listens for it to change.
  assert.deepEqual(app.media.listeners.map((entry) => [entry.query, entry.type]), [["(max-width: 599px)", "change"]]);
  assert.ok(app.media.queries.every((query) => query === "(max-width: 599px)"));

  // The window is made wider: the charts are drawn again for it, from what the page already has.
  app.calls.length = 0;
  app.media.matches = false;
  app.media.listeners[0].handler();
  assert.equal(chartOf(app.section("calories")).className, "chart");
  assert.deepEqual(dayTicks(chartOf(app.section("calories"))), everyDay);
  assert.equal(chartOf(measureCard(app, "weight_kg")).className, "chart small");
  assert.deepEqual(app.calls, []);                                               // nothing is fetched
  assert.equal(drawnIn(app), 0);                                                 // nothing is drawn in
  assert.equal(tinted(app).length, 0);                                           // and nothing is tinted
  assert.equal(app.tile("calories-total"), "4,000 kcal");
  assert.deepEqual(findAll(app.body, hasData("section")).map((node) => node.dataset.section), SECTIONS);

  // It is always the month on screen that is drawn again, with what a save has since brought.
  openDay(app, "2026-10-05");
  type(app, { calories_kcal: "2100" });
  app.server.data["2026-10"].analytics.calories.total_kcal = 6100;
  await pressSave(app);
  app.media.matches = true;
  app.media.listeners[0].handler();
  assert.equal(app.tile("calories-total"), "6,100 kcal");
  assert.equal(chartOf(app.section("calories")).className, "chart compact");
  await app.select("2026-11");
  app.media.matches = false;
  app.media.listeners[0].handler();
  assert.equal(app.title.textContent, "November 2026");
  assert.equal(findAll(app.body, (node) => node.tagName === "svg").length, 0);   // November has nothing to chart
  assert.equal(emptyNotes(app, "calories").length, 1);

  // The other workbook is drawn for a phone in the same way.
  const old = await boot({ narrow: true });
  assert.equal(chartOf(old.section("cardio")).className, "chart compact");
  assert.equal(chartOf(measureCard(old, "weight_kg")).className, "chart small compact");
  old.media.matches = false;
  old.media.listeners[0].handler();
  assert.equal(chartOf(old.section("cardio")).className, "chart");
  assert.deepEqual(findAll(old.body, hasData("section")).map((node) => node.dataset.section), SECTIONS);
  // A window that cannot say how wide it is gets the full charts.
  const plain = await boot({ editing: true });
  assert.equal(chartOf(plain.section("calories")).className, "chart");
  assert.equal(plain.media.listeners.length, 0);
});

// ---------------------------------------------------------------- the four-month workbook
//
// The parts every month is built from, on the workbook with several months.

test("changing the month shows that month's figures only", async () => {
  const app = await boot();
  app.calls.length = 0;
  await app.select("2026-11");
  assert.ok(app.calls.includes("/api/months/2026/11/analytics"));
  assert.ok(!app.calls.includes("/api/months/2026/10/analytics"));
  assert.equal(app.title.textContent, "November 2026");
  assert.equal(app.tile("cardio-total"), "10:00");
  assert.equal(app.tile("weight-total"), "2,000 kg");
  assert.equal(findAll(app.section("daily"), both(hasClass("mark"), hasData("status"))).length, 30 * 2);

  app.calls.length = 0;
  await app.select("2026-10");
  assert.ok(app.calls.includes("/api/months/2026/10/analytics"));
  assert.ok(!app.calls.includes("/api/months/2026/11/analytics"));
  assert.equal(app.tile("cardio-total"), "86:15");
  assert.equal(findAll(app.section("daily"), both(hasClass("mark"), hasData("status"))).length, 31 * 2);
});

test("a recorded zero for cardio or weight is a value; no entry at all is not a zero", async () => {
  const app = await boot();
  await app.select("2027-1");
  assert.equal(app.tile("cardio-total"), "0:00");
  assert.equal(app.tile("cardio-average"), "0:00");
  assert.equal(app.tile("cardio-days"), "1");
  assert.equal(findAll(app.section("cardio"), hasClass("bar")).length, 1);
  assert.deepEqual(findAll(app.section("cardio"), hasClass("hit")).map((hit) => hit.dataset.tip), ["0:00"]);
  assert.equal(emptyNotes(app, "cardio").length, 0);
  assert.equal(app.tile("weight-total"), "0 kg");
  assert.equal(app.tile("weight-highest"), "0 kg");
  assert.equal(findAll(app.section("weight"), hasClass("bar")).length, 1);
  assert.equal(emptyNotes(app, "weight").length, 0);

  await app.select("2026-12");
  for (const stat of ["cardio-total", "cardio-average", "cardio-longest", "weight-total", "weight-average", "weight-highest"]) {
    assert.equal(app.tile(stat), "-", stat);
  }
  assert.equal(app.tile("cardio-days"), "0");
  assert.equal(findAll(app.section("cardio"), hasClass("bar")).length, 0);
  assert.equal(emptyNotes(app, "cardio").length, 1);
  assert.equal(emptyNotes(app, "weight").length, 1);
  assert.doesNotMatch(app.section("cardio").textContent, /0:00/);
  assert.doesNotMatch(app.section("weight").textContent, /\b0 kg/);
  assert.equal(findAll(app.body, (node) => node.tagName === "svg").length, 0);
});

test("cardio is shown as min:sec, never as seconds", async () => {
  const app = await boot();
  assert.equal(app.tile("cardio-total"), "86:15");
  assert.equal(app.tile("cardio-average"), "28:45");
  assert.equal(app.tile("cardio-longest"), "60:00");
  assert.equal(app.tile("cardio-days"), "3");
  const cardio = app.section("cardio");
  assert.deepEqual(findAll(cardio, hasClass("bar")).map((bar) => bar.dataset.date),
    ["2026-10-01", "2026-10-02", "2026-10-06"]);
  const hits = findAll(cardio, hasClass("hit"));
  assert.deepEqual(hits.map((hit) => hit.dataset.tip), ["25:30", "0:45", "60:00"]);
  assert.deepEqual(hits.map((hit) => hit.attributes["aria-label"]),
    ["Thu 01 Oct: 25:30", "Fri 02 Oct: 0:45", "Tue 06 Oct: 60:00"]);
  assert.ok(hits.every((hit) => hit.attributes.tabindex === "0"));
  // Axis context: a unit label, a day-of-month label, and the tallest bar's value.
  assert.deepEqual(findAll(cardio, hasClass("axis-title")).map((node) => node.textContent),
    ["min:sec", "Day of month"]);
  assert.deepEqual(findAll(cardio, hasClass("point-label")).map((node) => node.textContent), ["60:00"]);
  assert.deepEqual(weekTotals(cardio, "week-total"), ["26:15", "60:00", "-", "-", "-"]);
  assert.deepEqual(weekTotals(cardio, "week-days"), ["2", "1", "0", "0", "0"]);
  assert.doesNotMatch(cardio.textContent, /1530|5175|3600|1725/);
});

test("weight lifted values are shown in kg", async () => {
  const app = await boot();
  assert.equal(app.tile("weight-total"), "7,270.5 kg");
  assert.equal(app.tile("weight-average"), "2,423.5 kg");
  assert.equal(app.tile("weight-highest"), "3,000 kg");
  assert.equal(app.tile("weight-days"), "3");
  const weight = app.section("weight");
  assert.equal(findAll(weight, hasClass("bar")).length, 3);
  assert.deepEqual(findAll(weight, hasClass("hit")).map((hit) => hit.dataset.tip),
    ["2,450 kg", "1,820.5 kg", "3,000 kg"]);
  assert.deepEqual(findAll(weight, hasClass("axis-title")).map((node) => node.textContent),
    ["kg", "Day of month"]);
  assert.deepEqual(weekTotals(weight, "week-total"), ["4,270.5 kg", "3,000 kg", "-", "-", "-"]);
  assert.doesNotMatch(weight.textContent, /muscle|1RM|bench|squat/i);
});

test("measurement current, previous and change values", async () => {
  const app = await boot();
  const weight = measureCard(app, "weight_kg");
  assert.equal(value(weight, "current"), "71.1 kg");
  assert.match(find(weight, hasData("field", "current")).textContent, /current, Sun 18 Oct/);
  assert.equal(value(weight, "previous"), "72 kg");
  assert.match(find(weight, hasData("field", "previous")).textContent, /Sun 11 Oct/);
  assert.equal(value(weight, "change"), "-0.9 kg");
  assert.equal(value(weight, "change-percentage"), "-1.25%");
  assert.equal(findAll(weight, hasClass("dot")).length, 3);
  assert.equal(findAll(weight, hasClass("line")).length, 2);
  assert.equal(findAll(weight, hasData("note")).length, 0);

  // Waist was measured on 4 and 18 Oct but not on 11 Oct: a gap, not a line.
  const waist = measureCard(app, "waist_cm");
  assert.equal(value(waist, "current"), "82.5 cm");
  assert.equal(value(waist, "previous"), "-");
  assert.equal(value(waist, "change"), "-");
  assert.equal(value(waist, "change-percentage"), "-");
  assert.equal(find(waist, hasData("note", "previous")).textContent,
    "Sun 11 Oct was not recorded, so there is no change to show.");
  assert.equal(findAll(waist, hasClass("dot")).length, 2);
  assert.equal(findAll(waist, hasClass("line")).length, 0);

  // Chest has no values in a month that has other measurements.
  const chest = measureCard(app, "chest_cm");
  for (const field of ["current", "previous", "change", "change-percentage"]) {
    assert.equal(value(chest, field), "-");
  }
  assert.equal(find(chest, hasData("empty")).textContent, "No values recorded this month.");
  assert.equal(findAll(chest, (node) => node.tagName === "svg").length, 0);

  assert.deepEqual(findAll(app.section("measurements"), hasData("measure")).map((node) => node.dataset.measure),
    ["weight_kg", "waist_cm", "chest_cm", "bicep_cm", "thigh_cm", "forearm_cm"]);
});

test("a measurement never takes its previous value from another month", async () => {
  const app = await boot();
  await app.select("2026-11");
  const weight = measureCard(app, "weight_kg");
  assert.equal(value(weight, "current"), "80 kg");
  assert.match(find(weight, hasData("field", "current")).textContent, /current, Sun 01 Nov/);
  assert.equal(value(weight, "previous"), "-");
  assert.equal(value(weight, "change"), "-");
  assert.equal(value(weight, "change-percentage"), "-");
  assert.equal(find(weight, hasData("note", "previous")).textContent,
    "No earlier Sunday in this month, so there is no previous value.");
  assert.doesNotMatch(app.section("measurements").textContent, /71\.1|72\.5|Oct/);
  assert.equal(findAll(weight, hasClass("dot")).length, 1);
});

test("an unreachable backend or unusable data keeps the dashboard and is reported", async () => {
  const app = await boot();
  const before = app.body.textContent;
  app.server.down = true;
  await app.poll();
  assert.equal(app.notice.hidden, false);
  assert.match(app.notice.textContent, /^Cannot reach the local backend/);
  assert.match(app.notice.textContent, /Still showing the last data that loaded for October 2026\.$/);
  assert.equal(app.body.textContent, before);
  app.server.down = false;
  await app.poll();
  assert.equal(app.notice.hidden, true);

  // A response the page cannot draw: reported on the page and in the console,
  // and the tables are not half-updated.
  const broken = structuredClone(FIXTURES.data["2026-10"]);
  delete broken.analytics.cardio;
  broken.month.days[0].weight_lifted_kg = 9999;
  app.server.data["2026-10"] = broken;
  await app.save();
  assert.equal(app.notice.hidden, false);
  assert.match(app.notice.textContent, /^The page could not display this data/);
  assert.equal(app.errors.length, 1);
  assert.equal(app.body.textContent, before);
  assert.doesNotMatch(trackerRow(app, "2026-10-01").textContent, /9,999/);
});

test("the status line says when Excel has unsaved changes, without treating it as an error", async () => {
  const app = await boot();
  const status = app.document.getElementById("workbook-status");
  const before = app.body.textContent;
  assert.match(status.textContent, /^Workbook last saved .+\.$/);
  assert.doesNotMatch(status.textContent, /Excel/);

  app.server.status.locked = true;
  await app.poll();
  assert.match(status.textContent, /It is open in Excel; changes appear here each time you save\.$/);

  app.server.status.unsaved_changes = true;
  app.calls.length = 0;
  await app.poll();
  assert.match(status.textContent, /Excel has unsaved changes; showing the last saved data\.$/);
  assert.deepEqual(app.calls, ["/api/status"]);      // nothing new to fetch
  assert.equal(app.notice.hidden, true);             // not an error
  assert.equal(app.body.textContent, before);        // the dashboard is unchanged

  app.server.status.unsaved_changes = false;
  await app.poll();
  assert.match(status.textContent, /It is open in Excel/);
});

test("the daily tracker flags today, in the month that holds it", async () => {
  const app = await boot();
  assert.match(trackerRow(app, "2026-10-20").children[0].textContent, /^Tue 20 OctToday$/);
  assert.match(trackerRow(app, "2026-10-20").className, /\btoday\b/);
  const flagged = findAll(wholeMonth(app), (node) => node.tagName === "tr" && /\btoday\b/.test(node.className));
  assert.equal(flagged.length, 1);
  await app.select("2026-11");
  assert.equal(findAll(wholeMonth(app), (node) => node.tagName === "tr" && /\btoday\b/.test(node.className)).length, 0);
});

test("no yearly analytics, goals, scores or rankings appear in any month", async () => {
  const app = await boot();
  for (const key of ["2026-10", "2026-11", "2026-12", "2027-1"]) {
    await app.select(key);
    const text = app.body.textContent + wholeMonth(app).textContent;
    assert.doesNotMatch(text, /year|annual|goal|target|score|rating|\bgrade|rank|winner/i, key);
    assert.doesNotMatch(text, /muscle|1RM|bench|squat|deadlift/i, key);
  }
});

// ---------------------------------------------------------------- one application
//
// There is one page, one set of sections and one editing path, whatever the
// month. Nothing in the page knows of any other layout or offers to change one.

test("there is one dashboard: the page's scripts hold no second layout and no way to convert one", async () => {
  const sources = SCRIPTS.map((script) => script.source).join("\n");
  assert.deepEqual(SCRIPTS.map((script) => script.name), ["format.js", "analytics.js", "app.js", "editor.js"]);
  for (const gone of ["version", "Version", "V1", "V2", "v1", "v2", "upgrade", "Upgrade", "migrat", "legacy", "backup",
    "no_junk_food", "total_weight_lifted", "No Junk Food", "box done", "TRUE in Excel"]) {
    assert.ok(!sources.includes(gone), gone);
  }
  assert.equal(sources.match(/function buildAnalytics\w*\(/g).length, 1);      // one set of sections
  const guessing = sources.match(/"(junk_food|calories_kcal)" in |hasOwnProperty/g);
  assert.equal(guessing, null);                                                 // and no guessing at what a month holds
  // Both workbooks get the same eight sections, the same columns and the same editors.
  for (const app of [await boot(), await boot({ editing: true })]) {
    assert.deepEqual(findAll(app.body, hasData("section")).map((node) => node.dataset.section), SECTIONS);
    assert.deepEqual(el(app, "days-head").children.map((th) => th.textContent), [
      "Date", "Exercise", "Junk Food", "Cardio (min:sec)", "Calories (kcal)", "Protein (g)", "Weight Lifted (kg)", "Edit"]);
    assert.equal(findAll(wholeMonth(app), (node) => node.tagName === "button").length, 31);
    assert.equal(findAll(el(app, "measurements-body"), (node) => node.tagName === "button").length, 4);
    assert.equal(todayButton(app).length, 1);
    assert.equal(app.requests.length, 0);
  }
});

test("a month the backend cannot read is reported in its words, and the last good month stays", async () => {
  const app = await boot({ editing: true });
  const before = app.body.textContent;
  const table = wholeMonth(app).textContent;
  // A sheet in the workbook that the tracker did not lay out: the backend refuses to guess, and says so.
  assert.equal(EDITING.other_layout_month.status, 500);
  assert.equal(EDITING.other_layout_month.body.error.code, "workbook_format");
  app.server.override = { "/api/months/2026/11": EDITING.other_layout_month };
  await app.select("2026-11");
  assert.equal(app.notice.hidden, false);
  assert.ok(app.notice.textContent.includes(EDITING.other_layout_month.body.error.message));
  assert.match(app.notice.textContent, /^Could not load November 2026\./);
  assert.match(app.notice.textContent, /Still showing October 2026, the last data that loaded\.$/);
  assert.equal(app.title.textContent, "October 2026");
  assert.equal(app.body.textContent, before);
  assert.equal(wholeMonth(app).textContent, table);
  assert.equal(app.requests.length, 0);                     // the page does nothing about it by itself
  // Once the sheet can be read, the next poll shows it.
  app.server.override = null;
  await app.poll();
  assert.equal(app.notice.hidden, true);
  assert.equal(app.title.textContent, "November 2026");
});

test("a month added from the page is like any other: it can be edited at once", async () => {
  const app = await boot({ editing: true });
  // What the backend answers to Add New Month, and what it then serves for the new month.
  const december = structuredClone(FIXTURES.data["2026-12"]);
  app.server.reply = () => {
    app.server.months = [...EDITING.months, { year: 2026, month: 12, label: "December 2026" }];
    app.server.data["2026-12"] = december;
    return { status: 201, body: december.month };
  };
  el(app, "add-month").fire("click");
  el(app, "new-month").value = "12";
  el(app, "new-year").value = "2026";
  el(app, "add-form").fire("submit");
  await settle();
  app.server.reply = null;
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, "POST");
  assert.equal(app.requests[0].url, "/api/months");
  assert.deepEqual(JSON.parse(app.requests[0].body), { year: 2026, month: 12 });
  assert.equal(app.title.textContent, "December 2026");
  assert.deepEqual(findAll(app.body, hasData("section")).map((node) => node.dataset.section), SECTIONS);
  assert.equal(wholeMonth(app).children.length, 31);
  assert.equal(findAll(wholeMonth(app), (node) => node.tagName === "button").length, 31);
  assert.ok(findAll(wholeMonth(app), (node) => node.tagName === "button").every((button) => button.disabled));   // all still to come
  assert.equal(upcomingRows(wholeMonth(app)).length, 31);
  assert.equal(app.notice.hidden, true);
});

// ---------------------------------------------------------------- five days at a time

const shownDates = (app) => el(app, "days-body").children.map((row) => row.dataset.date);
const shownDays = (app) => shownDates(app).map((date) => Number(date.slice(8)));
const span = (first) => [0, 1, 2, 3, 4].map((step) => first + step);

test("the window is five days: today in the middle, or the nearest five at either end of the month", async () => {
  const app = await boot({ editing: true });
  const { dayWindow } = app.context;
  const monthOf = (year, month, length) => Array.from({ length }, (_, index) =>
    ({ date: `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}` }));
  // Every day of a 28, 29, 30 and 31 day month: start = min(max(day - 2, 1), length - 4).
  for (const [year, month, length] of [[2027, 2, 28], [2028, 2, 29], [2026, 11, 30], [2026, 10, 31]]) {
    const days = monthOf(year, month, length);
    assert.equal(days.length, length);
    for (let day = 1; day <= length; day++) {
      const found = dayWindow(days, days[day - 1].date, 0);
      assert.equal(found.start, Math.min(Math.max(day - 2, 1), length - 4), `${length}-day month, day ${day}`);
      assert.equal(found.last, length - 4);
      assert.ok(found.start <= day && day <= found.start + 4, `day ${day} is one of the five`);
    }
  }
  // The examples for a 31-day month, as written down.
  const october = monthOf(2026, 10, 31);
  const startFor = (day) => dayWindow(october, october[day - 1].date, 0).start;
  assert.deepEqual([1, 2, 3, 4, 5, 7, 15, 28, 29, 30, 31].map(startFor), [1, 1, 1, 2, 3, 5, 13, 26, 27, 27, 27]);
  // A month that is over rests on its last five days, and one still to come on its first five.
  assert.equal(dayWindow(october, "2026-11-09", 0).start, 27);
  assert.equal(dayWindow(october, "2026-09-30", 0).start, 1);
  assert.equal(dayWindow(monthOf(2027, 2, 28), "2027-03-01", 0).start, 24);
  // Moving: whole windows earlier or later, stopping at the ends, never fewer than five days.
  assert.deepEqual([-3, -2, -1, 0, 1, 2, 3].map((shift) => dayWindow(october, "2026-10-15", shift).start), [1, 3, 8, 13, 18, 23, 27]);
  assert.deepEqual([-1, 0, 1].map((shift) => dayWindow(october, "2026-10-01", shift).start), [1, 1, 6]);
});

test("the daily tracker shows five days around today and moves five at a time", async () => {
  const app = await boot({ editing: true });                  // today is 20 October 2026
  const earlier = el(app, "days-earlier"), later = el(app, "days-later"), range = el(app, "days-range");
  assert.deepEqual(shownDays(app), [18, 19, 20, 21, 22]);
  assert.equal(range.textContent, "18 to 22 Oct");
  assert.match(el(app, "days-body").children[2].className, /\btoday\b/);          // today, in the middle, marked as before
  assert.equal(el(app, "days-body").children[2].children[0].textContent, "Tue 20 OctToday");
  assert.deepEqual([earlier.disabled, later.disabled], [false, false]);
  assert.equal(earlier.attributes["aria-label"], "Earlier days, before Sun 18 Oct");
  assert.equal(later.attributes["aria-label"], "Later days, after Thu 22 Oct");
  // Days to come are shown, and still cannot be edited; days past and today can.
  assert.deepEqual(el(app, "days-body").children.map((row) => find(row, (n) => n.tagName === "button").disabled),
    [false, false, false, true, true]);

  // Moving reads nothing and saves nothing: the month in hand is drawn again.
  app.calls.length = 0;
  earlier.fire("click");
  assert.deepEqual(shownDays(app), span(13));
  assert.equal(range.textContent, "13 to 17 Oct");
  earlier.fire("click"); earlier.fire("click");
  assert.deepEqual(shownDays(app), span(3));
  earlier.fire("click");
  assert.deepEqual(shownDays(app), span(1));                    // it stops at the first of the month: still five days
  assert.equal(earlier.disabled, true);
  earlier.fire("click");                                        // and a press there does nothing
  assert.deepEqual(shownDays(app), span(1));
  // Later the same number of times is back on today's five exactly.
  for (let press = 0; press < 4; press++) later.fire("click");
  assert.deepEqual(shownDays(app), [18, 19, 20, 21, 22]);
  later.fire("click");
  assert.deepEqual(shownDays(app), span(23));
  later.fire("click");
  assert.deepEqual(shownDays(app), span(27));                   // the last five, not a short window
  assert.equal(later.disabled, true);
  assert.equal(range.textContent, "27 to 31 Oct");
  assert.deepEqual([app.calls.length, app.requests.length], [0, 0]);
  // Every day of the month can be reached, each exactly as the workbook holds it.
  assert.equal(monthRows(app).length, 31);
});

test("the window stays where the user left it through a refresh, and starts afresh in another month", async () => {
  const app = await boot({ editing: true });
  el(app, "days-earlier").fire("click");
  el(app, "days-earlier").fire("click");
  assert.deepEqual(shownDays(app), span(8));
  await app.save();                                             // the workbook was saved elsewhere; the page reads it again
  assert.deepEqual(shownDays(app), span(8));
  await app.poll();
  assert.deepEqual(shownDays(app), span(8));
  // A month still to come opens on its first five days; coming back, October opens on today again.
  await app.select("2026-11");
  assert.deepEqual(shownDates(app), ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
  assert.equal(el(app, "days-earlier").disabled, true);
  assert.ok(el(app, "days-body").children.every((row) => find(row, (n) => n.tagName === "button").disabled));
  el(app, "days-later").fire("click");
  assert.deepEqual(shownDays(app), span(6));
  for (let press = 0; press < 6; press++) el(app, "days-later").fire("click");
  assert.deepEqual(shownDays(app), span(26));                   // a 30-day month ends on 26 to 30
  await app.select("2026-10");
  assert.deepEqual(shownDays(app), [18, 19, 20, 21, 22]);
});

test("the window follows today, at the start, the middle and the end of the month", async () => {
  for (const [today, days] of [["2026-10-01", span(1)], ["2026-10-02", span(1)], ["2026-10-03", span(1)],
    ["2026-10-04", span(2)], ["2026-10-05", span(3)], ["2026-10-07", span(5)], ["2026-10-15", span(13)],
    ["2026-10-28", span(26)], ["2026-10-29", span(27)], ["2026-10-30", span(27)], ["2026-10-31", span(27)]]) {
    const app = await boot({ editing: true });
    const changed = structuredClone(EDITING.data["2026-10"]);
    changed.analytics.month.today = today;
    // As the backend would have it: on that day, a habit with nothing entered is pending, not missed.
    const index = Number(today.slice(8)) - 1;
    for (const habit of ["exercise", "junk_food"]) {
      if (changed.month.days[index][habit] === null) changed.analytics.daily[index][`${habit}_status`] = "pending";
    }
    app.server.data["2026-10"] = changed;
    await app.save();
    assert.equal(app.notice.hidden, true, `${today}: ${app.notice.textContent} ${app.errors.join(" ")}`);
    assert.deepEqual(shownDays(app), days, today);
    assert.equal(shownDays(app).length, 5, today);
    const marked = el(app, "days-body").children.filter((row) => /\btoday\b/.test(row.className)).map((row) => row.dataset.date);
    assert.deepEqual(marked, [today], today);
  }
});

test("a day reached by moving the window is edited and saved exactly as before", async () => {
  const app = await boot({ editing: true });
  openDay(app, "2026-10-05");                                   // three windows back
  assert.ok(isOpen(app));
  assert.equal(el(app, "edit-date").textContent, "Monday, 5 October 2026");
  type(app, { exercise: "Completed", calories_kcal: "2100" });
  await pressSave(app);
  assert.ok(!isOpen(app));
  assert.deepEqual(sent(app), [{ exercise: "Completed", calories_kcal: 2100 }]);
  assert.equal(app.requests[0].url, "/api/months/2026/10/days/5");
  // The saved day is shown, the window has not moved, and focus is back on that day's Edit.
  assert.deepEqual(shownDays(app), span(3));
  assert.deepEqual(rowText(app, "2026-10-05").slice(0, 5), ["Mon 05 Oct", "Completed", "Not entered", "-", "2,100"]);
  assert.ok(app.document.activeElement === editButton(app, "2026-10-05"));
  // Edit today works from any window, and leaves the window where it is.
  todayButton(app)[0].fire("click");
  assert.equal(el(app, "edit-date").textContent, "Tuesday, 20 October 2026");
  type(app, { protein_g: "120" });
  await pressSave(app);
  assert.equal(app.requests[1].url, "/api/months/2026/10/days/20");
  assert.deepEqual(shownDays(app), span(3));
  assert.ok(app.document.activeElement === todayButton(app)[0]);
  // What is being typed survives the window being read again by a refresh.
  openDay(app, "2026-10-04");
  type(app, { cardio: "12:34" });
  await app.save();
  assert.ok(isOpen(app));
  assert.equal(field(app, "cardio").value, "12:34");
});

// ---------------------------------------------------------------- deleting a month

const deleteOptions = (app) => el(app, "delete-select").children.map((option) => [option.value, option.textContent]);
const deleteOpen = (app) => el(app, "delete-dialog").open === true;
async function pressDelete(app) {
  el(app, "delete-form").fire("submit", { preventDefault() {} });
  await settle();
}

test("Delete Month asks first, names the month, and deletes only on the second press", async () => {
  const app = await boot({ editing: true });                    // October (on screen) and November
  el(app, "delete-month").fire("click");
  assert.ok(deleteOpen(app));
  assert.deepEqual(deleteOptions(app), [["2026-10", "October 2026"], ["2026-11", "November 2026"]]);
  assert.equal(el(app, "delete-select").value, "2026-10");      // it opens on the month on screen
  assert.equal(el(app, "delete-submit").textContent, "Delete Month");
  assert.equal(el(app, "delete-confirm").hidden, true);
  assert.equal(el(app, "delete-hint").textContent, "Choosing a month here deletes nothing. You are asked to confirm first.");

  // Choosing another month in the dropdown sends nothing.
  el(app, "delete-select").value = "2026-11";
  el(app, "delete-select").fire("change");
  await settle();
  assert.equal(app.requests.length, 0);

  // The first press only asks, and says which month would go.
  await pressDelete(app);
  assert.equal(app.requests.length, 0);
  assert.ok(deleteOpen(app));
  assert.equal(el(app, "delete-confirm").hidden, false);
  assert.match(el(app, "delete-confirm").textContent, /^Delete November 2026\? Its sheet is removed from Fitness_Tracker\.xlsx/);
  assert.match(el(app, "delete-confirm").textContent, /This cannot be undone\.$/);
  assert.equal(el(app, "delete-submit").textContent, "Delete November 2026");
  assert.equal(el(app, "delete-select").disabled, true);        // the month cannot change under the question
  assert.ok(app.document.activeElement === el(app, "delete-cancel"));   // the keyboard rests on the safe button

  // Cancel closes the dialog and nothing was sent; opening it again starts from the beginning.
  el(app, "delete-cancel").fire("click");
  assert.ok(!deleteOpen(app));
  assert.equal(app.requests.length, 0);
  assert.deepEqual(app.server.months.map((month) => month.label), ["October 2026", "November 2026"]);
  el(app, "delete-month").fire("click");
  assert.equal(el(app, "delete-confirm").hidden, true);
  assert.equal(el(app, "delete-select").disabled, false);
  assert.equal(el(app, "delete-submit").textContent, "Delete Month");

  // The second press deletes: one request, naming the month.
  el(app, "delete-select").value = "2026-11";
  await pressDelete(app);
  await pressDelete(app);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].method, "DELETE");
  assert.equal(app.requests[0].url, "/api/months/2026/11");
  assert.equal(app.requests[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(app.requests[0].body), { confirm: "November 2026" });
  assert.ok(!deleteOpen(app));
  // The month has gone from the selector; the month on screen was another one and is still there.
  assert.deepEqual(el(app, "month-select").children.map((option) => option.textContent), ["October 2026"]);
  assert.equal(app.title.textContent, "October 2026");
  assert.equal(app.notice.hidden, true);
});

test("deleting the month on screen moves the page to a month that is still there", async () => {
  const app = await boot();                                     // October, November, December 2026 and January 2027
  await app.select("2026-12");
  assert.equal(app.title.textContent, "December 2026");
  el(app, "delete-month").fire("click");
  assert.equal(el(app, "delete-select").value, "2026-12");
  await pressDelete(app);
  await pressDelete(app);
  assert.deepEqual(app.requests.map((request) => `${request.method} ${request.url}`), ["DELETE /api/months/2026/12"]);
  assert.deepEqual(el(app, "month-select").children.map((option) => option.textContent),
    ["October 2026", "November 2026", "January 2027"]);
  // Nothing on the page points at the deleted sheet any more.
  assert.notEqual(app.title.textContent, "December 2026");
  const shown = el(app, "month-select").children.find((option) => option.selected);
  assert.equal(app.title.textContent, shown.textContent);
  assert.ok(el(app, "days-body").children.every((row) => !row.dataset.date.startsWith("2026-12")));
  assert.equal(el(app, "days-body").children.length, 5);
  assert.equal(app.notice.hidden, true);
  assert.equal(app.errors.length, 0);
  // A refresh afterwards asks only for months that exist.
  app.calls.length = 0;
  await app.save();
  assert.ok(app.calls.every((url) => !url.includes("/2026/12")), app.calls.join(" "));
});

test("the only month cannot be deleted, and the dialog says why", async () => {
  const app = await boot({ editing: true });
  app.server.months = app.server.months.slice(0, 1);            // October alone
  await app.save();
  el(app, "delete-month").fire("click");
  assert.ok(deleteOpen(app));
  assert.equal(el(app, "delete-submit").disabled, true);
  assert.equal(el(app, "delete-select").disabled, true);
  assert.equal(el(app, "delete-hint").textContent,
    "This is the only month in the workbook, so it cannot be deleted. Add another month first.");
  await pressDelete(app);                                       // even if the form is sent some other way
  await pressDelete(app);
  assert.equal(app.requests.length, 0);
  assert.equal(el(app, "delete-confirm").hidden, true);
});

test("a refused deletion is explained in the dialog and changes nothing", async () => {
  const app = await boot({ editing: true });
  app.server.reply = { status: 423, body: { error: { code: "workbook_locked", message: "The workbook is open in Excel. Close it and try again." } } };
  el(app, "delete-month").fire("click");
  el(app, "delete-select").value = "2026-11";
  await pressDelete(app);
  await pressDelete(app);
  assert.equal(app.requests.length, 1);
  assert.ok(deleteOpen(app));                                   // it stays open, with the reason
  assert.equal(el(app, "delete-error").hidden, false);
  assert.equal(el(app, "delete-error").textContent, "The workbook is open in Excel. Close it and try again.");
  assert.equal(el(app, "delete-submit").disabled, false);       // and can be pressed again once Excel has closed it
  assert.deepEqual(el(app, "month-select").children.map((option) => option.textContent), ["October 2026", "November 2026"]);
  assert.equal(app.title.textContent, "October 2026");
  // Once the workbook is free, the same press goes through.
  app.server.reply = null;
  await pressDelete(app);
  assert.equal(app.requests.length, 2);
  assert.ok(!deleteOpen(app));
  assert.deepEqual(el(app, "month-select").children.map((option) => option.textContent), ["October 2026"]);
});
