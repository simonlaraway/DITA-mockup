"""Tests for stage_diff.py. Run: python3 -m unittest discover -s scripts"""
import sys
import tempfile
import unittest
from pathlib import Path

import lxml.html

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stage_diff  # noqa: E402

PAGE = """<!DOCTYPE html><html><head><title>{title}</title></head><body>
<nav class="toc"><ul><li><a href="a.html">A</a></li><li><a href="b.html">B</a></li></ul></nav>
<main><article><h1>{title}</h1>{body}</article></main></body></html>"""


def doc(body, title="T"):
    return lxml.html.document_fromstring(PAGE.format(title=title, body=body))


def diff(base_body, head_body):
    head = doc(head_body)
    n = stage_diff.diff_page(doc(base_body), head)
    return n, head


def classes(d, cls):
    return [" ".join(el.text_content().split())
            for el in d.iter() if isinstance(el.tag, str) and cls in el.get("class", "").split()]


class BlockDiffTests(unittest.TestCase):
    def test_identical_pages_have_no_changes(self):
        body = "<p>One.</p><ol><li>Step <b>one</b>.</li></ol>"
        n, head = diff(body, body)
        self.assertEqual(n, 0)
        self.assertEqual(head.find(".//ins"), None)

    def test_added_block(self):
        n, head = diff("<p>One.</p><p>Three.</p>", "<p>One.</p><p>Two.</p><p>Three.</p>")
        self.assertEqual(n, 1)
        self.assertEqual(classes(head, "diff-added"), ["Two."])

    def test_removed_block_is_reinserted_in_place(self):
        n, head = diff("<ol><li>One.</li><li>Two.</li><li>Three.</li></ol>",
                       "<ol><li>One.</li><li>Three.</li></ol>")
        self.assertEqual(n, 1)
        items = [" ".join(li.text_content().split()) for li in head.iter("li") if li.getparent().tag == "ol"]
        self.assertEqual(items, ["One.", "Two.", "Three."])
        self.assertEqual(classes(head, "diff-removed"), ["Two."])

    def test_changed_block_has_word_diff_and_keeps_markup(self):
        n, head = diff('<p>Click <b class="ui">Save</b> to keep the theme.</p>',
                       '<p>Click <b class="ui">Save</b> to keep the new theme and font.</p>')
        self.assertEqual(n, 1)
        p = head.find(".//main//p")
        self.assertIn("diff-changed", p.get("class"))
        self.assertIsNotNone(p.find("b[@class='ui']"))  # inline markup preserved
        self.assertEqual([i.text for i in p.iter("ins")], ["new", "and font"])
        self.assertEqual(p.find(".//del"), None)

    def test_changed_block_shows_deleted_words(self):
        n, head = diff("<p>Restart the old service now.</p>", "<p>Restart the service now.</p>")
        p = head.find(".//main//p")
        self.assertEqual([d.text for d in p.iter("del")], ["old"])
        self.assertEqual(" ".join(p.text_content().split()), "Restart the old service now.")

    def test_changed_text_inside_inline_element(self):
        n, head = diff('<p>Version <span class="ph">3.2</span> is out.</p>',
                       '<p>Version <span class="ph">3.3</span> is out.</p>')
        self.assertEqual(n, 1)
        span = head.find(".//span[@class='ph']")
        self.assertEqual(span.find("ins").text, "3.3")
        self.assertEqual(span.find("del").text, "3.2")

    def test_br_separates_words(self):
        n, head = diff('<p><b>Settings</b><br>All properties for 3.2.</p>',
                       '<p><b>Settings</b><br>All properties for 3.3.</p>')
        p = head.find(".//main//p")
        self.assertEqual([i.text for i in p.iter("ins")], ["3.3"])
        self.assertEqual([d.text for d in p.iter("del")], ["3.2"])

    def test_unrelated_replacement_is_added_plus_removed(self):
        n, head = diff("<p>Alpha beta gamma.</p>", "<p>Completely different words here.</p>")
        self.assertEqual(n, 2)
        self.assertEqual(classes(head, "diff-added"), ["Completely different words here."])
        self.assertEqual(classes(head, "diff-removed"), ["Alpha beta gamma."])

    def test_table_row_change(self):
        row = "<tr><td>theme</td><td>{}</td></tr>"
        n, head = diff(f"<table>{row.format('system')}{row.format('x')}</table>",
                       f"<table>{row.format('dark')}{row.format('x')}</table>")
        self.assertEqual(n, 1)
        tr = head.find(".//tr")
        self.assertIn("diff-changed", tr.get("class"))
        self.assertEqual(tr[0][0].get("id"), "diff-1")  # anchor goes inside the first cell

    def test_nested_step_info_removed_inside_step(self):
        base = "<ol><li>Run it.<p>Extra info.</p></li><li>Done.</li></ol>"
        head_ = "<ol><li>Run it.</li><li>Done.</li></ol>"
        n, head = diff(base, head_)
        self.assertEqual(n, 1)
        removed = [el for el in head.iter("p") if "diff-removed" in el.get("class", "")]
        self.assertEqual(len(removed), 1)
        self.assertEqual(removed[0].getparent().tag, "li")  # stays inside its step

    def test_anchors_are_numbered_in_order(self):
        n, head = diff("<p>A.</p><p>B.</p>", "<p>Z.</p><p>A.</p><p>B.</p><p>C.</p>")
        self.assertEqual(n, 2)
        ids = [el.get("id") for el in head.iter("span") if el.get("class") == "diff-anchor"]
        self.assertEqual(ids, ["diff-1", "diff-2"])


