"use strict";

// The analytics sections of a month, and the pieces they are built from: a
// section with its heading, a figure, an empty state, the charts and the
// tooltip. Every figure shown is taken from the backend's analytics response
// as it is: counts, percentages, streaks, totals and averages are never worked
// out here. The only arithmetic in this file is chart geometry (where to draw
// a bar or a point).

const MEASURES = [
  ["weight_kg", "Weight", "kg"],
  ["waist_cm", "Waist", "cm"],
  ["chest_cm", "Chest", "cm"],
  ["bicep_cm", "Bicep", "cm"],
  ["thigh_cm", "Thigh", "cm"],
  ["forearm_cm", "Forearm", "cm"],
];
const CARDIO_STEPS = [15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 14400];
// A window this narrow is a phone: its charts are drawn to fit it, with fewer
// labels. Anything wider gets the full chart.
const NARROW = "(max-width: 599px)";

function isNarrow() {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;
}

// ---------------------------------------------------------------- pieces

function section(name, title, description, ...children) {
  return make("section", {
    class: "block", data: { section: name },
    attrs: { id: `section-${name}`, "aria-labelledby": `heading-${name}` },
  },
    make("h3", { text: title, attrs: { id: `heading-${name}` } }),
    description ? make("p", { class: "desc", text: description }) : "",
    ...children);
}

function tile(stat, label, value, note) {
  const node = make("div", { class: "tile", data: { stat } },
    make("div", { class: "tile-label", text: label }),
    make("div", { class: "tile-value value" }, ...unitParts(value)));
  if (note) node.append(make("div", { class: "tile-note", text: note }));
  return node;
}

function emptyBox(message, detail) {
  const box = make("div", { class: "empty-box", data: { empty: "true" } },
    make("p", { class: "empty-title", text: message }));
  if (detail) box.append(make("p", { class: "sub", text: detail }));
  return box;
}

const HABIT_KEYS = ["exercise", "junk_food"];

// For each habit: where its percentage is, how its streaks are named, and its
// statuses in the order they are shown, as [status, label, mark, how it counts].
const HABITS = {
  exercise: {
    label: "Exercise",
    percentage: "completion_percentage",
    figure: "completion of counted days",
    current: "Current streak",
    longest: "Longest streak",
    statuses: [
      ["completed", "Completed", "completed", "counted in full"],
      ["partial", "Partial", "partial", "counted as half"],
      ["rest_day", "Rest Day", "rest", "left out of the percentage"],
      ["missed", "Missed", "missed", "counted as nothing"],
      ["pending", "Pending", "", "not counted yet"],
    ],
  },
  junk_food: {
    label: "Junk Food",
    percentage: "success_percentage",
    figure: "success on days with an entry",
    current: "Current clean streak",
    longest: "Longest clean streak",
    statuses: [
      ["none", "None", "completed", "counted in full"],
      ["controlled", "Controlled", "partial", "counted as half"],
      ["had", "Had", "missed", "counted as nothing"],
      ["missed", "Missed", "unentered", "past day left blank"],
      ["pending", "Pending", "", "not counted yet"],
    ],
  },
};

// How today's status reads, by habit and status.
const TODAY_TEXT = {
  exercise: {
    completed: ["Completed", "Entered for today."],
    partial: ["Partial", "Entered for today. It counts as half."],
    rest_day: ["Rest Day", "Entered for today. It is left out of the percentage."],
    missed: ["Missed", "Entered for today as missed."],
    pending: ["Not entered yet", "Pending. It is not counted as a miss."],
  },
  junk_food: {
    none: ["None", "Entered for today."],
    controlled: ["Controlled", "Entered for today. It counts as half."],
    had: ["Had", "Entered for today."],
    pending: ["Not entered yet", "Pending. It is not counted."],
  },
};

