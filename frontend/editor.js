"use strict";

// The tracker's two editors: one for a day's entries and one for a
// Sunday's measurements. Both work the same way.
//
// Nothing is sent while the fields are being changed. Save sends every changed
// field in one request; Cancel sends nothing. The backend checks every value
// again and has the last word; the checks here only catch slips early.

const EXERCISE_CHOICES = ["Completed", "Partial", "Rest Day", "Missed"];
const JUNK_FOOD_CHOICES = ["None", "Controlled", "Had"];
const NOT_ENTERED = "Not entered";

const LOCKED_MESSAGE =
  "Close Fitness_Tracker.xlsx in Excel before saving changes. Then click Save again.";

const ONE_DECIMAL = /^\d+(\.\d)?$/;

// name is the field the backend takes; from is where the record holds it.
// A number may be at most max, and must be more than above when that is given.
const DAY_EDIT_FIELDS = [
  { name: "exercise", id: "edit-exercise", choices: EXERCISE_CHOICES },
  { name: "junk_food", id: "edit-junk-food", choices: JUNK_FOOD_CHOICES },
  {
    name: "cardio", id: "edit-cardio", from: "cardio_display", pattern: /^\d{1,3}:[0-5]\d$/,
    hint: "Enter minutes and seconds as min:sec, for example 25:30. Seconds go from 00 to 59.",
  },
  {
    name: "calories_kcal", id: "edit-calories", pattern: /^\d+$/, max: 20000,
    hint: "Enter a whole number from 0 to 20,000.",
  },
  {
    name: "protein_g", id: "edit-protein", pattern: ONE_DECIMAL, max: 1000,
    hint: "Enter a number from 0 to 1,000, with at most one decimal place.",
  },
  {
    name: "weight_lifted_kg", id: "edit-weight", pattern: ONE_DECIMAL, max: 100000,
    hint: "Enter a number from 0 to 100,000, with at most one decimal place.",
  },
];

const MEASUREMENT_EDIT_FIELDS = [
  ["weight_kg", "measure-weight"], ["waist_cm", "measure-waist"], ["chest_cm", "measure-chest"],
  ["bicep_cm", "measure-bicep"], ["thigh_cm", "measure-thigh"], ["forearm_cm", "measure-forearm"],
].map(([name, id]) => ({
  name, id, pattern: ONE_DECIMAL, max: 500, above: 0,
  hint: "Enter a number above 0 and up to 500, with at most one decimal place.",
}));

const longDayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
});

// The text a field starts with. A blank cell is an empty field, never a zero.
function initialText(record, field) {
  const value = record[field.from || field.name];
  return value === null || value === undefined ? "" : String(value);
}

function unacceptable(field, text) {
  if (!field.pattern.test(text)) return true;
  if (field.max !== undefined && Number(text) > field.max) return true;
  return field.above !== undefined && Number(text) <= field.above;
}