class SiteTests(unittest.TestCase):
    def test_build_marks_pages_toc_and_writes_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            base, head, dest = tmp / "base", tmp / "head", tmp / "dest"
            for d in (base / "user", head / "user"):
                d.mkdir(parents=True)
            (base / "user/a.html").write_text(PAGE.format(title="A", body="<p>Same.</p>"))
            (head / "user/a.html").write_text(PAGE.format(title="A", body="<p>Same.</p>"))
            (base / "user/b.html").write_text(PAGE.format(title="B", body="<p>Old text here.</p>"))
            (head / "user/b.html").write_text(PAGE.format(title="B", body="<p>New text here.</p>"))
            (head / "user/c.html").write_text(PAGE.format(title="C", body="<p>Brand new.</p>"))
            (base / "user/gone.html").write_text(PAGE.format(title="Gone", body="<p>Bye.</p>"))
            (head / "build.log").write_text("log")

            ctx = stage_diff.Context(pr="7", site_url="https://x/pr-7/", prod_url="https://x/", css="")
            pages = stage_diff.build(base, head, dest, ctx, "a" * 40, "b" * 40)

            self.assertEqual({p: pages[p].status for p in pages}, {
                "user/a.html": "unchanged", "user/b.html": "changed",
                "user/c.html": "added", "user/gone.html": "removed"})
            self.assertFalse((dest / "build.log").exists())
            self.assertTrue((dest / "user/gone.html").exists())

            a = lxml.html.document_fromstring((dest / "user/a.html").read_bytes())
            toc = {li.find("a").get("href"): li.get("class") for li in a.iter("li")}
            self.assertEqual(toc["b.html"], "diff-toc-changed")
            self.assertIsNone(toc["a.html"])
            self.assertIn("No changes on this page", a.find(".//div[@class='staging-banner']").text_content())

            md = (dest / "changes.md").read_text()
            self.assertIn("[B](https://x/pr-7/user/b.html) | Changed | 1", md)
            self.assertIn("| New page |", md)
            self.assertIn("| Removed page |", md)
            self.assertIn("`bbbbbbb`", md)
            self.assertTrue((dest / "changes.html").exists())

    def test_no_changes_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            for d in ("base", "head"):
                (tmp / d).mkdir()
                (tmp / d / "a.html").write_text(PAGE.format(title="A", body="<p>Same.</p>"))
            ctx = stage_diff.Context(pr="1", site_url="https://x/", prod_url="", css="")
            stage_diff.build(tmp / "base", tmp / "head", tmp / "dest", ctx)
            self.assertIn("No rendered content changes", (tmp / "dest/changes.md").read_text())


if __name__ == "__main__":
    unittest.main()
