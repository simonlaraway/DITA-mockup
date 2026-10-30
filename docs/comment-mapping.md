# How review comments find their DITA source line

When you click 💬 on a step in a staging preview, the widget posts an inline comment on, say,
line 12 of `content/topics/animals/recording-intake.dita`. This page explains how it gets from
a block of HTML to that file, line and kind of comment.

The short version: **the line number is baked into the HTML at build time.** DITA-OT already
knows which file and line every element came from. A small plugin writes that onto each HTML
element, and the widget reads it back and sends it to GitHub. Nothing is guessed or matched by
text.

```
 recording-intake.dita ──DITA-OT preprocess──► @xtrf / @xtrc on every element
                                                     │  (sourcemap plugin)
                                                     ▼
                         HTML: data-src-file="file:/…/recording-intake.dita" data-src-pos="12:13"
                                                     │  (stage_diff.py)
                                                     ▼
                         HTML: data-src="content/topics/animals/recording-intake.dita:12:13"
                                                     │  (review-widget.js + review.json)
                                                     ▼
                         POST /pulls/N/comments {path, line: 12, side: RIGHT, commit_id: <head>}
```

## 1. DITA-OT records where every element came from

While DITA-OT preprocesses a map, its XML parser stamps two attributes onto every element:

| Attribute | Example | Meaning |
|---|---|---|
| `@xtrf` | `file:/…/content/topics/animals/recording-intake.dita` | the file the element was parsed from |
| `@xtrc` | `step:2;12:13` | the element's name and count, then `line:column` |

DITA-OT uses these for its own error messages ("… at recording-intake.dita line 12"). We reuse
them.

The line and column come from the XML parser's position at the **end of the element's start
tag**, just after its `>`. For a start tag on one line, that is the line the element starts on.
In this source:

```xml
 4    <title>Recording an animal intake</title>
 ⋮
12      <step><cmd>Click <menucascade><uicontrol>Animals</uicontrol><uicontrol>New
13            intake</uicontrol></menucascade>.</cmd></step>
```

`<title>` gets `4:10`, and the `<step>` gets `12:13`: line 12, column 13, the character after
`<step>`. If a start tag wraps over several lines (long attribute lists), the line is the one
where it ends.

### Reused content keeps its original location

When DITA-OT resolves a `conref` or `conkeyref`, it copies the referenced element in and keeps
**that element's** `@xtrf`/`@xtrc`, not those of the element that referenced it. In
`recording-intake.dita`, step 1 is:

```xml
11      <step conkeyref="reuse/step-signin"><cmd/></step>
```

In the HTML, that step maps to `content/shared/reuse.dita:27:30`, the `<step id="step-signin">`
in the reuse file. That's where a fix has to be made, so it's where the comment should go. The
widget notices that the source isn't the page's own topic and warns that changing it affects
every page that reuses it.

Key references work differently: `<ph keyref="product-name"/>` maps to the topic line containing
the `<ph>`, not to `keys.ditamap`.

## 2. The sourcemap plugin writes the location into the HTML

[sourcemap-plugin.md](sourcemap-plugin.md) covers this step in full detail.

`plugins/com.corgibase.sourcemap` is a DITA-OT plugin. DITA-OT's HTML5 transform applies a
template mode called `commonattributes` to almost every element it outputs. That's where it
writes `class`, `id` and similar attributes. The plugin adds one template to that mode
(`xsl/sourcemap.xsl`):

```xml
<xsl:template match="*[@xtrf]" mode="commonattributes" priority="20">
  <xsl:next-match/>                      <!-- DITA-OT's normal attributes first -->
  <xsl:if test="$corgi.sourcemap = 'yes'">
    <xsl:attribute name="data-src-file" select="@xtrf"/>
    <xsl:attribute name="data-src-pos" select="substring-after(@xtrc, ';')"/>
  </xsl:if>
</xsl:template>
```

The result for that step:

```html
<li class="li step" data-src-file="file:/…/content/topics/animals/recording-intake.dita"
    data-src-pos="12:13">
```

`corgi.sourcemap` is off by default. Only `SOURCEMAP=1 ./build.sh`, which the staging workflow
uses, turns it on, so production HTML has no source attributes.

## 3. The staging script makes the paths repo-relative

`scripts/stage_diff.py --repo-root .` rewrites each pair of attributes into one
(`relativize_sources`):

```html
<li class="li step" data-src="content/topics/animals/recording-intake.dita:12:13">
```

