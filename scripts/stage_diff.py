#!/usr/bin/env python3
"""Build a staging copy of the published site with changed content highlighted.

Compares two DITA-OT html5 outputs (base = what production shows, head = the PR)
page by page and block by block, and writes an annotated copy of the head output:

  * added blocks      -> class "diff-added"
  * changed blocks    -> class "diff-changed", with word-level <ins>/<del> inside
  * removed blocks    -> re-inserted from base with class "diff-removed"
  * added pages       -> whole page marked "diff-page-added"
  * removed pages     -> stub page (old content) marked "diff-page-removed"

It also writes changes.html (summary page) and changes.md (PR comment body).

Usage:
  stage_diff.py --base base/out --head out --dest staged --pr 12 \
      --site-url https://example.github.io/repo/pr-preview/pr-12/ \
      [--prod-url https://example.github.io/repo/] [--base-sha SHA] [--head-sha SHA]
"""
import argparse
import copy
import difflib
import html
import json
import posixpath
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlparse

import lxml.html

BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd", "tr", "pre",
              "figcaption", "caption", "blockquote", "div"}
SKIP_TAGS = {"script", "style"}
MARK_CLASSES = ("diff-added", "diff-changed", "diff-removed")
PAIR_THRESHOLD = 0.5
WORD_RE = re.compile(r"\w+(?:[.\-'’]\w+)*|[^\w\s]")  # keeps 3.2, built-in, don't whole
SKIP_FILES = {"build.log"}
THEME_DIR = Path(__file__).resolve().parent.parent / "theme"
DEFAULT_CSS = THEME_DIR / "staging.css"
WIDGET_JS, WIDGET_CSS = "review-widget.js", "review-widget.css"


# --------------------------------------------------------------------------- blocks

def is_block(el):
    return isinstance(el.tag, str) and el.tag in BLOCK_TAGS


def own_segments(block):
    """Text slots belonging to `block` itself, excluding nested blocks.

    Returns [(element, "text" | "tail")] in document order.
    """
    segs = []

    def walk(el):
        if el.text:
            segs.append((el, "text"))
        for child in el:
            if isinstance(child.tag, str) and child.tag not in SKIP_TAGS and not is_block(child):
                walk(child)
            if child.tail:
                segs.append((child, "tail"))

    walk(block)
    return segs


def seg_get(seg):
    el, attr = seg
    return getattr(el, attr) or ""


def own_text(block):
    # Join segments with a space: <br> and block-ish inline boundaries separate words.
    return " ".join(" ".join(seg_get(s) for s in own_segments(block)).split())


def content_root(doc):
    main = doc.find(".//main")
    return main if main is not None else doc.find(".//body")


def extract_blocks(doc):
    root = content_root(doc)
    if root is None:
        return []
    blocks = []
    for el in root.iter():
        if not is_block(el) or "staging-banner" in el.get("class", ""):
            continue
        text = own_text(el)
        if text:
            blocks.append((el, f"{el.tag}|{text}", text))
    return blocks


def add_class(el, cls):
    classes = el.get("class", "").split()
    if cls not in classes:
        el.set("class", " ".join(classes + [cls]))


def has_class(el, cls):
    return cls in el.get("class", "").split()


def mark(el, cls):
    """Add a diff class, lifting it to the whole note when el is a note's body."""
    parent = el.getparent()
    if has_class(el, "note__body") and parent is not None and has_class(parent, "note"):
        el = parent
    add_class(el, cls)


# ---------------------------------------------------------------------- word diff

def join_words(words):
    text = " ".join(words)
    text = re.sub(r" ([.,;:!?)\]])", r"\1", text)
    return re.sub(r"([(\[]) ", r"\1", text)


def tokens(block):
    """Words of a block's own text, tokenized per text segment (never across a boundary)."""
    return [m.group() for seg in own_segments(block) for m in WORD_RE.finditer(seg_get(seg))]


