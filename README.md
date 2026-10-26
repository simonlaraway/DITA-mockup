# DITA → HTML5 publishing pipeline (mockup)

A small, real DITA Open Toolkit pipeline. It publishes one source map as two filtered HTML5
deliverables: an **end-user guide** and an **administrator guide**.

```
./build.sh          # build both deliverables (downloads DITA-OT 4.4.1 into tools/ on first run)
./build.sh user     # build one deliverable: user | admin
open out/user/index.html
```

Requires Java 17+. The build log is written to `out/build.log`, and the script exits non-zero if
DITA-OT reports any `[DOT…E]` or `[DOT…F]` messages (DITA-OT itself can exit 0 on errors).

## Layout

| Path | Role |
|---|---|
| `project.xml` | DITA-OT project file: 2 contexts (map + DITAVAL), 1 shared `html5` publication, 2 deliverables |
| `content/widget-guide.ditamap` | Root map: title, `mapref` to keys, nested TOC of `topicref keyref=…` |
| `content/keys.ditamap` | Key definitions: text variables, external link, topic keys, reuse warehouse |
| `content/topics/*.dita` | Concept, task, reference and troubleshooting topics |
| `content/shared/reuse.dita` | Warehouse topic (resource-only) holding reusable notes, a paragraph and a step |
| `content/filters/*.ditaval` | `user`: exclude `audience=admin` · `admin`: keep it, flag it with `[Admin]` and a highlight |
| `theme/custom.css` | Styles layered on DITA-OT's `commonltr.css` |

## How the pipeline runs

DITA-OT runs every deliverable through **preprocessing** (`preprocess2`) and then the **html5
transform**. The stages this mockup exercises:

1. **Map resolution and key spaces.** The root map's `<mapref>` pulls in `keys.ditamap`, and
   DITA-OT builds the key space. `topicref keyref="install"` resolves to `topics/install.dita`, so
   the TOC never hard-codes a file path.
2. **DITAVAL filtering** (`profile`). The context's DITAVAL is applied early, so excluded content
   is gone before reuse is resolved. Filtering rules:
   - `audience="admin"` steps, paragraphs and property rows are removed from `out/user` and
     flagged in `out/admin` (`add-outputclass="admin-only"` + background color + `[Admin]` start flag).
   - Nothing filters on `@platform` yet, so the macOS, Windows and Linux install steps all
     appear. Add `<prop att="platform" val="windows" action="exclude"/>` to try it.
3. **Conref and conkeyref.** `<note conref="../shared/reuse.dita#reuse/warn-power"/>` copies the
   warning by path. `<step conkeyref="reuse/step-restart">` copies the step through the `reuse`
   key, so the warehouse file can move without breaking references.
4. **Keyref.** `<ph keyref="product-name"/>` becomes "Acme Widget" (even inside reused content).
   `<xref keyref="support-url"/>` becomes an external link with the key's link text, and
   `<xref keyref="settings"/>` becomes a cross-reference to that topic, using its title.
5. **HTML5 transform.** Each topic becomes `topics/*.html` with a full-map TOC (`nav-toc=full`).
   `index.html` is generated from the map, and `custom.css` is copied to `css/` (`args.copycss`).

## Adding a deliverable

To publish a Windows-only user guide, for example:

1. Create `content/filters/user-windows.ditaval` that excludes `audience=admin` plus
   `platform=mac` and `platform=linux`.
2. In `project.xml`, add a `<context>` that points at the map with that profile, and a
   `<deliverable>` with `<output href="user-windows"/>` and `<publication idref="html-base"/>`.
3. `./build.sh user-windows`

Other output formats are just another `<publication transtype="…">` (for example `pdf`,
`markdown`, `xhtml`).

## Publishing (GitHub Pages)

`.github/workflows/publish.yml` runs `./build.sh` on GitHub Actions:

- **Push to `main`** builds both guides and deploys `out/` to
  <https://simonlaraway.github.io/DITA-mockup/>. The landing page (`theme/index.html`) links to
  `user/` and `admin/`.
- **Pull requests** only build. A DITA error fails the check, so broken content can't be merged
  without anyone noticing.
- **Manual run:** Actions → *Publish to GitHub Pages* → *Run workflow*.

DITA-OT is cached between runs. Changing `DITA_OT_VERSION` in `build.sh` invalidates the cache.