function buildAnalytics(data) {
  return [
    habitSection(data),
    dailySection(data),
    numberSection(data, {
      name: "calories", title: "Calories", field: "calories_kcal", unit: "kcal",
      description: "Calories entered for each day, in kcal. Days without an entry are left out of the average.",
      nothing: "No calories recorded this month.",
      chart: "Daily calories", weekly: "Weekly calories",
    }),
    numberSection(data, {
      name: "protein", title: "Protein", field: "protein_g", unit: "g",
      description: "Protein entered for each day, in grams. Days without an entry are left out of the average.",
      nothing: "No protein recorded this month.",
      chart: "Daily protein", weekly: "Weekly protein",
    }),
    cardioSection(data),
    weightSection(data),
    weeklySection(data),
    measurementSection(data.measurements),
  ];
}

// ---------------------------------------------------------------- statuses

function statusOf(habit, status) {
  return HABITS[habit].statuses.find(([key]) => key === status);
}

// The mark for a day. A past day left blank has its own mark, so it can be
// told apart from a day recorded as Missed or Had.
function markClassOf(habit, day) {
  const status = day[`${habit}_status`];
  if (status === "missed" && day[habit] === null) return "unentered";
  return statusOf(habit, status)[2];
}

function keyMark(markClass) {
  return make("span", { class: `mark ${markClass}`.trim(), attrs: { "aria-hidden": "true" } });
}

// A bar split by status. The counts come from the backend.
function stackBar(habit, counts) {
  const statuses = HABITS[habit].statuses;
  const label = statuses.map(([key, name]) => `${counts[key]} ${name}`).join(", ");
  const bar = make("div", { class: "stack", attrs: { role: "img", "aria-label": label } });
  for (const [key, , markClass] of statuses) {
    if (counts[key] > 0) {
      const segment = make("span", { class: `seg ${markClass || "pending"}`, data: { status: key } });
      segment.style.flexGrow = String(counts[key]);
      bar.append(segment);
    }
  }
  return bar;
}

function legend() {
  return make("ul", { class: "legend", attrs: { "aria-label": "What each mark means" } },
    make("li", {}, keyMark("completed"), "Completed, or junk food None: counted in full"),
    make("li", {}, keyMark("partial"), "Partial, or junk food Controlled: counted as half"),
    make("li", {}, keyMark("rest"), "Rest Day: left out of the percentage, and does not break a streak"),
    make("li", {}, keyMark("missed"), "Missed, or junk food Had: counted as nothing"),
    make("li", {}, keyMark("unentered"),
      "A past day left blank: a miss for exercise; for junk food, left out of the percentage"),
    make("li", {}, keyMark(""), "Pending: today not entered yet, and future days. Not counted."));
}

// ---------------------------------------------------------------- habit overview

function habitSection(data) {
  const body = [legend()];
  const today = data.daily.find((day) => day.date === data.month.today);
  if (today) body.push(todayPanel(today));

  if (data.month.due_days === 0 && data.exercise.eligible_days === 0 && data.junk_food.eligible_days === 0) {
    const notStarted = data.daily.length > 0 && data.month.today < data.daily[0].date;
    body.push(notStarted
      ? emptyBox("This month has not started yet.",
        `All ${formatDays(data.month.days_in_month)} are pending. Nothing is counted as missed.`)
      : emptyBox("No days have been counted yet.",
        "A day counts once it has passed or once you enter it."));
  }

  body.push(make("div", { class: "cards" },
    ...HABIT_KEYS.map((key) => habitCard(key, data[key]))));
  return section("habits", "Habit Overview",
    "How each day of this month was recorded for exercise and for junk food. " +
    "Pending days are left out of both percentages, and rest days out of the exercise percentage.",
    ...body);
}

function todayPanel(today) {
  const items = HABIT_KEYS.map((habit) => {
    const status = today[`${habit}_status`];
    const [headline, detail] = TODAY_TEXT[habit][status];
    return make("li", { data: { habit, status } },
      keyMark(markClassOf(habit, today)),
      make("span", { class: "today-habit", text: `${HABITS[habit].label}:` }),
      make("span", { class: "value", text: headline }),
      make("span", { class: "sub", text: detail }));
  });
  return make("div", { class: "today-panel", data: { today: today.date } },
    make("h4", { text: `Today, ${formatDay(today.date)}` }),
    make("ul", {}, ...items));
}