def word_diff(head_block, base_block):
    """Wrap inserted words in <ins> and add removed words as <del>, in place.

    Only touches the block's own text nodes, so inline markup (links, code,
    UI controls) is preserved.
    """
    segs = own_segments(head_block)
    if not segs:
        return
    strings = [seg_get(s) for s in segs]
    head_words = [(si, m.start(), m.end(), m.group())
                  for si, s in enumerate(strings) for m in WORD_RE.finditer(s)]
    base_words = tokens(base_block)
    sm = difflib.SequenceMatcher(None, base_words, [w[3] for w in head_words], autojunk=False)

    ins = {i: [] for i in range(len(segs))}   # seg -> [(start, end)]
    dels = {i: [] for i in range(len(segs))}  # seg -> [(offset, text)]
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("replace", "delete"):
            if j1 < len(head_words):
                si, off = head_words[j1][0], head_words[j1][1]
            elif head_words:
                si, off = head_words[-1][0], head_words[-1][2]
            else:
                si, off = len(segs) - 1, len(strings[-1])
            dels[si].append((off, join_words(base_words[i1:i2])))
        if tag in ("replace", "insert"):
            for si, start, end, _ in head_words[j1:j2]:
                if ins[si] and ins[si][-1][1] <= start and not strings[si][ins[si][-1][1]:start].strip():
                    ins[si][-1] = (ins[si][-1][0], end)  # merge adjacent words in one <ins>
                else:
                    ins[si].append((start, end))

    for si, seg in enumerate(segs):
        if not ins[si] and not dels[si]:
            continue
        s = strings[si]
        # events: (offset, order, kind, payload); deletions go before insertions at the same spot
        events = [(off, 0, "del", text) for off, text in dels[si]]
        events += [(start, 1, "ins", end) for start, end in ins[si]]
        events.sort(key=lambda e: (e[0], e[1]))
        pieces, pos = [], 0
        for off, _, kind, payload in events:
            if off > pos:
                pieces.append(("plain", s[pos:off]))
                pos = off
            if kind == "del":
                # Keep removed words readable: space them off from adjacent words,
                # but don't push a following comma/period away.
                if pos > 0 and not s[pos - 1].isspace() and payload[:1].isalnum():
                    pieces.append(("plain", " "))
                pieces.append(("del", payload))
                if pos < len(s) and s[pos].isalnum():
                    pieces.append(("plain", " "))
            else:
                pieces.append(("ins", s[off:payload]))
                pos = payload
        if pos < len(s):
            pieces.append(("plain", s[pos:]))
        apply_pieces(seg, pieces)


def apply_pieces(seg, pieces):
    el, attr = seg
    lead, new_elems = "", []
    for kind, text in pieces:
        if kind == "plain":
            if new_elems:
                new_elems[-1].tail = (new_elems[-1].tail or "") + text
            else:
                lead += text
        else:
            node = lxml.html.Element(kind)
            node.text = text
            new_elems.append(node)
    if attr == "text":
        el.text = lead
        for i, node in enumerate(new_elems):
            el.insert(i, node)
    else:
        el.tail = lead
        anchor = el
        for node in new_elems:
            anchor.addnext(node)
            anchor = node


# ---------------------------------------------------------------------- page diff

def strip_ids(el):
    for node in el.iter():
        if isinstance(node.tag, str):
            node.attrib.pop("id", None)


def map_ancestors(base_el, head_el, mapping, base_root, head_root):
    """Map containers of a matched block pair, walking up while tags agree."""
    b, h = base_el, head_el
    while b is not None and h is not None and b.tag == h.tag:
        mapping.setdefault(b, h)
        if b is base_root or h is head_root:
            break
        b, h = b.getparent(), h.getparent()


def place_removed(b, clone, mapping, base_root, head_root):
    """Insert `clone` (copy of base element b) at the matching spot in head."""
    sib = b.getprevious()
    while sib is not None:
        if sib in mapping:
            mapping[sib].addnext(clone)
            return
        sib = sib.getprevious()
    sib = b.getnext()
    while sib is not None:
        if sib in mapping:
            mapping[sib].addprevious(clone)
            return
        sib = sib.getnext()
    parent = b.getparent()
    while parent is not None:
        if parent in mapping:
            mapping[parent].insert(0, clone)
            return
        if parent is base_root:
            break
        parent = parent.getparent()
    head_root.append(clone)