// One editor: a dialog, its fields, and where its changes are sent.
//   prefix         the dialog is <prefix>-dialog, its form <prefix>-form, and so on
//   fields         the fields, as above
//   dateKey        where a record holds its date
//   path           the part of the address after the month: "days" or "measurements"
//   futureMessage  what to say if the record is for a day still to come
//   saved          called with the backend's answer and the changes that were sent
//   unchanged      called with the date when Save was pressed with nothing changed
function setupEditor(config) {
  const part = (name) => $(`${config.prefix}-${name}`);
  const els = {
    dialog: part("dialog"), form: part("form"), date: part("date"),
    error: part("error"), save: part("save"), cancel: part("cancel"),
  };
  const fields = config.fields.map((field) => ({
    ...field, input: $(field.id), error: $(`${field.id}-error`),
  }));
  // What the open editor is working on. initial holds the text each field had
  // when it was opened, so Save can tell what the user changed.
  const editing = { date: null, url: null, initial: {}, saving: false, future: false };

  for (const field of fields.filter((item) => item.choices)) {
    field.input.replaceChildren(
      make("option", { text: NOT_ENTERED, attrs: { value: "" } }),
      ...field.choices.map((choice) => make("option", { text: choice, attrs: { value: choice } }))
    );
  }

  function showFieldError(field, message) {
    field.error.textContent = message;
    field.error.hidden = false;
    field.input.setAttribute("aria-invalid", "true");
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function clearErrors() {
    els.error.hidden = true;
    els.error.textContent = "";
    for (const field of fields) {
      field.error.hidden = true;
      field.error.textContent = "";
      field.input.setAttribute("aria-invalid", "false");
    }
  }

  function setSaving(saving) {
    editing.saving = saving;
    els.save.disabled = saving || editing.future;
    els.cancel.disabled = saving;
    els.save.textContent = saving ? "Saving" : "Save";
  }

  // Open the editor on a record of the month on screen.
  function open(record, month) {
    const date = record[config.dateKey];
    editing.date = date;
    editing.url = `/api/months/${month.year}/${month.month}/${config.path}/${Number(date.split("-")[2])}`;
    editing.future = Boolean(state.today) && date > state.today;
    els.date.textContent = longDayFormat.format(parseDay(date));
    clearErrors();
    for (const field of fields) {
      editing.initial[field.name] = initialText(record, field);
      field.input.value = editing.initial[field.name];
    }
    setSaving(false);
    if (editing.future) showError(config.futureMessage);
    els.dialog.showModal();
  }

  // The fields the user changed, in the form the backend takes, and any field
  // whose new text cannot be right. A field left as it was is not looked at.
  function read() {
    const changes = {};
    const invalid = [];
    for (const field of fields) {
      const text = String(field.input.value).trim();
      if (text === editing.initial[field.name]) continue;
      if (text === "") {
        changes[field.name] = null;       // cleared
      } else if (field.choices) {
        changes[field.name] = text;
      } else if (unacceptable(field, text)) {
        invalid.push(field);
      } else {
        changes[field.name] = field.max === undefined ? text : Number(text);
      }
    }
    return { changes, invalid };
  }

  function reportFailure(error) {
    if (!(error instanceof ApiError)) {
      console.error(error);
      showError(`The change could not be saved (${error.message}). Nothing was changed.`);
      return;
    }
    if (error.code === "workbook_locked") {
      showError(LOCKED_MESSAGE);
      return;
    }
    const general = [];
    for (const [name, message] of Object.entries(error.fields || {})) {
      const field = fields.find((item) => item.name === name);
      if (field) showFieldError(field, message);
      else general.push(message);
    }
    if (!error.fields) general.push(error.message);
    else if (general.length === 0) general.push("Not saved. Correct the marked fields and save again.");
    showError(general.join(" "));
  }

  async function save() {
    if (editing.saving || editing.future) return;
    clearErrors();
    const { changes, invalid } = read();
    if (invalid.length > 0) {
      for (const field of invalid) showFieldError(field, field.hint);
      showError("Not saved. Correct the marked fields and save again.");
      if (invalid[0].input.focus) invalid[0].input.focus();
      return;
    }
    if (Object.keys(changes).length === 0) {
      els.dialog.close();
      config.unchanged(editing.date);
      return;
    }
    setSaving(true);
    try {
      const result = await api(editing.url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      els.dialog.close();
      config.saved(result, changes);
    } catch (error) {
      // The editor stays open with everything the user typed still in it.
      reportFailure(error);
    } finally {
      setSaving(false);
    }
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });

  els.cancel.addEventListener("click", () => {
    if (!editing.saving) els.dialog.close();
  });

  // Escape closes the dialog, which discards the changes. Not while a save is on its way.
  els.dialog.addEventListener("cancel", (event) => {
    if (editing.saving) event.preventDefault();
  });

  return { open };
}

const dayEditor = setupEditor({
  prefix: "edit",
  fields: DAY_EDIT_FIELDS,
  dateKey: "date",
  path: "days",
  futureMessage: "This day is in the future, so it cannot be edited yet.",
  saved: daySaved,
  unchanged: dayUnchanged,
});

const measurementEditor = setupEditor({
  prefix: "measure",
  fields: MEASUREMENT_EDIT_FIELDS,
  dateKey: "sunday",
  path: "measurements",
  futureMessage: "This Sunday is in the future, so it cannot be edited yet.",
  saved: measurementSaved,
  unchanged: measurementUnchanged,
});

function openEditor(record, month) {
  dayEditor.open(record, month);
}

function openMeasurementEditor(record, month) {
  measurementEditor.open(record, month);
}