function habitCard(key, stats) {
  const habit = HABITS[key];
  const percentage = stats[habit.percentage];
  const count = ([status, label, markClass, note]) =>
    make("div", { class: "count", data: { stat: status } },
      make("div", { class: "count-label" }, keyMark(markClass), label),
      make("div", { class: "count-value value" }, ...unitParts(formatDays(stats.counts[status]))),
      make("div", { class: "sub", text: note }));
  const row = (stat, label, value) => make("div", { class: "row", data: { stat } },
    make("dt", { text: label }), make("dd", { class: "value" }, ...unitParts(value)));

  const card = make("div", { class: "card habit", data: { habit: key } },
    make("h4", { text: habit.label }),
    make("div", { class: "figure" },
      make("span", { class: "figure-value value", data: { stat: "percentage" } },
        ...unitParts(formatPercent(percentage))),
      make("span", {
        class: "figure-label",
        text: percentage === null ? "nothing counted yet" : habit.figure,
      })),
    stackBar(key, stats.counts),
    make("div", { class: "counts five" }, ...habit.statuses.map(count)));
  if (stats.missed_not_entered > 0) {
    card.append(make("p", {
      class: "sub card-note", data: { stat: "missed-not-entered" },
      text: `Of the missed days, ${formatDays(stats.missed_not_entered)} ` +
        `${stats.missed_not_entered === 1 ? "was" : "were"} left blank.`,
    }));
  }
  card.append(make("dl", { class: "streaks" },
    row("current-streak", habit.current, formatDays(stats.current_streak)),
    row("longest-streak", habit.longest, formatDays(stats.longest_streak))));
  return card;
}

// ---------------------------------------------------------------- daily grid

function dailySection(data) {
  const days = data.daily;
  const today = data.month.today;
  const hasToday = days.some((day) => day.date === today);
  const classes = (day) => [
    parseDay(day.date).getUTCDay() === 1 ? "week-start" : "",
    day.date === today ? "today" : "",
    hasToday && day.date < today ? "past" : "",          // only for its look: see .grid .past
  ].filter(Boolean).join(" ");

  const head = make("tr", {}, make("th", { text: "Day", attrs: { scope: "col" } }));
  const letters = make("tr", { class: "weekdays" },
    make("th", { text: "Weekday", attrs: { scope: "row" } }));
  for (const day of days) {
    const isToday = day.date === today;
    const attrs = {
      scope: "col",
      title: isToday ? `Today, ${formatDay(day.date)}` : formatDay(day.date),
    };
    if (isToday) attrs["aria-current"] = "date";
    head.append(make("th", {
      class: classes(day), data: { date: day.date },
      text: String(parseDay(day.date).getUTCDate()), attrs,
    }));
    letters.append(make("td", { class: classes(day), text: formatDay(day.date).slice(0, 1) }));
  }

  const rows = HABIT_KEYS.map((habit) => {
    const tr = make("tr", { data: { habit } },
      make("th", { text: HABITS[habit].label, attrs: { scope: "row" } }));
    for (const day of days) {
      const status = day[`${habit}_status`];
      const blank = status === "missed" && day[habit] === null;
      const label = statusOf(habit, status)[1] + (blank ? " (left blank)" : "");
      const where = `${formatDay(day.date)}, ${HABITS[habit].label}`;
      tr.append(make("td", { class: classes(day), data: { date: day.date } },
        make("span", {
          class: `mark ${markClassOf(habit, day)}`.trim(),
          data: { status, tip: label, tipLabel: where },
          attrs: { role: "img", "aria-label": `${where}: ${label}` },
        })));
    }
    return tr;
  });

  const description = "One column for each day of the month, with a heavier line at each Monday." +
    (hasToday ? ` Today, ${formatDay(today)}, is the outlined column.` : "");
  return section("daily", "Daily Habit Progress", description,
    make("div", { class: "table-scroll" },
      make("table", { class: "grid" },
        make("thead", {}, head, letters),
        make("tbody", {}, ...rows))));
}

// ---------------------------------------------------------------- weekly

