#!/usr/bin/env python3
"""Write the staging review widget's config: which source lines a PR can take inline comments on.

GitHub only accepts line comments on lines that appear in the PR diff (changed lines plus
context lines inside each hunk). This records, for every changed file, the right-side (head)
line ranges covered by hunks, so the widget can decide between an inline comment, a
file-level comment and a PR conversation comment.

Usage:
  review_config.py --base MERGE_BASE_SHA --head HEAD_SHA --repo owner/name --pr 12 \
      --preview-url https://owner.github.io/repo/pr-preview/pr-12/ --out review.json
"""
import argparse
import json
import re
import subprocess

HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def parse_diff(diff_text):
    """Return {path: [[start, end], ...]} of head-side line ranges shown in the diff."""
    files, path = {}, None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            path = None if target == "/dev/null" else re.sub(r"^b/", "", target)
            if path:
                files.setdefault(path, [])
        elif line.startswith("@@") and path:
            m = HUNK_RE.match(line)
            if m:
                start, count = int(m.group(1)), int(m.group(2) or 1)
                if count:
                    files[path].append([start, start + count - 1])
    return {p: ranges for p, ranges in files.items()}


def git_diff(base, head, pathspec):
    return subprocess.run(["git", "diff", "--unified=3", "--no-color", "--no-renames",
                           base, head, "--", *pathspec],
                          check=True, capture_output=True, text=True).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="merge-base commit")
    ap.add_argument("--head", required=True, help="PR head commit")
    ap.add_argument("--repo", required=True, help="owner/name")
    ap.add_argument("--pr", required=True, type=int)
    ap.add_argument("--preview-url", required=True)
    ap.add_argument("--path", action="append", default=None, help="pathspec(s) to diff (default: content/)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    files = parse_diff(git_diff(args.base, args.head, args.path or ["content/"]))
    config = {"repo": args.repo, "pr": args.pr, "head_sha": args.head,
              "preview_url": args.preview_url, "files": files}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=1)
    print(f"{len(files)} changed source file(s) with commentable ranges")


if __name__ == "__main__":
    main()