def diff_page(base_doc, head_doc):
    """Annotate head_doc in place. Returns the number of changes marked."""
    base_root, head_root = content_root(base_doc), content_root(head_doc)
    base_blocks, head_blocks = extract_blocks(base_doc), extract_blocks(head_doc)
    sm = difflib.SequenceMatcher(None, [b[1] for b in base_blocks],
                                 [h[1] for h in head_blocks], autojunk=False)

    pairs, added, removed = [], [], []  # pairs: (base_idx, head_idx, changed)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            pairs += [(i1 + k, j1 + k, False) for k in range(i2 - i1)]
        elif tag == "insert":
            added += range(j1, j2)
        elif tag == "delete":
            removed += range(i1, i2)
        else:  # replace: pair similar blocks in order, the rest are added/removed
            i = i1
            for j in range(j1, j2):
                hit = None
                for k in range(i, i2):
                    if (base_blocks[k][0].tag == head_blocks[j][0].tag and
                            difflib.SequenceMatcher(None, base_blocks[k][2], head_blocks[j][2]).ratio()
                            >= PAIR_THRESHOLD):
                        hit = k
                        break
                if hit is None:
                    added.append(j)
                else:
                    removed += range(i, hit)
                    pairs.append((hit, j, True))
                    i = hit + 1
            removed += range(i, i2)

    mapping = {}
    for bi, hi, _ in pairs:
        map_ancestors(base_blocks[bi][0], head_blocks[hi][0], mapping, base_root, head_root)
    mapping.setdefault(base_root, head_root)

    for bi, hi, changed in pairs:
        if changed:
            el = head_blocks[hi][0]
            word_diff(el, base_blocks[bi][0])
            mark(el, "diff-changed")

    added_els = {head_blocks[j][0] for j in added}
    for el in added_els:
        if not any(a in added_els for a in el.iterancestors()):
            mark(el, "diff-added")

    removed_els = {base_blocks[i][0] for i in removed}
    for i in sorted(removed):
        b = base_blocks[i][0]
        if any(a in removed_els for a in b.iterancestors()):
            continue  # already inside a removed ancestor's copy
        clone = copy.deepcopy(b)
        # drop nested blocks that still exist in head (they are matched elsewhere)
        for orig, cl in list(zip(b.iter(), clone.iter())):
            if cl is not clone and is_block(orig) and own_text(orig) and orig not in removed_els:
                cl.getparent().remove(cl)
        strip_ids(clone)
        add_class(clone, "diff-removed")
        place_removed(b, clone, mapping, base_root, head_root)

    return number_changes(head_root)


def number_changes(root):
    def marked(el):
        return isinstance(el.tag, str) and any(has_class(el, c) for c in MARK_CLASSES)

    tops = [el for el in root.iter()
            if marked(el) and not any(marked(a) for a in el.iterancestors())]
    n = 0
    for el in tops:
        n += 1
        target = el
        if el.tag == "tr" and len(el):
            target = el[0]
        anchor = lxml.html.Element("span", {"class": "diff-anchor", "id": f"diff-{n}"})
        anchor.tail = target.text
        target.text = None
        target.insert(0, anchor)
    return n


# ---------------------------------------------------------------- page decoration

@dataclass
class Page:
    path: str            # relative to the site root, posix
    status: str          # added | removed | changed | unchanged
    changes: int = 0
    title: str = ""
    group: str = ""      # deliverable (first path segment) or "" for site root


@dataclass
class Context:
    pr: str
    site_url: str
    prod_url: str
    css: str
    pages: dict = field(default_factory=dict)
    repo_root: Path = None   # set when the head build has source maps (SOURCEMAP=1)
    review: dict = None      # review_config.py output; enables the comment widget
    widget_css: str = ""


def rel_link(from_path, to_path):
    return posixpath.relpath(to_path, posixpath.dirname(from_path) or ".")


def page_title(doc):
    t = doc.find(".//title")
    return " ".join((t.text_content() if t is not None else "").split())