function weekHeading(week) {
  return make("th", { attrs: { scope: "row" } },
    make("div", { text: `Week ${week.week}` }),
    make("div", { class: "sub", text: `${formatDay(week.start)} to ${formatDay(week.end)}` }),
    make("div", { class: "sub", data: { stat: "week-length" }, text: formatDays(week.days) }));
}

function weeklySection(data) {
  const groups = make("tr", {},
    make("th", { text: "Week", attrs: { scope: "col", rowspan: "2" } }));
  const columns = make("tr", {});
  for (const key of HABIT_KEYS) {
    const habit = HABITS[key];
    groups.append(make("th", {
      class: "group", text: habit.label,
      attrs: { scope: "colgroup", colspan: String(habit.statuses.length + 1) },
    }));
    habit.statuses.forEach(([, label], index) => columns.append(make("th", {
      class: index === 0 ? "num group" : "num", text: label, attrs: { scope: "col" },
    })));
    columns.append(make("th", { class: "num", text: "%", attrs: { scope: "col" } }));
  }

  const rows = data.weekly.map((week) => {
    const tr = make("tr", { data: { week: String(week.week) } }, weekHeading(week));
    for (const key of HABIT_KEYS) {
      const habit = HABITS[key];
      habit.statuses.forEach(([status], index) => tr.append(make("td", {
        class: index === 0 ? "num group" : "num", data: { habit: key, stat: status },
        text: String(week[key][status]),
      })));
      tr.append(make("td", {
        class: "num strong", data: { habit: key, stat: "percentage" },
        text: formatPercent(week[key][habit.percentage]),
      }));
    }
    return tr;
  });

  return section("weekly", "Weekly Habit Analytics",
    "Weeks run Monday to Sunday and are cut at the edges of this month. Counts are days. " +
    "The percentages are worked out as in the Habit Overview.",
    make("div", { class: "table-scroll" },
      make("table", { class: "weekly" },
        make("thead", {}, groups, columns), make("tbody", {}, ...rows))));
}

// A row for each week with figures of one kind. columns is a list of
// [heading, stat, text of the week's entry]. A week with no entry shows a dash
// in every figure; a week whose entries add up to zero shows that zero.
function weeklyNumbers(weeks, key, columns) {
  const rows = weeks.map((week) => {
    const entry = week[key];
    return make("tr", { data: { week: String(week.week) } },
      make("th", { text: `Week ${week.week}`, attrs: { scope: "row" } }),
      make("td", { class: "sub", text: `${formatDay(week.start)} to ${formatDay(week.end)}` }),
      make("td", { class: "num", data: { stat: "week-days" }, text: String(entry.days_recorded) }),
      ...columns.map(([, stat, text], index) => make("td", {
        class: index === 0 ? "num strong" : "num", data: { stat },
        text: entry.days_recorded > 0 ? text(entry) : EMPTY,
      })));
  });
  return make("div", { class: "table-scroll" },
    make("table", { class: "totals" },
      make("thead", {}, make("tr", {},
        make("th", { text: "Week", attrs: { scope: "col" } }),
        make("th", { text: "Dates", attrs: { scope: "col" } }),
        make("th", { class: "num", text: "Days recorded", attrs: { scope: "col" } }),
        ...columns.map(([heading]) => make("th", { class: "num", text: heading, attrs: { scope: "col" } })))),
      make("tbody", {}, ...rows)));
}

// ---------------------------------------------------------------- cardio, weight, calories, protein

function dateNote(date) {
  return date ? formatDay(date) : "";
}

