"""Tests for review_config.py. Run: python3 -m unittest discover -s scripts"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from review_config import parse_diff  # noqa: E402

DIFF = """\
diff --git a/content/topics/a.dita b/content/topics/a.dita
index 1111111..2222222 100644
--- a/content/topics/a.dita
+++ b/content/topics/a.dita
@@ -10,7 +10,8 @@ some context
 line
-old
+new
+added
 line
@@ -40,3 +41,3 @@
 x
-y
+z
diff --git a/content/topics/new.dita b/content/topics/new.dita
new file mode 100644
--- /dev/null
+++ b/content/topics/new.dita
@@ -0,0 +1,5 @@
+<a/>
diff --git a/content/topics/gone.dita b/content/topics/gone.dita
deleted file mode 100644
--- a/content/topics/gone.dita
+++ /dev/null
@@ -1,4 +0,0 @@
-<a/>
diff --git a/content/topics/b.dita b/content/topics/b.dita
--- a/content/topics/b.dita
+++ b/content/topics/b.dita
@@ -5,2 +5 @@
-one
-two
+three
@@ -20,1 +19,0 @@
-pure deletion
"""


class ParseDiffTests(unittest.TestCase):
    def setUp(self):
        self.files = parse_diff(DIFF)

    def test_multiple_hunks(self):
        self.assertEqual(self.files["content/topics/a.dita"], [[10, 17], [41, 43]])

    def test_new_file_covers_all_lines(self):
        self.assertEqual(self.files["content/topics/new.dita"], [[1, 5]])

    def test_deleted_file_is_absent(self):
        self.assertNotIn("content/topics/gone.dita", self.files)

    def test_single_line_hunk_and_pure_deletion(self):
        # "+5" means one line; "+19,0" shows no head lines, so nothing is commentable there
        self.assertEqual(self.files["content/topics/b.dita"], [[5, 5]])


if __name__ == "__main__":
    unittest.main()