The absolute `file:` URI belongs to the CI runner, so it's made relative to the repository
root, which gives the same path GitHub uses. Elements whose source is outside the repo, such as
text DITA-OT generates itself, lose their attributes and can't be commented on directly.

## 4. The workflow builds the exact commit GitHub comments on

GitHub positions an inline comment by `commit_id` + `path` + `line`, and the line numbers must
be the ones in that commit. So `.github/workflows/staging.yml` builds the **PR's head commit**,
not the merge commit GitHub creates for the PR. If `main` had also changed a file, the merge
commit's line numbers could differ from the ones the PR shows.

The highlighting baseline is the **merge-base** of the PR and `main`. That's the same comparison
as GitHub's *Files changed* tab, so the highlighted blocks match the diff reviewers see there.

## 5. `review.json` says which lines GitHub will accept

GitHub accepts inline comments only on lines that appear in the PR diff: changed lines plus the
context lines around them in each hunk. A comment on any other line is rejected with
`422 Unprocessable Entity`.

`scripts/review_config.py` runs `git diff --unified=3 <merge-base> <head> -- content/` and reads
each hunk header. For example, `@@ -10,4 +10,6 @@` means head lines 10–15 are shown. The script
writes the ranges, together with the PR number and head SHA, into `review.json`:

```json
{
  "repo": "simonlaraway/DITA-mockup",
  "pr": 12,
  "head_sha": "3f2c…",
  "preview_url": "https://simonlaraway.github.io/DITA-mockup/pr-preview/pr-12/",
  "files": {
    "content/topics/animals/recording-intake.dita": [[9, 18]]
  }
}
```

`stage_diff.py --review-config review.json` embeds this in every staged page as
`<script type="application/json" id="review-config">`, together with the page's path, title and
its own topic file.

## 6. The widget picks the comment type and posts it

When you hover or select text, `theme/review-widget.js` finds the nearest ancestor element with
`data-src`. Hovering the words "New intake" finds the `<span class="ph uicontrol">`
(`…:12:78`). Hovering elsewhere in the step finds the step's `<li>` (`…:12:13`). Both are on
line 12.

`placement()` then splits `data-src` into path, line and column, and checks it against
`review.json`:

| Check | Comment type | Request |
|---|---|---|
| The path is in `files` and the line is inside a range | inline review comment | `POST /repos/{repo}/pulls/{pr}/comments` with `{commit_id: head_sha, path, line, side: "RIGHT"}` |
| The path is in `files`, but the line isn't in a range | file-level review comment, citing the line | the same endpoint with `subject_type: "file"` |
| The path isn't in the PR, or there's no source (removed content) | PR conversation comment, linking to `blob/<head_sha>/<path>#L<line>` | `POST /repos/{repo}/issues/{pr}/comments` |

`side: "RIGHT"` means the new (head) side of the diff, which is the side the preview shows.

The panel shows which type it chose before you post ("Inline review comment on line 12 of …").
If GitHub still answers `422`, for example because the PR got a new commit since the preview was
built, the widget falls back one row in the table and tries again.

## 7. Finding comments again on reload

Every comment the widget posts ends with a hidden HTML comment:

```html
<!-- staging-review {"page":"user/topics/animals/recording-intake.html","src":"content/topics/animals/recording-intake.dita:12:13"} -->
```

On page load, the widget fetches the PR's review comments and conversation comments. It keeps
those whose marker names the current page, and puts the 💬 badge on the element whose `data-src`
is exactly that `src`. GitHub-native replies are attached to their thread through
`in_reply_to_id`. Widget replies to conversation comments also carry `"reply_to"` in their
marker. Only a marker at the very end of a comment counts, so quoting someone else's comment
can't pin text to a different block.

## Limits

- **Line numbers are per commit.** If a later push shifts the block (for example, a paragraph
  is inserted above it), the new preview's `data-src` no longer matches the marker. The thread
  is then listed in the banner as "on moved content" instead of on the block. On GitHub itself,
  the inline comment follows its line or is marked *Outdated*, as usual.
- **Granularity is one line.** Several short elements on one source line all map to that line.
  A multi-line paragraph maps to its first line, and the quoted text in the comment shows what
  was meant.
- **Removed content** (red strikethrough) comes from the baseline build, which has no source
  attributes and isn't in the head commit, so comments on it are always conversation comments.
- **Content outside `content/`** isn't diffed by `review_config.py`, so it never gets inline
  comments.