function cardioSection(data) {
  const cardio = data.cardio;
  const days = cardio.days_recorded;
  const none = days === 0;
  const tiles = make("div", { class: "tiles" },
    tile("cardio-total", "Total cardio", cardio.total_display || EMPTY,
      none ? "No entries" : `min:sec, over ${formatDays(days)}`),
    tile("cardio-average", "Average on recorded days", cardio.average_display || EMPTY,
      none ? "" : "min:sec"),
    tile("cardio-longest", "Longest day", cardio.longest_display || EMPTY, dateNote(cardio.longest_date)),
    tile("cardio-days", "Days with cardio", String(days)));
  const description = "Durations are minutes and seconds. Days without an entry are left out of the average.";
  if (none) {
    return section("cardio", "Cardio", description, tiles,
      emptyBox("No cardio recorded this month.",
        "Use Edit in the Daily Tracker to enter a duration as min:sec."));
  }
  const points = data.daily.map((day) => ({
    date: day.date, value: day.cardio_seconds, display: day.cardio_display,
  }));
  return section("cardio", "Cardio", description, tiles,
    make("h4", { text: "Daily cardio" }),
    barChart(points, {
      name: "Daily cardio", unit: "min:sec", steps: CARDIO_STEPS,
      tick: (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    }),
    make("h4", { text: "Weekly cardio totals" }),
    weeklyNumbers(data.weekly, "cardio", [
      ["Total (min:sec)", "week-total", (entry) => entry.total_display],
    ]));
}

function weightSection(data) {
  const weight = data.weight_lifted;
  const days = weight.days_recorded;
  const none = days === 0;
  const kg = (value) => formatWithUnit(value, "kg");
  const tiles = make("div", { class: "tiles" },
    tile("weight-total", "Total weight lifted", kg(weight.total_kg),
      none ? "No entries" : `over ${formatDays(days)}`),
    tile("weight-average", "Average on recorded days", kg(weight.average_kg)),
    tile("weight-highest", "Highest single day", kg(weight.highest_kg), dateNote(weight.highest_date)),
    tile("weight-lowest", "Lowest single day", kg(weight.lowest_kg), dateNote(weight.lowest_date)),
    tile("weight-days", "Days recorded", String(days)));
  const description = "One total in kg for each day. Days without an entry are left out of the average.";
  if (none) {
    return section("weight", "Weight Lifted", description, tiles,
      emptyBox("No weight-lifting entries recorded this month.",
        "Use Edit in the Daily Tracker to enter the day's total in kg."));
  }
  const points = data.daily.map((day) => ({
    date: day.date, value: day.weight_lifted_kg, display: kg(day.weight_lifted_kg),
  }));
  return section("weight", "Weight Lifted", description, tiles,
    make("h4", { text: "Daily total weight lifted" }),
    barChart(points, { name: "Daily total weight lifted", unit: "kg", steps: null, tick: formatNumber }),
    make("h4", { text: "Weekly weight lifted" }),
    weeklyNumbers(data.weekly, "weight_lifted", [
      ["Total (kg)", "week-total", (entry) => kg(entry.total_kg)],
      ["Average (kg)", "week-average", (entry) => kg(entry.average_kg)],
    ]));
}

// Calories and protein: the same five figures, a bar for each day with an
// entry, and the weekly figures. There is nothing to compare them against.
function numberSection(data, options) {
  const { name, unit } = options;
  const stats = data[name];
  const days = stats.days_recorded;
  const none = days === 0;
  const withUnit = (value) => formatWithUnit(value, unit);
  const tiles = make("div", { class: "tiles" },
    tile(`${name}-total`, "Monthly total", withUnit(stats[`total_${unit}`]),
      none ? "No entries" : `over ${formatDays(days)}`),
    tile(`${name}-average`, "Average on recorded days", withUnit(stats[`average_${unit}`])),
    tile(`${name}-days`, "Days recorded", String(days)),
    tile(`${name}-highest`, "Highest day", withUnit(stats[`highest_${unit}`]), dateNote(stats.highest_date)),
    tile(`${name}-lowest`, "Lowest day", withUnit(stats[`lowest_${unit}`]), dateNote(stats.lowest_date)));
  if (none) {
    return section(name, options.title, options.description, tiles,
      emptyBox(options.nothing, "Use Edit in the Daily Tracker to enter it for a day."));
  }
  const points = data.daily.map((day) => ({
    date: day.date, value: day[options.field], display: withUnit(day[options.field]),
  }));
  return section(name, options.title, options.description, tiles,
    make("h4", { text: options.chart }),
    barChart(points, { name: options.chart, unit, steps: null, tick: formatNumber }),
    make("h4", { text: options.weekly }),
    weeklyNumbers(data.weekly, name, [
      [`Total (${unit})`, "week-total", (entry) => withUnit(entry[`total_${unit}`])],
      [`Average (${unit})`, "week-average", (entry) => withUnit(entry[`average_${unit}`])],
      [`Highest (${unit})`, "week-highest", (entry) => withUnit(entry[`highest_${unit}`])],
      [`Lowest (${unit})`, "week-lowest", (entry) => withUnit(entry[`lowest_${unit}`])],
    ]));
}

// ---------------------------------------------------------------- body measurements

function measurementSection(measurements) {
  const description = "Each value is compared with the Sunday immediately before it in this month. " +
    "Nothing is taken from another month.";
  if (MEASURES.every(([key]) => measurements[key].current === null)) {
    const sundays = measurements[MEASURES[0][0]].trend.map((point) => formatDay(point.date));
    return section("measurements", "Body Measurements", description,
      emptyBox("No Sunday measurements recorded this month.",
        `Sundays in this month: ${sundays.join(", ")}.`));
  }
  return section("measurements", "Body Measurements", description,
    make("div", { class: "cards three" },
      ...MEASURES.map(([key, label, unit]) => measurementCard(key, label, unit, measurements[key]))));
}

function measurementCard(key, label, unit, stats) {
  const cell = (field, name, value, note) => make("div", { class: "trio-cell", data: { field } },
    make("div", { class: "trio-label", text: name }),
    make("div", { class: "trio-value value", text: value }),
    make("div", { class: "sub", text: note || "" }));
  const recorded = stats.current !== null;

  const card = make("div", { class: "card measure", data: { measure: key } },
    make("h4", { text: `${label} (${unit})` }),
    make("div", { class: "figure", data: { field: "current" } },
      make("span", { class: "figure-value value" }, ...unitParts(formatWithUnit(stats.current, unit))),
      make("span", {
        class: "figure-label",
        text: recorded ? `current, ${formatDay(stats.current_date)}` : "current",
      })),
    make("div", { class: "trio" },
      cell("previous", "Previous", formatWithUnit(stats.previous, unit),
        stats.previous !== null ? formatDay(stats.previous_date) : ""),
      cell("change", "Change", formatSigned(stats.change, ` ${unit}`)),
      cell("change-percentage", "Change %", formatSigned(stats.change_percentage, "%"))));

  if (!recorded) {
    card.append(make("p", { class: "sub measure-note", data: { empty: "true" },
      text: "No values recorded this month." }));
    return card;
  }
  if (stats.previous === null) {
    card.append(make("p", { class: "sub measure-note", data: { note: "previous" },
      text: stats.previous_date
        ? `${formatDay(stats.previous_date)} was not recorded, so there is no change to show.`
        : "No earlier Sunday in this month, so there is no previous value." }));
  }
  card.append(lineChart(stats.trend, { name: label, unit }));
  return card;
}

// ---------------------------------------------------------------- charts

function niceTicks(max, steps) {
  let step;
  if (steps) {
    step = steps.find((candidate) => max / candidate <= 4) || steps[steps.length - 1];
  } else {
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(max, 1) / 4)));
    step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => max / candidate <= 4);
  }
  const top = Math.max(1, Math.ceil(max / step)) * step;
  const ticks = [];
  for (let index = 0; index * step <= top; index++) ticks.push(index * step);
  return ticks;
}

