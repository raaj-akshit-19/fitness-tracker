"""Checks that the backend serves the frontend and that its files stay local.

Run from the project root:  python -m unittest discover -s tests -v
"""

import re
import shutil
import tempfile
import unittest
from pathlib import Path

from backend import workbook as wbk
from backend.app import FRONTEND_DIR, create_app

FILES = ["index.html", "styles.css", "format.js", "analytics.js", "app.js", "editor.js"]


class FrontendServingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        path = wbk.create_workbook(self.tmp / "Fitness_Tracker.xlsx")
        self.client = create_app(path).test_client()

    def get(self, path):
        response = self.client.get(path)
        self.addCleanup(response.close)
        return response

    def test_index_is_served(self):
        response = self.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("text/html", response.content_type)
        self.assertIn("<title>Raft</title>", response.get_data(as_text=True))

    def test_assets_are_served(self):
        self.assertIn("css", self.get("/styles.css").content_type)
        for name in ("app.js", "analytics.js", "format.js", "editor.js"):
            self.assertIn("javascript", self.get(f"/{name}").content_type)

    def test_api_still_answers_in_json(self):
        self.assertEqual(len(self.get("/api/months").get_json()), 1)
        missing = self.get("/api/nothing")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.get_json()["error"]["code"], "not_found")


class FrontendSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = {name: (FRONTEND_DIR / name).read_text(encoding="utf-8") for name in FILES}

    def test_nothing_is_loaded_from_the_internet(self):
        for name, text in self.sources.items():
            # The SVG namespace is an identifier, not an address that gets fetched.
            text = text.replace('"http://www.w3.org/2000/svg"', "")
            self.assertIsNone(re.search(r"https?://|//[a-z0-9.-]+\.[a-z]{2,}/", text), name)

    def test_no_month_data_is_hard_coded(self):
        for name, text in self.sources.items():
            self.assertNotIn("2026", text, name)
            self.assertNotIn("October 20", text, name)

    def test_only_writes_are_month_creation_and_the_day_editor(self):
        script = " ".join(self.sources[name] for name in FILES if name.endswith(".js"))
        # One POST (Add New Month, in app.js) and one PUT (Save in either editor, in editor.js).
        self.assertEqual(re.findall(r'method:\s*"(\w+)"', script), ["POST", "PUT"])
        self.assertEqual(re.findall(r'api\("(/api/[a-z]+)", \{\s*method: "POST"', self.sources["app.js"]),
                         ["/api/months"])
        self.assertEqual(re.findall(r'method:\s*"(\w+)"', self.sources["editor.js"]), ["PUT"])
        self.assertEqual(script.count("fetch("), 1)          # everything goes through api()
        self.assertNotIn("PATCH", script)
        self.assertNotIn("DELETE", script)
        page = self.sources["index.html"]
        self.assertNotIn('type="checkbox"', page)
        self.assertNotIn("contenteditable", page)

    def test_page_is_organised_into_the_eight_sections(self):
        page = self.sources["index.html"]
        names = ["tracker", "sunday", "habits", "daily", "weekly", "cardio", "weight",
                 "measurements"]
        titles = ["Daily Tracker", "Sunday Measurements", "Habit Overview",
                  "Daily Habit Progress", "Weekly Habit Analytics", "Cardio", "Weight Lifted",
                  "Body Measurements"]
        # The bar of links names the areas of the page, short enough for a phone, in the order they
        # come: today, the days, the habits, nutrition, training, the weeks, the body. Each leads to
        # the first section of its area. Today is there only in the month that holds today. There
        # is one set of links, because there is one dashboard.
        links = re.findall(r'<a href="#([a-z-]+)"(?: class="([a-z0-9 -]+)")?>([^<]+)</a>', page)
        self.assertEqual(links, [
            ("today-strip", "today-link", "Today"), ("section-tracker", "", "Days"),
            ("section-habits", "", "Habits"), ("section-calories", "", "Nutrition"),
            ("section-cardio", "", "Training"), ("section-weekly", "", "Weekly"),
            ("section-measurements", "", "Body")])
        css = self.sources["styles.css"]
        self.assertRegex(css, r'\.section-nav\[data-today="no"\] \.today-link \{\s*display: none;')
        self.assertNotIn("data-version", css + page + self.sources["app.js"])
        self.assertIn('els.nav.dataset.today = day ? "yes" : "no";', self.sources["app.js"])
        # Two sections are in the page; the others are built by the scripts, each in one place.
        static = re.findall(r'<section id="section-([a-z]+)"[^>]*>\s*<h3[^>]*>([^<]+)</h3>', page)
        self.assertEqual(static, list(zip(names[:2], titles[:2])))
        source = self.sources["analytics.js"]
        built = re.findall(r'section\("([a-z]+)", "([^"]+)"', source)
        built += re.findall(r'name: "([a-z]+)", title: "([A-Za-z]+)"', source)       # calories and protein share one builder
        self.assertEqual(sorted(set(built)), sorted(list(zip(names[2:], titles[2:]))
                                                    + [("calories", "Calories"), ("protein", "Protein")]))
        # Every link leads to a part of the page that exists.
        targets = {"today-strip", "section-calories", "section-protein"} | {f"section-{name}" for name in names}
        self.assertLessEqual({target for target, _, _ in links}, targets)
        # The sections are built in the order the links name their areas: the habits, then calories
        # and protein, then cardio and weight, then the weeks, then the body. One builder, for every month.
        scripts = " ".join(self.sources[name] for name in FILES if name.endswith(".js"))
        self.assertEqual(re.findall(r"function (buildAnalytics\w*)\(", scripts), ["buildAnalytics"])
        body = re.search(r"function buildAnalytics\(data\) \{\s*return \[(.*?)\];", self.sources["analytics.js"], re.S)
        self.assertEqual(re.findall(r"(\w+)Section\(", body.group(1)),
                         ["habit", "daily", "number", "number", "cardio", "weight", "weekly", "measurement"])
        # The areas that hold more than one section carry the name of the area above each of them.
        for area, sections in (("Nutrition", ("calories", "protein")), ("Training", ("cardio", "weight")),
                               ("Body", ("measurements", "sunday"))):
            rule = ",\n".join(f'.block[data-section="{name}"]::before' for name in sections)
            self.assertIn(rule + ' {\n  content: "' + area + '";', css)

    def test_status_carries_the_backends_date(self):
        from datetime import date
        from backend import workbook
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        path = workbook.create_workbook(tmp / "Fitness_Tracker.xlsx")
        client = create_app(path, today=lambda: date(2031, 5, 6)).test_client()
        self.assertEqual(client.get("/api/status").get_json()["today"], "2031-05-06")

    def test_day_editor_is_a_labelled_dialog(self):
        page = self.sources["index.html"]
        dialog = re.search(r'<dialog id="edit-dialog"[^>]*>(.*?)</dialog>', page, re.S)
        self.assertIsNotNone(dialog)
        self.assertIn('aria-labelledby="edit-title"', dialog.group(0))
        body = dialog.group(1)
        self.assertIn('<h2 id="edit-title">Edit Progress</h2>', body)
        labels = dict(re.findall(r'<label for="([a-z-]+)">([^<]+)</label>', body))
        self.assertEqual(labels, {
            "edit-exercise": "Exercise", "edit-junk-food": "Junk Food",
            "edit-cardio": "Cardio (min:sec)", "edit-calories": "Calories (kcal)",
            "edit-protein": "Protein (g)", "edit-weight": "Weight Lifted (kg)",
        })
        # Two dropdowns and four typed fields, each with its own label and its own error line.
        controls = re.findall(r'<(select|input) id="([a-z-]+)"', body)
        self.assertEqual(controls, [("select", "edit-exercise"), ("select", "edit-junk-food"),
                                    ("input", "edit-cardio"), ("input", "edit-calories"),
                                    ("input", "edit-protein"), ("input", "edit-weight")])
        for _, control in controls:
            self.assertIn(f'aria-describedby="{control}-error"', body)
            self.assertIn(f'<p id="{control}-error" class="field-error" hidden></p>', body)
        self.assertIn('<p id="edit-error" class="notice" role="alert" hidden></p>', body)
        # Cancel is a plain button, so Enter in a field can only ever press Save.
        self.assertEqual(re.findall(r'<button id="([a-z-]+)" type="(\w+)"', body),
                         [("edit-cancel", "button"), ("edit-save", "submit")])
        self.assertNotIn('type="number"', body)     # a number field hides mistyped text as empty
        self.assertNotIn("autofocus", body)

    def test_measurement_editor_is_a_labelled_dialog_like_the_day_editor(self):
        page = self.sources["index.html"]
        dialog = re.search(r'<dialog id="measure-dialog"[^>]*>(.*?)</dialog>', page, re.S)
        self.assertIsNotNone(dialog)
        self.assertIn('class="edit-dialog"', dialog.group(0))
        self.assertIn('aria-labelledby="measure-title"', dialog.group(0))
        body = dialog.group(1)
        self.assertIn('<h2 id="measure-title">Edit Measurements</h2>', body)
        labels = dict(re.findall(r'<label for="([a-z-]+)">([^<]+)</label>', body))
        self.assertEqual(labels, {
            "measure-weight": "Weight (kg)", "measure-waist": "Waist (cm)", "measure-chest": "Chest (cm)",
            "measure-bicep": "Bicep (cm)", "measure-thigh": "Thigh (cm)", "measure-forearm": "Forearm (cm)",
        })
        controls = re.findall(r'<(select|input) id="([a-z-]+)"', body)
        self.assertEqual(controls, [("input", key) for key in labels])
        for _, control in controls:
            self.assertIn(f'aria-describedby="{control}-error"', body)
            self.assertIn(f'<p id="{control}-error" class="field-error" hidden></p>', body)
        self.assertIn('<p id="measure-error" class="notice" role="alert" hidden></p>', body)
        self.assertEqual(re.findall(r'<button id="([a-z-]+)" type="(\w+)"', body),
                         [("measure-cancel", "button"), ("measure-save", "submit")])
        self.assertNotIn('type="number"', body)
        # Built the same way as the day editor: same parts, in the same order.
        day = re.search(r'<dialog id="edit-dialog"[^>]*>(.*?)</dialog>', page, re.S).group(1)
        shape = lambda text: re.findall(r'<(form|h2|div class="[a-z-]+"|p id="[a-z-]+-(?:date|error)"|button)',
                                        re.sub(r'(edit|measure)-(?!fields|date|error)[a-z-]+-error', "x-error", text))
        self.assertEqual([part.replace("measure-", "edit-") for part in shape(body)], shape(day))

    def test_sunday_section_says_how_to_edit_and_nothing_else(self):
        page = self.sources["index.html"]
        section = re.search(r'<section id="section-sunday".*?</section>', page, re.S).group(0)
        self.assertIn("Use Edit to change a Sunday's measurements", " ".join(section.split()))
        self.assertNotIn("<button", section)                # its Edit buttons are made for each Sunday, by the script
        self.assertNotIn("upgrade", section.lower())
        self.assertIn('<p id="measure-saved-note" class="saved-note" role="status" hidden></p>', section)
        self.assertRegex(page, r'<div class="table-scroll">\s*<table id="measurements-table"[^>]*>')
        self.assertEqual(re.findall(r"<th[^>]*>([^<]+)</th>", re.search(r'<tr id="measurements-head">(.*?)</tr>', page, re.S).group(1)),
                         ["Sunday", "Weight (kg)", "Waist (cm)", "Chest (cm)", "Bicep (cm)", "Thigh (cm)", "Forearm (cm)", "Edit"])

    def test_there_is_one_application_with_no_versions_and_nothing_to_upgrade(self):
        page, css = self.sources["index.html"], self.sources["styles.css"]
        everything = " ".join(self.sources.values())
        # Nothing the user can see or be served names a version, an upgrade, a migration or a backup.
        for word in ("version", "upgrade", "migrat", "legacy", "backup", "v1", "v2"):
            self.assertNotIn(word, everything.lower(), word)
        # One table of days and one of Sundays, with the one set of columns; no second set anywhere.
        self.assertEqual(page.count("<table"), 2)
        self.assertEqual(re.findall(r"<th[^>]*>([^<]+)</th>", re.search(r'<tr id="days-head">(.*?)</tr>', page, re.S).group(1)),
                         ["Date", "Exercise", "Junk Food", "Cardio (min:sec)", "Calories (kcal)", "Protein (g)",
                          "Weight Lifted (kg)", "Edit"])
        for gone in ('id="tracker-v', 'id="sunday-v', 'id="upgrade', "TRUE in Excel", "read-only here", "No Junk Food",
                     "Total Weight Lifted", 'class="box', "no_junk_food", "total_weight_lifted", ".box"):
            self.assertNotIn(gone, everything, gone)
        self.assertIn('<p id="saved-note" class="saved-note" role="status" hidden></p>', page)
        # The only things to press outside the editors: the month selector and Add New Month.
        outside = re.sub(r"<dialog.*?</dialog>", "", page, flags=re.S)
        self.assertEqual(re.findall(r'<button id="([a-z-]+)"', outside), ["add-month"])
        self.assertEqual(re.findall(r'<select id="([a-z-]+)"', outside), ["month-select"])
        # The page does not branch on what kind of month it has: there is one path through it.
        scripts = " ".join(self.sources[name] for name in FILES if name.endswith(".js"))
        self.assertEqual(re.findall(r"function (buildAnalytics\w*|renderToday\w*|renderMonth)\(", scripts),
                         ["buildAnalytics", "renderToday", "renderMonth"])
        self.assertNotIn("data-version", css + page + scripts)

    def test_editor_layout_holds_on_small_screens(self):
        page, css = self.sources["index.html"], self.sources["styles.css"]
        # The daily table still scrolls inside its own box; the page does not.
        self.assertRegex(page, r'<div class="table-scroll">\s*<table id="days-table"[^>]*>')
        self.assertEqual(page.count("<dialog"), page.count("</dialog>"))
        self.assertEqual(page.count("<dialog"), 3)      # Add New Month, a day, a Sunday's measurements
        self.assertEqual(page.count('class="edit-fields"'), 2)     # both editors use the one layout
        # On a phone a dialog is a sheet across the bottom of the window: as wide as the window,
        # one field to a line, Cancel and Save sharing the width.
        phone = self.phone_css()
        self.assertRegex(phone, r"dialog \{\s*width: 100%;\s*max-width: 100%;[^}]*margin: auto 0 0;")
        self.assertRegex(phone, r"\.edit-fields \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);")
        self.assertRegex(phone, r"\.actions button \{\s*flex: 1 1 0;")
        # From a tablet up it is a panel in the middle that keeps clear of the edges, two fields to a line.
        tablet = self.css_block("@media (min-width: 600px)")
        self.assertRegex(tablet, r"dialog \{[^}]*max-width: calc\(100vw - 32px\);\s*margin: auto;")
        self.assertRegex(tablet, r"\.edit-fields \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);")
        self.assertRegex(css, r"button:focus-visible")

    def test_the_sections_are_built_in_one_script_with_one_set_of_pieces(self):
        source = self.sources["analytics.js"]
        self.assertEqual(re.findall(r'name: "([a-z]+)", title: "([A-Za-z]+)"', source),
                         [("calories", "Calories"), ("protein", "Protein")])
        self.assertIn("measurementSection(data.measurements)", source)
        # One of each piece: no second chart, tooltip, section or figure system.
        for piece in ("function barChart(", "function lineChart(", "function setupTooltip(", "function section(",
                      "function tile(", "function emptyBox(", "function habitCard(", "function stackBar("):
            self.assertEqual(source.count(piece), 1, piece)
        page = self.sources["index.html"]
        order = re.findall(r'<script src="([a-z_0-9.]+)"></script>', page)
        self.assertEqual(order, ["format.js", "analytics.js", "app.js", "editor.js"])
        # The page asks the one analytics address: when a month is loaded, and once more after a save.
        self.assertEqual(self.sources["app.js"].count("/analytics`"), 2)
        self.assertNotIn("not available yet", " ".join(self.sources.values()))

    def test_excluded_features_are_absent(self):
        combined = " ".join(self.sources.values()).lower()
        # (Short transitions and one-off animations are part of the design; see the motion tests.)
        for word in ["goal", "meditation", "yearly", "annual", "1rm", "muscle", "score",
                     "rating", "ranking", "—"]:
            self.assertNotIn(word, combined, word)

    # ------------------------------------------------------------ design, motion and small screens

    def css_block(self, start):
        """The text of the stylesheet block that begins with start, up to its closing brace."""
        css = self.sources["styles.css"]
        begin = css.index(start)
        depth = 0
        for position in range(css.index("{", begin), len(css)):
            depth += {"{": 1, "}": -1}.get(css[position], 0)
            if depth == 0:
                return css[begin:position + 1]
        raise AssertionError(f"unclosed block: {start}")

    def phone_css(self):
        """What a phone gets: the stylesheet up to its first block for a wider screen."""
        css = self.sources["styles.css"]
        return css[:css.index("@media (min-width:")]

    def test_motion_is_short_and_never_endless(self):
        css = self.sources["styles.css"]
        # Every duration and delay is written in milliseconds and is brief.
        times = [int(value) for value in re.findall(r"\b(\d+)ms\b", css)]
        self.assertGreater(len(times), 10)
        self.assertLessEqual(max(times), 400)
        self.assertIsNone(re.search(r"(?<![\w.#-])\d*\.?\d+s\b", css))          # nothing timed in whole seconds
        for word in ("infinite", "alternate", "bounce", "elastic", "parallax", "@import", "url("):
            self.assertNotIn(word, css, word)
        names = re.findall(r"@keyframes ([a-z-]+)", css)
        self.assertEqual(sorted(names), ["appear", "grow-across", "grow-up", "rise", "rise-again", "tint"])
        # Each keyframe set only says where to start from: it ends in the element's own style.
        for name in names:
            block = self.css_block(f"@keyframes {name} ")
            self.assertIn("from {", block)
            self.assertNotIn("to {", block)
            self.assertNotIn("%", block)
        # Nothing on the page follows the pointer or moves on its own.
        scripts = " ".join(self.sources[name] for name in FILES if name.endswith(".js"))
        for word in ("mousemove", "setInterval", ".animate("):
            self.assertNotIn(word, scripts, word)
        self.assertEqual(scripts.count("requestAnimationFrame("), 1)        # following the scroll, once a frame

    def test_reduced_motion_is_respected(self):
        css = self.sources["styles.css"]
        block = self.css_block("@media (prefers-reduced-motion: reduce)")
        self.assertIn("animation: none !important;", block)
        self.assertIn("transition: none !important;", block)
        self.assertIn("scroll-behavior: auto;", block)
        self.assertRegex(block, r"\*,\s*\*::before,\s*\*::after")
        self.assertTrue(css.rstrip().endswith(block.rstrip()))              # last, so nothing overrides it
        # Smooth scrolling is only ever on for someone who has not asked for less motion: of the
        # page, and of the row of links on a phone. The script never asks for it itself.
        self.assertEqual(css.count("scroll-behavior: smooth"), 1)
        self.assertRegex(self.css_block("@media (prefers-reduced-motion: no-preference)"),
                         r"html,\s*\.section-nav \{\s*scroll-behavior: smooth;")
        scripts = " ".join(self.sources[name] for name in FILES if name.endswith(".js"))
        self.assertNotIn("smooth", scripts)
        self.assertIn("els.nav.scrollTo({ left: current.offsetLeft - els.nav.offsetLeft });", scripts)

    def test_dialogs_fade_in_and_out_without_script(self):
        css = self.sources["styles.css"]
        self.assertRegex(css, r"dialog \{\s*opacity: 0;[^}]*transition: opacity 160ms ease, transform 160ms")
        self.assertIn("allow-discrete", css)
        self.assertIn("@starting-style", css)
        self.assertRegex(css, r"dialog\[open\] \{\s*opacity: 1;\s*transform: none;")
        self.assertRegex(css, r"dialog:not\(\[open\]\) \{\s*pointer-events: none;")     # a closing dialog is not in the way
        # The editors still open and close through the dialog itself; no timers hold them open.
        editor = self.sources["editor.js"]
        self.assertEqual(editor.count("els.dialog.close()"), 3)
        self.assertEqual(editor.count("els.dialog.showModal()"), 1)
        self.assertNotIn("setTimeout", editor)
        # A dialog never grows past the window, and its buttons stay at its foot.
        self.assertRegex(css, r"dialog \{[^}]*max-height: calc\(100dvh - 32px\);[^}]*overflow-y: auto;")
        self.assertRegex(css, r"\.actions \{\s*position: sticky;\s*bottom: 0;")

    def test_no_decorative_effects(self):
        css = self.sources["styles.css"]
        for word in ("text-shadow", "cursor: none", "perspective", "rotate3d", "mix-blend", "conic-gradient",
                     "background-clip: text", "-webkit-text-fill-color", "drop-shadow", "parallax"):
            self.assertNotIn(word, css, word)
        # Gradients are atmosphere, not the design: the glow fixed behind the page (two soft
        # patches in one rule, which takes no clicks) and the one sheen that glass surfaces share.
        self.assertEqual(css.count("radial-gradient("), 2)
        self.assertEqual(css.count("linear-gradient("), 1)
        glow = self.css_block("body::before {")
        self.assertEqual(glow.count("radial-gradient("), 2)
        for needed in ("position: fixed;", "z-index: -1;", "pointer-events: none;"):
            self.assertIn(needed, glow)
        self.assertIn("--sheen: linear-gradient(", self.css_block(":root {"))
        for strength in re.findall(r"--glow-[a-z]+: rgba\(\d+, \d+, \d+, ([\d.]+)\);", css):
            self.assertLessEqual(float(strength), 0.12)             # a glow, never a bright background
        # Glass is kept for what sits over something else: the bar of links, the panel for
        # today, and the page behind a dialog. Nothing else blurs, and nothing is filtered.
        self.assertEqual(len(re.findall(r"\n\s+backdrop-filter: ", css)), 3)
        self.assertEqual(len(re.findall(r"\n\s+-webkit-backdrop-filter: ", css)), 3)
        for glass in (".today-strip {", "dialog::backdrop {\n  background"):
            self.assertIn("backdrop-filter: ", self.css_block(glass), glass)
        self.assertRegex(css, r"@supports \(\(backdrop-filter: blur\(1px\)\)[^{]*\{\s*\.month-bar\.stuck \{[^}]*backdrop-filter: var\(--frost\);")
        self.assertEqual(re.findall(r"(?<!backdrop-)filter: ", css), [])
        self.assertLessEqual(max(int(size) for size in re.findall(r"blur\((\d+)px\)", css)), 20)
        # Soft corners and no pill shapes. Corners come in set sizes: panels, the tiles set into
        # them, controls, a dialog, and marks. A control is never rounded as much as a panel, and
        # nothing is rounded into a pill or a circle.
        sizes = {name: int(size) for name, size in re.findall(r"--r-([a-z]+): (\d+)px;", css)}
        self.assertEqual(sizes, {"panel": 20, "inner": 16, "control": 12, "overlay": 24, "mark": 4})
        self.assertLess(sizes["control"], 46 / 2 - 6)               # far from half the height of a control
        radii = [float(value) for value in re.findall(r"border-radius: (\d+(?:\.\d+)?)px", css)]
        self.assertLessEqual(max(radii), 24)
        self.assertEqual(re.findall(r"border-radius: [^;]*(?:%|em|999)", css), [])
        for control in ("select,\ninput {", "button {\n  height", ".notice {"):
            self.assertIn("border-radius: var(--r-control);", self.css_block(control), control)
        # Not everything is a panel: only today, and the cards of the habits and the measurements.
        self.assertEqual(css.count("border-radius: var(--r-panel);"), 2)
        self.assertIn("border-radius: var(--r-panel);", self.css_block(".today-strip {"))
        self.assertIn("border-radius: var(--r-panel);", self.css_block(".card,\n.today-panel {"))
        # Two things float, each with the one shadow made for it: the panel for today, and a
        # dialog. The cards lift a little. Only the main action glows, and only faintly. Every
        # other box-shadow is a line drawn inside an edge.
        self.assertEqual(re.findall(r"--shadow-([a-z]+):", css), ["raised", "overlay", "card", "glow"])
        self.assertEqual(re.findall(r"box-shadow: var\(--shadow-([a-z]+)\)", css), ["raised", "glow", "raised", "card", "overlay"])
        self.assertIn("box-shadow: var(--shadow-raised);", self.css_block("select::picker(select) {\n  max-block-size"))   # an open dropdown list
        self.assertIn("box-shadow: var(--shadow-glow);", self.css_block("button {\n  height"))
        self.assertIn("box-shadow: inset ", self.css_block("button.secondary {"))      # an outlined button does not glow
        glows = re.findall(r"0 0 (\d+)px rgba\(255, 95, 31, ([\d.]+)\)", css)
        self.assertEqual(len(glows), 1)
        self.assertTrue(int(glows[0][0]) <= 24 and float(glows[0][1]) <= 0.15, glows)
        self.assertIn("box-shadow: var(--shadow-raised);", self.css_block(".today-strip {"))
        self.assertIn("box-shadow: var(--shadow-card);", self.css_block(".card,\n.today-panel {"))
        self.assertIn("box-shadow: var(--shadow-overlay);", self.css_block("dialog {"))
        for shadow in re.findall(r"box-shadow: ([^;]+);", css):
            if shadow != "none" and not shadow.startswith("var(--shadow-"):
                parts = re.split(r",\s*(?![^()]*\))", shadow)        # a comma inside rgba() is not a new shadow
                self.assertTrue(all(part.strip().startswith("inset ") for part in parts), shadow)
        page = self.sources["index.html"].lower()
        for word in ("<img", "<video", "<canvas", "<svg", "hero", "testimonial", "journey", "transform your"):
            self.assertNotIn(word, page, word)

    def test_today_and_the_month_bar_are_in_the_page(self):
        page = self.sources["index.html"]
        toolbar = re.search(r'<div class="toolbar">(.*?)</div>', page, re.S).group(1)
        self.assertEqual(re.findall(r"<(h2|label|select|button)[ >]", toolbar), ["h2", "label", "select", "button"])
        self.assertIn('<h2 id="month-title"></h2>', toolbar)
        self.assertIn('<label for="month-select">Select Month</label>', toolbar)
        bar = re.search(r'<div id="month-bar" class="month-bar">(.*?)</nav>\s*</div>', page, re.S).group(1)
        self.assertIn('<span id="bar-month" class="bar-month" aria-hidden="true"></span>', bar)
        self.assertIn('<nav id="section-nav" class="section-nav" aria-label="Sections on this page">', bar)
        self.assertIn('<section id="today-strip" class="today-strip" aria-label="Today" hidden></section>', page)
        # Today comes before the daily tracker, which comes before the analytics. The Sundays'
        # measurements close the page, under the body measurements that are worked out from them.
        order = [page.index(text) for text in ('id="month-bar"', 'id="today-strip"', 'id="section-tracker"',
                                               'id="analytics-body"', 'id="section-sunday"')]
        self.assertEqual(order, sorted(order))
        css = self.sources["styles.css"]
        # On a phone the month is chosen from the selector, set as large as a heading; the heading
        # and the label are still there for a screen reader, only out of sight. Add New Month is a
        # small button that keeps its name. At a desk all of them are shown.
        self.assertIn('<button id="add-month" type="button" class="secondary" title="Add New Month">'
                      '<span class="add-plus" aria-hidden="true">+</span>'
                      '<span class="add-text">Add New Month</span></button>', toolbar)
        hidden = r"\.toolbar h2,\s*\.toolbar label,\s*\.add-text \{\s*position: "
        self.assertRegex(self.phone_css(), hidden + r"absolute;[^}]*clip-path: inset\(50%\);")
        self.assertRegex(self.css_block("@media (min-width: 1000px)"), hidden + r"static;")
        self.assertRegex(self.phone_css(), r"#month-select \{[^}]*font-size: 21px;\s*font-weight: 600;")
        self.assertRegex(css, r"\.month-bar \{\s*position: sticky;\s*top: 0;")
        self.assertRegex(css, r'\.section-nav a\[aria-current="true"\] \{[^}]*border-bottom-color')

    def test_small_screens_get_their_own_layout(self):
        page, css = self.sources["index.html"], self.sources["styles.css"]
        self.assertIn('<table id="days-table" class="stack-rows">', page)
        self.assertIn('<table id="measurements-table" class="stack-rows">', page)
        self.assertIn('<meta name="viewport" content="width=device-width, initial-scale=1">', page)
        # The stylesheet is written for a phone first. There is no block for "small screens": what
        # a phone gets is everything before the first block for a wider one, and those blocks, in
        # order of width, only give the same page more room.
        self.assertEqual(re.findall(r"@media \(([a-z-]+: [a-z0-9-]+)\)", css),
                         ["prefers-reduced-motion: no-preference", "min-width: 360px", "min-width: 600px",
                          "min-width: 700px", "min-width: 1000px", "min-width: 1200px",
                          "prefers-reduced-motion: reduce"])
        self.assertNotIn("max-width:", " ".join(re.findall(r"@media[^{]*", css)))
        small = self.phone_css()
        # The two working tables are feeds: each row a block with every value under its label.
        self.assertRegex(small, r"\.stack-rows,\s*\.stack-rows tbody \{\s*display: block;")
        self.assertRegex(small, r"\.stack-rows tbody tr \{\s*display: grid;")
        self.assertRegex(small, r"\.stack-rows td\[data-label\]::before \{\s*content: attr\(data-label\);")
        self.assertRegex(small, r"\.stack-rows td\.action \{\s*grid-column: 2;\s*grid-row: 1;")
        # Nothing gives either table a width of its own, so neither can be wider than the phone.
        self.assertNotRegex(css, r"#(?:days|measurements)-table[^{}]*\{[^}]*min-width: [1-9]")
        # The header row is kept for screen readers, only moved out of sight.
        self.assertRegex(small, r"\.stack-rows thead \{\s*position: absolute;")
        # What a phone does not show: the scrollbar of the links, a link that leads nowhere in this
        # month, the parts that are hidden anyway, and the empty cells and the unusable Edit of a
        # day that has not come yet. Nothing that holds a value is ever left out.
        rules = re.findall(r"([^{}]+)\{[^{}]*display: none;", re.sub(r"/\*.*?\*/", "", small, flags=re.S))
        self.assertEqual([" ".join(rule.split()) for rule in rules], [
            ".section-nav::-webkit-scrollbar",
            '.section-nav[data-today="no"] .today-link',
            ".today-strip[hidden]",
            "#days-body tr.upcoming td[data-label], #days-body tr.upcoming td.action, "
            "#measurements-body tr.upcoming td[data-label], #measurements-body tr.upcoming td.action",
            ".tip[hidden]",
        ])
        self.assertIn('classes.push("upcoming");', self.sources["app.js"])
        # The links are one row that scrolls inside itself; the page never does.
        self.assertRegex(small, r"\.section-nav \{[^}]*overflow-x: auto;\s*scrollbar-width: none;")
        # A section's figures: the first one large on a line of its own, the others two to a line.
        self.assertRegex(small, r"\.tiles \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);")
        self.assertRegex(small, r"\.tiles > \.tile:first-child \{\s*grid-column: 1 / -1;")
        self.assertRegex(small, r"\.tiles > \.tile:first-child \.tile-value \{\s*font-size: 38px;")
        # The six measurements sit two to a line.
        self.assertRegex(small, r"\.cards\.three \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);")
        # Tables and charts that are wider than the phone scroll in their own box.
        self.assertRegex(css, r"\.table-scroll \{\s*overflow-x: auto;")
        self.assertRegex(css, r"\.chart-scroll \{\s*overflow-x: auto;")
        # The weekly tables do, with the week held in view at the left.
        self.assertRegex(small, r'\.weekly th\[scope="row"\],\s*\.totals th\[scope="row"\],[^{]*\{\s*position: sticky;\s*left: 0;')
        # A chart drawn for a phone fits the phone; the page decides which to draw by the one width.
        self.assertRegex(small, r"\.chart\.compact \{\s*min-width: 0;")
        self.assertIn('const NARROW = "(max-width: 599px)";', self.sources["analytics.js"])
        self.assertIn('window.matchMedia(NARROW).addEventListener("change", redrawCharts);', self.sources["app.js"])
        # Controls are tall enough for a thumb, and typed text large enough that a phone does not zoom in on it.
        self.assertRegex(small, r"select,\s*input \{\s*height: 46px;[^}]*font-size: 16px;")
        self.assertRegex(small, r"\nbutton \{\s*height: 46px;")
        # From a tablet the feeds run in two columns, and at a desk the days and the Sundays are tables again.
        self.assertRegex(self.css_block("@media (min-width: 700px)"),
                         r"\.stack-rows tbody,\s*#days-body \{\s*display: grid;\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);")
        desk = self.css_block("@media (min-width: 1000px)")
        self.assertRegex(desk, r"\.stack-rows \{\s*display: table;")
        self.assertRegex(desk, r"\.stack-rows td\[data-label\]::before \{\s*content: none;")
        # At a desk a section's figures stand beside its chart.
        self.assertRegex(desk, r'\.block\[data-section="protein"\] \{\s*display: grid;\s*grid-template-columns: 240px minmax\(0, 1fr\);')
        # On any screen the days of Daily Habit Progress share the width; the label column takes only what it needs.
        self.assertRegex(css, r"table\.grid \{\s*width: 100%;\s*\}")
        self.assertRegex(css, r"\.grid th:first-child \{[^}]*width: 1%;")
        self.assertNotRegex(self.css_block(".grid th,"), r"(?<!min-)width: 25px")
        # Text is never shrunk to fit: nothing on a phone is set below 11.5px.
        sizes = [float(value) for value in re.findall(r"font-size: (\d+(?:\.\d+)?)px", small)]
        self.assertGreaterEqual(min(sizes), 11.5)

    def test_unreadable_cells_note_is_worded_for_each_layout(self):
        page, script = self.sources["index.html"], self.sources["app.js"]
        self.assertIn('<p id="issues-help"></p>', page)
        self.assertNotIn("Fix these in Excel", page + script)
        # One wording, because every month that is shown can be edited.
        self.assertIn('const ISSUES_HELP = "Correct these in Excel and save, or replace the value with Edit on that row. "',
                      script)
        self.assertEqual(script.count("Correct these in Excel"), 1)

    def test_statuses_do_not_depend_on_colour(self):
        css, script = self.sources["styles.css"], self.sources["app.js"]
        # Each mark draws a shape of its own, whatever its colour.
        for name in ("completed", "missed", "partial", "rest", "unentered"):
            self.assertRegex(css, rf"\.mark\.{name}::after")
        # In the daily table a status is its mark followed by its word.
        self.assertIn('value === null ? "Not entered" : value,', script)
        self.assertIn('"aria-hidden": "true"', script)
        self.assertEqual(re.findall(r"emoji|\\u\{1F|&#x1F", " ".join(self.sources.values())), [])

    def test_the_name_is_centred_on_a_phone_and_where_it_was_from_a_tablet_up(self):
        css = self.sources["styles.css"]
        self.assertIn("text-align: center;", self.css_block("h1 {\n  font-size: 15px;"))
        self.assertRegex(self.css_block("@media (min-width: 600px) {"), r"\n  h1 \{\s*text-align: left;\s*\}")
        # Centred by the line it sits on, not pushed along: nothing else about the name changes.
        for word in ("margin", "padding", "position", "transform", "width"):
            self.assertNotIn(word, self.css_block("h1 {\n  font-size: 15px;"), word)
        self.assertIn("<h1>Raft</h1>", self.sources["index.html"])

    def test_every_dropdown_draws_the_same_dark_list(self):
        css, page = self.sources["styles.css"], self.sources["index.html"]
        # Every dropdown on the page, and they are all real selects of the page's own.
        self.assertEqual(re.findall(r'<select id="([a-z-]+)"', page), ["month-select", "new-month", "edit-exercise", "edit-junk-food"])
        for name in ("app.js", "editor.js", "analytics.js", "format.js"):
            self.assertNotIn('"select"', self.sources[name], name)              # no dropdown is made by a script
        self.assertNotIn("listbox", page + self.sources["app.js"] + self.sources["editor.js"])
        # Where the browser can, each draws its list itself, in Raft's colours, from one set of rules.
        self.assertRegex(css, r"\nselect,\nselect::picker\(select\) \{\s*appearance: base-select;\s*\}")
        self.assertEqual(css.count("appearance: base-select;"), 1)
        picker = self.css_block("select::picker(select) {\n  max-block-size")
        for needed in ("background: var(--raised);", "color: var(--text);", "border: 1px solid var(--glass-line);",
                       "border-radius: var(--r-control);", "overflow-y: auto;", "max-block-size: min(332px, 60dvh);"):
            self.assertIn(needed, picker, needed)
        self.assertIn("background: var(--accent-soft);", self.css_block("select option:checked {"))
        self.assertIn("color: var(--accent);", self.css_block("select option::checkmark {"))
        self.assertIn("background: var(--inset-strong);", self.css_block("select option:hover,"))
        self.assertIn("inset 0 0 0 1px var(--accent-muted)", self.css_block("select option:focus-visible {"))
        self.assertIn("outline-color: var(--accent);", self.css_block("select:focus-visible {\n  outline-color"))
        self.assertIn("border-color: var(--accent-muted);", self.css_block("select:active,"))
        self.assertRegex(css, r"@supports \(appearance: base-select\) \{\s*select option \{\s*min-height: 44px;")   # easy to tap
        # Closed, each looks as it did: its value centred on its line, and a small, quiet chevron.
        self.assertRegex(css, r"@supports \(appearance: base-select\) \{\s*select \{\s*align-items: center;")
        icon = self.css_block("select::picker-icon {")
        self.assertIn("color: var(--muted);", icon)
        self.assertIn("rotate: 45deg;", icon)
        # Only the month's own size differs: the selector is as large as a heading, its list is not.
        self.assertEqual(re.findall(r"#month-select(?:::picker\(select\)|:hover:not\(:disabled\))? \{", css)[:3],
                         ["#month-select {", "#month-select:hover:not(:disabled) {", "#month-select::picker(select) {"])
        self.assertNotIn("#month-select option", css)
        self.assertNotIn("#edit-exercise", css)
        self.assertNotIn("#edit-junk-food", css)
        # While a list is open, a tap outside only closes it, on the page and in an editor.
        self.assertRegex(css, r"body:has\(select:open\) \{\s*pointer-events: none;\s*\}")
        self.assertRegex(css, r"\nselect:open \{\s*pointer-events: auto;\s*\}")
        self.assertIn('<select id="month-select" disabled></select>', page)

    def test_past_days_in_the_habit_grid_only_look_quieter(self):
        css, source = self.sources["styles.css"], self.sources["analytics.js"]
        self.assertIn('hasToday && day.date < today ? "past" : ""', source)
        self.assertEqual(source.count('"past"'), 1)
        number, mark = self.css_block(".grid thead th.past {"), self.css_block(".grid td.past .mark {")
        self.assertIn("color: var(--muted);", number)
        self.assertIn("opacity: 0.7;", mark)
        # Only their look: nothing about their size, place, lines or use changes.
        for block in (number, mark):
            for word in ("width", "height", "padding", "margin", "border", "display", "pointer-events", "cursor"):
                self.assertNotIn(word, block, word)
        for script in ("app.js", "editor.js"):
            self.assertNotIn('"past"', self.sources[script], script)       # nothing else knows about it

    def test_the_page_is_dark_with_one_accent_and_text_that_can_be_read(self):
        css, page = self.sources["styles.css"], self.sources["index.html"]
        self.assertIn("color-scheme: dark;", self.css_block(":root {"))
        self.assertIn('<meta name="color-scheme" content="dark">', page)
        root = self.css_block(":root {")
        # The palette, exactly as chosen. Every other colour of the page is made from it.
        self.assertEqual(re.findall(r"--(background|surface|accent-neon|accent-muted|text-primary|text-secondary): (#[0-9A-Fa-f]{6});", root),
                         [("background", "#121212"), ("surface", "#1B1B1B"), ("accent-neon", "#FF5F1F"),
                          ("accent-muted", "#B34215"), ("text-primary", "#F5F5F7"), ("text-secondary", "#9E9E9E")])
        for token, source in (("page", "background"), ("text", "text-primary"), ("muted", "text-secondary"),
                              ("accent", "accent-neon"), ("half", "accent-muted")):
            self.assertIn(f"--{token}: var(--{source});", root, token)
        colours = {name: tuple(int(value[index:index + 2], 16) for index in (1, 3, 5))
                   for name, value in re.findall(r"--([a-z-]+): (#[0-9A-Fa-f]{6});", css)}
        for name, source in re.findall(r"--([a-z-]+): var\(--([a-z-]+)\);", root):
            if source in colours:
                colours[name] = colours[source]

        def luminance(colour):
            linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in (v / 255 for v in colour)]
            return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]

        def contrast(one, other):
            light, dark = sorted((luminance(colours[one]), luminance(colours[other])), reverse=True)
            return (light + 0.05) / (dark + 0.05)

        # Every surface is dark, and each step up from the page is a little lighter than the last.
        steps = [luminance(colours[name]) for name in ("page", "surface", "raised")]
        self.assertEqual(steps, sorted(steps))
        self.assertLess(steps[-1], 0.03)
        # Text can be read on every one of them: the main text easily, the quieter text well enough.
        for surface in ("page", "surface", "raised"):
            self.assertGreaterEqual(contrast("text", surface), 12, surface)
            for quiet in ("muted", "faint", "accent", "danger", "series"):
                self.assertGreaterEqual(contrast(quiet, surface), 4.5, f"{quiet} on {surface}")
        # The main button: dark writing on the accent, in both of its states. (No writing at all
        # reaches 7:1 on this orange; the darkest ink gives well over the 4.5 that text needs.)
        self.assertGreaterEqual(contrast("accent-ink", "accent"), 6)
        self.assertGreaterEqual(contrast("accent-ink", "accent-strong"), 7)
        # The one accent is a neon orange. Nothing on the page is blue or purple: every colour,
        # given as a token or as rgba() anywhere in the stylesheet, is a grey or a warm tone.
        red, green, blue = colours["accent"]
        self.assertTrue(red > 220 and red - blue > 150 and green > blue, colours["accent"])
        for name, (red, green, blue) in colours.items():
            self.assertLessEqual(blue, max(red, green) + 4, name)
        for red, green, blue in re.findall(r"rgba\((\d+), (\d+), (\d+),", css):
            self.assertLessEqual(int(blue), max(int(red), int(green)) + 4, (red, green, blue))
        self.assertIn('<meta name="theme-color" content="#121212">', page)
        # Partial is the muted shade of the accent, told apart from done by how light it is.
        self.assertGreaterEqual(contrast("accent", "half"), 1.5)
        # A filled mark and the piece of a bar that says the same are told apart from a missed one
        # by more than their colour: by how light they are, as well as by their shapes.
        self.assertGreaterEqual(contrast("accent", "missed"), 2.5)


if __name__ == "__main__":
    unittest.main()