def banner(page, ctx):
    status_text = {
        "added": "<strong>New page</strong> in this PR",
        "removed": "<strong>Removed</strong> in this PR (old content shown)",
        "changed": f"<strong>{page.changes} change{'s' if page.changes != 1 else ''}</strong> on this page",
        "unchanged": "No changes on this page",
    }[page.status]
    nav = ""
    if page.status == "changed":
        nav = ('<button type="button" data-diff-step="-1" title="Previous change (p)">&#9650;</button>'
               '<button type="button" data-diff-step="1" title="Next change (n)">&#9660;</button>')
    links = [f'<a href="{html.escape(rel_link(page.path, "changes.html"))}">All changes</a>']
    if ctx.prod_url and page.status != "added":
        links.append(f'<a href="{html.escape(ctx.prod_url + page.path)}">Production page</a>')
    markup = (f'<div class="staging-banner" role="note"><span class="staging-tag">Staging &middot; PR #{html.escape(ctx.pr)}</span>'
              f'<span>{status_text}</span>{nav}<span class="staging-links">{" &middot; ".join(links)}</span></div>')
    return lxml.html.fragment_fromstring(markup)


STEP_SCRIPT = """
(function () {
  var marks = document.querySelectorAll('.diff-anchor'), cur = -1;
  function go(step) {
    if (!marks.length) return;
    cur = (cur + step + marks.length) % marks.length;
    var el = marks[cur].parentElement;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    document.querySelectorAll('.diff-current').forEach(function (e) { e.classList.remove('diff-current'); });
    el.classList.add('diff-current');
  }
  document.querySelectorAll('[data-diff-step]').forEach(function (b) {
    b.addEventListener('click', function () { go(+b.getAttribute('data-diff-step')); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.closest && e.target.closest('input,textarea')) return;
    if (e.key === 'n') go(1); else if (e.key === 'p') go(-1);
  });
})();
"""


def relativize_sources(doc, repo_root):
    """Collapse data-src-file (file: URI) + data-src-pos ("line:col") from the sourcemap
    plugin into data-src="repo/relative/path.dita:line:col". Sources outside the repo
    (DITA-OT's own resources) are dropped."""
    root = Path(repo_root).resolve()
    for el in doc.iter():
        if not isinstance(el.tag, str) or "data-src-file" not in el.attrib:
            continue
        uri = el.attrib.pop("data-src-file")
        pos = el.attrib.pop("data-src-pos", "")
        path = Path(unquote(urlparse(uri).path)) if uri.startswith("file:") else Path(uri)
        try:
            rel = path.resolve().relative_to(root).as_posix()
        except ValueError:
            continue
        el.set("data-src", f"{rel}:{pos}" if pos else rel)


def review_config_script(doc, page, ctx):
    # The page's own topic file: from its title, else the most common source on the page.
    srcs = [el.get("data-src").split(":")[0] for el in doc.iter()
            if isinstance(el.tag, str) and el.get("data-src")]
    title = next((el for el in doc.iter("h1") if el.get("data-src")), None)
    topic_src = (title.get("data-src").split(":")[0] if title is not None
                 else max(set(srcs), key=srcs.count) if srcs else "")
    config = dict(ctx.review, page=page.path, page_title=page.title, page_status=page.status,
                  topic_src=topic_src)
    script = lxml.html.Element("script", {"type": "application/json", "id": "review-config"})
    script.text = json.dumps(config).replace("</", "<\\/")
    return script


def decorate(doc, page, ctx):
    if ctx.repo_root:
        relativize_sources(doc, ctx.repo_root)
    head = doc.find(".//head")
    if head is not None:
        style = lxml.html.Element("style")
        style.text = ctx.css + (ctx.widget_css if ctx.review else "")
        head.append(style)
    root = content_root(doc)
    if root is None:
        return
    root.insert(0, banner(page, ctx))
    if page.status in ("added", "removed"):
        add_class(root, f"diff-page-{page.status}")
    mark_toc(doc, page, ctx)
    body = doc.find(".//body")
    script = lxml.html.Element("script")
    script.text = STEP_SCRIPT
    body.append(script)
    if ctx.review:
        body.append(review_config_script(doc, page, ctx))
        body.append(lxml.html.Element("script", {"src": rel_link(page.path, WIDGET_JS)}))