// One bar per day that has an entry. Days without an entry are left empty; a
// recorded zero still gets a thin bar so it can be seen and pointed at. On a
// phone the chart is drawn to the width of the phone: thinner bars, and the
// day written under every fifth one.
function barChart(points, options) {
  const compact = isNarrow();
  const width = compact ? 340 : 760, height = compact ? 232 : 270;
  const left = 60, right = compact ? 6 : 10, top = 30, bottom = 46;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const base = top + plotHeight;
  const recorded = points.filter((point) => point.value !== null);
  const highest = Math.max(...recorded.map((point) => point.value));
  const ticks = niceTicks(highest, options.steps);
  const scaleMax = ticks[ticks.length - 1];
  const slot = plotWidth / points.length;
  const barWidth = compact ? Math.max(3, slot - 3) : Math.min(24, slot - 6);
  // How many bars from either end the label of the tallest one is kept inside the chart.
  const edge = compact ? 6 : 2;

  const svg = makeSvg("svg", {
    class: compact ? "chart compact" : "chart",
    attrs: {
      viewBox: `0 0 ${width} ${height}`, role: "group",
      "aria-label": `${options.name} in ${options.unit}: ${formatDays(recorded.length)} with an entry. ` +
        "The same values are in the Daily Tracker table.",
    },
  });
  svg.append(
    makeSvg("text", {
      class: "axis-title", text: options.unit,
      attrs: compact ? { x: 2, y: 14, "text-anchor": "start" } : { x: left - 8, y: 14, "text-anchor": "end" },
    }),
    makeSvg("text", {
      class: "axis-title", text: "Day of month",
      attrs: { x: left + plotWidth / 2, y: height - 8, "text-anchor": "middle" },
    }));

  for (const value of ticks) {
    const y = base - (value / scaleMax) * plotHeight;
    svg.append(
      makeSvg("line", {
        class: value === 0 ? "axis" : "gridline",
        attrs: { x1: left, x2: width - right, y1: y, y2: y },
      }),
      makeSvg("text", {
        class: "tick", text: options.tick(value),
        attrs: { x: left - 8, y: y + 4, "text-anchor": "end" },
      }));
  }

  let labelled = false;
  points.forEach((point, index) => {
    const center = left + slot * index + slot / 2;
    const dayOfMonth = parseDay(point.date).getUTCDate();
    if (!compact || dayOfMonth === 1 || dayOfMonth % 5 === 0) {
      svg.append(makeSvg("text", {
        class: "tick", text: String(dayOfMonth),
        attrs: { x: center, y: base + (compact ? 18 : 16), "text-anchor": "middle" },
      }));
    }
    if (point.value === null) return;
    const barHeight = Math.max(2, (point.value / scaleMax) * plotHeight);
    const x = center - barWidth / 2, y = base - barHeight, r = Math.min(4, barHeight, barWidth / 2);
    svg.append(makeSvg("path", {
      class: "bar", data: { date: point.date },
      attrs: {
        d: `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + barWidth - r}` +
          `Q${x + barWidth},${y} ${x + barWidth},${y + r}V${base}Z`,
      },
    }));
    // The tallest bar carries its value; the rest are on hover, focus and in the table.
    if (!labelled && point.value === highest) {
      labelled = true;
      const anchor = index < edge ? "start" : index > points.length - 1 - edge ? "end" : "middle";
      const labelX = anchor === "start" ? x : anchor === "end" ? x + barWidth : center;
      svg.append(makeSvg("text", {
        class: "point-label", text: point.display,
        attrs: { x: labelX, y: y - 6, "text-anchor": anchor },
      }));
    }
    svg.append(makeSvg("rect", {
      class: "hit", data: { date: point.date, tip: point.display, tipLabel: formatDay(point.date) },
      attrs: {
        x: center - slot / 2, y: top, width: slot, height: plotHeight,
        tabindex: "0", role: "img", "aria-label": `${formatDay(point.date)}: ${point.display}`,
      },
    }));
  });
  return make("div", { class: "chart-scroll" }, svg);
}

