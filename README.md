# DITA → HTML5 publishing pipeline (mockup)

A small, real DITA Open Toolkit pipeline that publishes documentation for **CorgiBase**, a
fictional cloud app and API for people who run dog shelters. It produces three HTML5
deliverables:

| Deliverable | Source map | Filtering |
|---|---|---|
| `out/user`: User Guide | `content/shelter-guide.ditamap` | `user.ditaval` removes `audience="admin"` |
| `out/admin`: Administrator Guide | `content/shelter-guide.ditamap` | `admin.ditaval` keeps admin content and flags it |
| `out/api`: API Guide | `content/api-guide.ditamap` | none |

```
./build.sh          # build all deliverables (downloads DITA-OT 4.4.1 into tools/ on first run)
./build.sh user     # build one deliverable: user | admin | api
open out/index.html
```

Requires Java 17+. Each build starts from a clean output folder. The build log is written to
`out/build.log`, and the script exits non-zero if DITA-OT reports any `[DOT…E]` or `[DOT…F]`
messages (DITA-OT itself can exit 0 on errors).

## Layout

| Path | Role |
|---|---|
| `project.xml` | DITA-OT project file: 3 contexts (map + optional DITAVAL), 1 shared `html5` publication, 3 deliverables |
| `content/shelter-guide.ditamap` | Shelter Guide: topic keys, navigation (`topichead` sections) and a `reltable` for related links |
| `content/api-guide.ditamap` | API Guide: topic keys and navigation |
| `content/keys.ditamap` | Shared keys: product name, release, API base URL, external links, reuse warehouse |
| `content/topics/<section>/*.dita` | 23 Shelter Guide topics (concept, task, reference) in `getting-started`, `animals`, `care`, `adoptions`, `volunteers`, `admin` and `help` |
| `content/api/*.dita` | 8 API Guide topics |
| `content/shared/reuse.dita` | Warehouse topic (resource-only) holding reusable notes, a paragraph and steps |
| `content/filters/*.ditaval` | `user`: exclude `audience=admin` · `admin`: keep it, flag it with `[Admin]` and a highlight |
| `theme/custom.css` | Styles layered on DITA-OT's `commonltr.css` |
| `theme/index.html` | Landing page linking the three guides |

## How the pipeline runs

DITA-OT runs every deliverable through **preprocessing** (`preprocess2`) and then the **html5
transform**. The stages this mockup exercises:

1. **Map resolution and key spaces.** Each guide's map pulls in the shared `keys.ditamap` with
   `<mapref>` and defines its own topic keys. Navigation uses `topicref keyref="…"`, so the TOC
   never hard-codes a file path. Cross-references like `<xref keyref="roles"/>` resolve to the
   topic and use its title.
2. **DITAVAL filtering** (`profile`). The context's DITAVAL is applied early, so excluded content
   is gone before reuse is resolved. Filtering works at every level:
   - **Section:** the whole *Administration* `topichead` (4 topics) is `audience="admin"`, so it
     doesn't appear in the User Guide at all.
   - **Block:** single steps (`publishing-listings.dita`), table rows (`roles-permissions.dita`)
     and sections (`about-corgibase.dita`) are admin-only.
   - In the Administrator Guide they're flagged with `add-outputclass="admin-only"`, a background
     color and an `[Admin]` label.
   - `@platform` (`web`, `ios android`) marks app-specific steps in `uploading-photos.dita`.
     Nothing filters on it yet. Add `<prop att="platform" val="web" action="exclude"/>` to a
     DITAVAL to try it.
3. **Conkeyref.** `<note conkeyref="reuse/note-pii"/>` and `<step conkeyref="reuse/step-open-animal">`
   pull shared notes and steps from the warehouse topic through the `reuse` key. Edit them once
   in `content/shared/reuse.dita` and every page that uses them updates.
4. **Keyref.** `<ph keyref="product-name"/>` becomes "CorgiBase" everywhere, even inside reused
   content and code blocks (the API base URL in `curl` examples is a key). External links such as
   `support-url` and `api-guide` are keys with link text.
5. **Related links.** The `reltable` in `shelter-guide.ditamap` links concepts, tasks and
   references, which DITA-OT renders as *Related concepts / tasks / reference*.
6. **HTML5 transform.** Each topic becomes an HTML page with a full-map TOC (`nav-toc=full`).
   `index.html` is generated from the map, and `custom.css` is copied to `css/` (`args.copycss`).

## Adding a deliverable

To publish a mobile-only volunteer guide, for example:

1. Create `content/filters/volunteer-mobile.ditaval` that excludes `audience=admin` and
   `platform=web`.
2. In `project.xml`, add a `<context>` that points at the map with that profile, and a
   `<deliverable>` with `<output href="volunteer-mobile"/>` and `<publication idref="html-base"/>`.
3. Add a card for it to `theme/index.html` and a name to `group_name()` in
   `scripts/stage_diff.py`.
4. `./build.sh volunteer-mobile`

Other output formats are just another `<publication transtype="…">` (for example `pdf`,
`markdown`, `xhtml`).