def mark_toc(doc, page, ctx):
    for nav in doc.iter("nav"):
        cls = nav.get("class", "").split()
        if "toc" not in cls and nav.find("ul[@class='map']") is None:
            continue
        for a in nav.iter("a"):
            href = (a.get("href") or "").split("#")[0]
            if not href or "://" in href:
                continue
            target = posixpath.normpath(posixpath.join(posixpath.dirname(page.path), href))
            other = ctx.pages.get(target)
            if other and other.status in ("added", "changed"):
                li = a.getparent()
                add_class(li if li is not None and li.tag == "li" else a, f"diff-toc-{other.status}")


def write_doc(doc, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    out = lxml.html.tostring(doc, doctype="<!DOCTYPE html>", encoding="unicode", method="html")
    dest.write_text(out, encoding="utf-8")


def load(path):
    return lxml.html.document_fromstring(path.read_bytes())


# ------------------------------------------------------------------------ summary

STATUS_LABEL = {"added": "New page", "removed": "Removed page", "changed": "Changed"}


def group_name(group):
    return {"": "Site", "user": "User Guide", "admin": "Administrator Guide",
            "api": "API Guide"}.get(group, group)


def changed_pages(ctx):
    return [p for p in sorted(ctx.pages.values(), key=lambda p: (p.group, p.path))
            if p.status != "unchanged"]


def write_summary_html(ctx, dest, head_dir):
    rows_by_group = {}
    for p in changed_pages(ctx):
        rows_by_group.setdefault(p.group, []).append(p)
    css_link = ""
    for group in ("user", "admin"):
        if (head_dir / group / "css" / "custom.css").exists():
            css_link = f'<link rel="stylesheet" href="{group}/css/custom.css">'
            break
    parts = [f"<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">"
             f"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
             f"<title>Changes in PR #{html.escape(ctx.pr)}</title>{css_link}"
             f"<style>{ctx.css}</style></head><body class=\"staging-summary\"><main>"
             f"<div class=\"staging-banner\"><span class=\"staging-tag\">Staging &middot; PR #{html.escape(ctx.pr)}</span>"
             f"<span class=\"staging-links\"><a href=\"index.html\">Preview home</a></span></div>"
             f"<h1>Changes in PR #{html.escape(ctx.pr)}</h1>"]
    if not rows_by_group:
        parts.append("<p>No rendered content changes.</p>")
    for group, rows in rows_by_group.items():
        parts.append(f"<h2>{html.escape(group_name(group))}</h2><table><thead><tr>"
                     "<th>Page</th><th>Status</th><th>Changes</th></tr></thead><tbody>")
        for p in rows:
            count = str(p.changes) if p.status == "changed" else "&mdash;"
            parts.append(f'<tr class="summary-{p.status}"><td><a href="{html.escape(p.path)}">'
                         f'{html.escape(p.title or p.path)}</a><br><code>{html.escape(p.path)}</code></td>'
                         f'<td>{STATUS_LABEL[p.status]}</td><td>{count}</td></tr>')
        parts.append("</tbody></table>")
    parts.append("</main></body></html>")
    dest.write_text("".join(parts), encoding="utf-8")


def write_summary_md(ctx, dest, base_sha, head_sha):
    pages = changed_pages(ctx)
    lines = ["### Staging preview", "",
             f"**[Open preview]({ctx.site_url})** &middot; [All changes]({ctx.site_url}changes.html)", ""]
    if not pages:
        lines += ["No rendered content changes in this PR.", ""]
    else:
        total = sum(p.changes for p in pages if p.status == "changed")
        n_pages = len(pages)
        lines += [f"{n_pages} page{'s' if n_pages != 1 else ''} affected"
                  + (f", {total} highlighted change{'s' if total != 1 else ''}" if total else "") + ".", ""]
        groups = {}
        for p in pages:
            groups.setdefault(p.group, []).append(p)
        for group, rows in groups.items():
            lines += [f"**{group_name(group)}**", "", "| Page | Status | Changes |", "|---|---|---|"]
            for p in rows:
                title = (p.title or p.path).replace("|", "\\|")
                count = str(p.changes) if p.status == "changed" else "-"
                lines.append(f"| [{title}]({ctx.site_url}{p.path}) | {STATUS_LABEL[p.status]} | {count} |")
            lines.append("")
    meta = []
    if head_sha:
        meta.append(f"Built from `{head_sha[:7]}`")
    if base_sha:
        meta.append(f"compared with base `{base_sha[:7]}`")
    if meta:
        lines.append("<sub>" + ", ".join(meta) + ". GitHub Pages can take a minute to update.</sub>")
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- main

def build(base_dir, head_dir, dest_dir, ctx, base_sha="", head_sha=""):
    base_dir, head_dir, dest_dir = Path(base_dir), Path(head_dir), Path(dest_dir)
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True)

    def html_files(d):
        return {p.relative_to(d).as_posix() for p in d.rglob("*.html")} if d.exists() else set()

    base_pages, head_pages = html_files(base_dir), html_files(head_dir)

    # copy non-HTML assets from head
    for src in head_dir.rglob("*"):
        rel = src.relative_to(head_dir)
        if src.is_file() and src.suffix != ".html" and rel.as_posix() not in SKIP_FILES:
            (dest_dir / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest_dir / rel)

    # pass 1: diff every page so page statuses are known before TOCs are marked
    docs = {}
    for path in sorted(base_pages | head_pages):
        group = path.split("/")[0] if "/" in path else ""
        if path in head_pages and path in base_pages:
            doc = load(head_dir / path)
            n = diff_page(load(base_dir / path), doc)
            page = Page(path, "changed" if n else "unchanged", n, page_title(doc), group)
        elif path in head_pages:
            doc = load(head_dir / path)
            page = Page(path, "added", 0, page_title(doc), group)
        else:
            doc = load(base_dir / path)
            page = Page(path, "removed", 0, page_title(doc), group)
        ctx.pages[path] = page
        docs[path] = doc

    if ctx.review:
        shutil.copy2(THEME_DIR / WIDGET_JS, dest_dir / WIDGET_JS)

    # pass 2: banners, TOC markers, write out
    for path, doc in docs.items():
        decorate(doc, ctx.pages[path], ctx)
        write_doc(doc, dest_dir / path)

    write_summary_html(ctx, dest_dir / "changes.html", head_dir)
    write_summary_md(ctx, dest_dir / "changes.md", base_sha, head_sha)
    return ctx.pages


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="base (production) build output")
    ap.add_argument("--head", required=True, help="PR build output")
    ap.add_argument("--dest", required=True, help="where to write the staging site")
    ap.add_argument("--pr", required=True, help="pull request number")
    ap.add_argument("--site-url", required=True, help="public URL of the staging site, ending in /")
    ap.add_argument("--prod-url", default="", help="public URL of production, ending in /")
    ap.add_argument("--css", default=str(DEFAULT_CSS), help="staging stylesheet to inline")
    ap.add_argument("--base-sha", default="")
    ap.add_argument("--head-sha", default="")
    ap.add_argument("--repo-root", default="", help="repo checkout the head was built from "
                    "(turns sourcemap attributes into repo-relative data-src)")
    ap.add_argument("--review-config", default="", help="review_config.py output; adds the comment widget")
    args = ap.parse_args()

    ctx = Context(pr=args.pr, site_url=args.site_url, prod_url=args.prod_url,
                  css=Path(args.css).read_text(encoding="utf-8"),
                  repo_root=Path(args.repo_root) if args.repo_root else None)
    if args.review_config:
        ctx.review = json.loads(Path(args.review_config).read_text(encoding="utf-8"))
        ctx.widget_css = (THEME_DIR / WIDGET_CSS).read_text(encoding="utf-8")
    pages = build(args.base, args.head, args.dest, ctx, args.base_sha, args.head_sha)
    changed = [p for p in pages.values() if p.status != "unchanged"]
    print(f"{len(pages)} pages, {len(changed)} affected:")
    for p in changed:
        print(f"  {p.status:9} {p.changes:3}  {p.path}")


if __name__ == "__main__":
    main()