// A point per Sunday that has a value. Points are joined only when they are on
// consecutive Sundays, so a missing Sunday shows as a gap. On a phone it is a
// small line with no writing on it: the value is above it in the card, and
// every Sunday is in the Sunday Measurements below.
function lineChart(trend, options) {
  const compact = isNarrow();
  const width = compact ? 160 : 300, height = compact ? 64 : 140;
  const left = compact ? 10 : 24, right = left, top = compact ? 10 : 28, bottom = compact ? 18 : 30;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const values = trend.filter((point) => point.value !== null).map((point) => point.value);
  const low = Math.min(...values), high = Math.max(...values);
  const xOf = (index) =>
    trend.length === 1 ? left + plotWidth / 2 : left + (plotWidth * index) / (trend.length - 1);
  const yOf = (value) =>
    high === low ? top + plotHeight / 2 : top + plotHeight * (1 - (value - low) / (high - low));
  const axisY = top + plotHeight + 10;

  const svg = makeSvg("svg", {
    class: compact ? "chart small compact" : "chart small",
    attrs: {
      viewBox: `0 0 ${width} ${height}`, role: "group",
      "aria-label": `${options.name} on each Sunday of this month: ` + trend.map((point) =>
        `${formatDay(point.date)} ${point.value === null ? "not recorded" : formatWithUnit(point.value, options.unit)}`
      ).join(", "),
    },
  });
  svg.append(makeSvg("line", {
    class: "axis",
    attrs: { x1: compact ? 0 : left - 14, x2: compact ? width : width - right + 14, y1: axisY, y2: axisY },
  }));

  let lastRecorded = -1;
  trend.forEach((point, index) => {
    if (!compact) {
      svg.append(makeSvg("text", {
        class: "tick", text: formatDay(point.date).slice(4),
        attrs: { x: xOf(index), y: height - 4, "text-anchor": "middle" },
      }));
    }
    if (point.value === null) return;
    const previous = trend[index - 1];
    if (previous && previous.value !== null) {
      svg.append(makeSvg("line", {
        class: "line",
        attrs: { x1: xOf(index - 1), y1: yOf(previous.value), x2: xOf(index), y2: yOf(point.value) },
      }));
    }
    lastRecorded = index;
  });

  trend.forEach((point, index) => {
    if (point.value === null) return;
    const x = xOf(index), y = yOf(point.value);
    const display = formatWithUnit(point.value, options.unit);
    svg.append(makeSvg("circle", {
      class: "dot", data: { date: point.date }, attrs: { cx: x, cy: y, r: 4.5 },
    }));
    if (index === lastRecorded && !compact) {
      svg.append(makeSvg("text", {
        class: "point-label", text: formatNumber(point.value),
        attrs: { x, y: y - 10, "text-anchor": "middle" },
      }));
    }
    svg.append(makeSvg("circle", {
      class: "hit", data: { date: point.date, tip: display, tipLabel: formatDay(point.date) },
      attrs: {
        cx: x, cy: y, r: 14, tabindex: "0", role: "img",
        "aria-label": `${formatDay(point.date)}: ${display}`,
      },
    }));
  });
  return svg;
}