## Publishing (GitHub Pages)

GitHub Pages serves the `gh-pages` branch. Production is at the root and PR previews are under
`pr-preview/`.

- **Production:** `.github/workflows/publish.yml`. Every push to `main` runs `./build.sh` and
  deploys `out/` to the root of `gh-pages`: <https://simonlaraway.github.io/DITA-mockup/>. The
  landing page (`theme/index.html`) links to `user/`, `admin/` and `api/`. Deploys never touch
  `pr-preview/`.
- **Manual run:** Actions → *Publish to GitHub Pages* → *Run workflow*.

DITA-OT is cached between runs. Changing `DITA_OT_VERSION` in `build.sh` invalidates the cache.

## Staging previews (pull requests)

`.github/workflows/staging.yml` runs when a PR is opened, reopened or updated:

1. Builds the PR (the merge commit, i.e. what `main` would become).
2. Builds the PR's base commit with that commit's own `build.sh`, which gives the same output
   as production.
3. Runs `scripts/stage_diff.py`, which compares the two outputs page by page and writes an
   annotated copy:
   - Added blocks get a green bar.
   - Changed blocks get a blue bar, with word-level <ins>insertions</ins> and <del>deletions</del>.
   - Removed blocks are shown in place, in red strikethrough.
   - The TOC marks changed pages with a dot and new pages with "new".
   - Every page gets a staging banner with ▲/▼ buttons to jump between changes (keys `p` and `n`).
   - `changes.html` lists every affected page.
4. Deploys the result to <https://simonlaraway.github.io/DITA-mockup/pr-preview/pr-N/>.
5. Posts a comment on the PR with a table of the changed pages, and updates that same comment
   on each push.

Closing or merging the PR removes the preview.

Because the comparison uses the **rendered** HTML, indirect changes are highlighted too. Editing a
shared note in `shared/reuse.dita` highlights it on every page that reuses it. Changing a key
value (for example `product-version`) highlights every place it appears. Filtering is handled per
deliverable, so a change to admin-only content shows up only in the admin guide.

### Commenting from the staging preview

Every staged page has a review widget. Hover over a paragraph, step, table row or note and
click 💬 in the left margin, or select some text and click **Comment**. The panel shows the
exact DITA file and line the content came from, and the comment is posted to the PR under your
own GitHub name.

**Where a comment lands.** GitHub only allows inline comments on lines that are part of the PR's
diff, so the widget picks the best place it can:

| The content's source is… | The comment becomes… |
|---|---|
| a line the PR changed (or a nearby context line) | an inline review comment on that line of the `.dita` file |
| in a file the PR changed, but not near a change | a file-level review comment that cites the line |
| in a file the PR didn't change (e.g. reused text) | a PR conversation comment with a link to the line |

Content reused through conref or conkeyref maps to the file it's reused **from**, for example
`content/shared/reuse.dita`, and the panel warns that changing it affects every page that uses
it. Removed content (red strikethrough) has no source in the PR, so comments on it become
conversation comments.

**Existing comments.** Blocks that already have widget comments show a 💬 badge. Click it to
read the thread. If a comment's source line has since moved, it's counted in the banner instead.

**Connecting GitHub.** The first time you post, the widget asks for a fine-grained personal
access token. Create it at *GitHub → Settings → Developer settings → Fine-grained tokens* with
access to only this repository and the **Pull requests: Read and write** permission. The token
is stored only in your browser (`localStorage`) and is sent only to `api.github.com`. Use
*Sign out* in the panel to remove it.

**How the mapping works.**
1. `plugins/com.corgibase.sourcemap` is a DITA-OT plugin. When the build runs with
   `SOURCEMAP=1`, it copies DITA-OT's source tracking (`@xtrf` file, `@xtrc` line:column) onto
   every HTML element as `data-src-file` and `data-src-pos`. Production builds never set it.
2. `scripts/review_config.py` records which lines of each changed file are in the PR diff.
3. `scripts/stage_diff.py --repo-root . --review-config review.json` turns the attributes
   into repo-relative `data-src="content/…dita:line:col"` and injects the config and
   `theme/review-widget.js`.

The staging build uses the PR's head commit, so line numbers match what GitHub shows. The
baseline is the merge-base, the same comparison as GitHub's *Files changed* tab.

Run it locally:

```
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements.txt
git worktree add ../base main && ln -s "$PWD/tools" ../base/tools && (cd ../base && ./build.sh)
SOURCEMAP=1 ./build.sh   # build the head with source locations
.venv/bin/python scripts/review_config.py --base main --head HEAD --repo owner/repo --pr 0 \
    --preview-url "file://$PWD/staged/" --out review.json
.venv/bin/python scripts/stage_diff.py --base ../base/out --head out --dest staged \
    --pr 0 --site-url "file://$PWD/staged/" --repo-root . --review-config review.json
open staged/changes.html
```

Tests: `.venv/bin/python -m unittest discover -s scripts` and `node --test scripts/`

Limits:
- Moving a block shows as one removal plus one addition.
- PRs from forks get a read-only token, so they can't deploy or comment.