// ---------------------------------------------------------------- tooltip

// One tooltip for every element that carries data-tip. Shown on hover and on
// keyboard focus. Everything it shows is also in the tables on the page.
function setupTooltip(root) {
  const tip = make("div", { class: "tip", attrs: { role: "tooltip" } },
    make("strong", {}), make("span", {}));
  tip.hidden = true;
  document.body.append(tip);

  const target = (event) => (event.target.closest ? event.target.closest("[data-tip]") : null);
  const place = (x, y) => {
    const maxLeft = window.innerWidth - tip.offsetWidth - 8;
    tip.style.left = `${Math.max(8, Math.min(x + 12, maxLeft))}px`;
    tip.style.top = `${y + 14}px`;
  };
  const show = (node) => {
    tip.children[0].textContent = node.dataset.tip;
    tip.children[1].textContent = node.dataset.tipLabel;
    tip.hidden = false;
  };

  root.addEventListener("pointerover", (event) => {
    const node = target(event);
    if (node) { show(node); place(event.clientX, event.clientY); }
  });
  root.addEventListener("pointermove", (event) => {
    if (!tip.hidden) place(event.clientX, event.clientY);
  });
  root.addEventListener("pointerout", () => { tip.hidden = true; });
  root.addEventListener("focusin", (event) => {
    const node = target(event);
    if (!node) return;
    const box = node.getBoundingClientRect();
    show(node);
    place(box.left + box.width / 2, box.top + Math.min(box.height, 24));
  });
  root.addEventListener("focusout", () => { tip.hidden = true; });
}
