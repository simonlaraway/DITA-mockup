# Adding source file and line locations to the HTML

This document explains how a staging build tags each HTML element with the DITA file and line it
came from. For example:

```html
<li class="li step" data-src-file="file:/…/content/topics/animals/recording-intake.dita"
    data-src-pos="12:13">
```

The review widget depends on this. For how the widget uses the locations to post GitHub
comments, see [comment-mapping.md](comment-mapping.md).

There are two halves, and only the second is our code:

1. **DITA-OT records the locations.** While preprocessing, DITA-OT writes the file, line and
   column onto every element of its temporary copy of the content. It always does this; it's how
   it reports error locations.
2. **Our plugin copies them into the HTML.** `plugins/com.corgibase.sourcemap` adds one XSLT
   template to the HTML5 transform. It copies those values onto the HTML elements as `data-`
   attributes, and only when the build asks for it.

The source files in `content/` are never modified.

All file references below are to DITA-OT 4.4.1, which `build.sh` installs into
`tools/dita-ot-4.4.1/`.

```
content/*.dita
   │
   │  DITA-OT preprocess (org.dita.base/build_preprocess.xml)
   │    debug-filter  ← stamps @xtrf / @xtrc on every element          (DITA-OT, always)
   │    keyref, conref, profile, chunk, …  ← carry the attributes along
   ▼
temp/topics/animals/recording-intake.dita   (with xtrf/xtrc)
   │
   │  HTML5 transform (org.dita.html5)
   │    every element → call-template "commonattributes"
   │                  → apply-templates mode="commonattributes"
   │                       └── com.corgibase.sourcemap: next-match, then add
   │                           data-src-file / data-src-pos      (our plugin, only if corgi.sourcemap=yes)
   ▼
out/user/topics/animals/recording-intake.html
   │
   │  scripts/stage_diff.py  (staging only)
   ▼
data-src="content/topics/animals/recording-intake.dita:12:13"
```

---

## 1. How DITA-OT records locations during preprocessing

### Where it happens

Preprocessing is a chain of Ant targets, listed in
`plugins/org.dita.base/build_preprocess.xml:18`:

```
preprocess.init, ditaval-merge, gen-list, debug-filter, mapref, branch-filter, keyref,
copy-to, conrefpush, conref, profile, topic-fragment, chunk, …
```

`debug-filter` (`build_preprocess.xml:116`) runs the Java module
`org.dita.dost.module.DebugAndFilterModule`. It reads each source file through a SAX parser and
copies it into DITA-OT's temporary directory. On the way, one filter in the chain,
`org.dita.dost.writer.DebugFilter`, adds two attributes to every element. It gets the line and
column from the parser's `org.xml.sax.Locator`:

| Attribute | Value | Meaning |
|---|---|---|
| `xtrf` | `file:/…/content/topics/animals/recording-intake.dita` | The absolute URI of the file being parsed |
| `xtrc` | `step:2;12:13` | `elementName:count;line:column` |

The names are short for *trace file* and *trace count*. DITA-OT uses them in its own error
messages: `plugins/org.dita.base/xsl/common/output-message.xsl:45-55` reads `@xtrc` and prints
the part after the `;` as the location.

### What the temporary files look like

To see them, keep the temporary directory:

```bash
tools/dita-ot-4.4.1/bin/dita -i content/shelter-guide.ditamap -f html5 \
  --filter=filters/user.ditaval -o /tmp/out --temp=/tmp/dita-temp --clean.temp=no
```

Here is `/tmp/dita-temp/topics/animals/recording-intake.dita` after preprocessing (paths shortened):

```xml
<title class="- topic/title " xtrf="file:/…/recording-intake.dita" xtrc="title:1;4:10">Recording an animal intake</title>
…
<steps class="- topic/ol task/steps " xtrf="file:/…/recording-intake.dita" xtrc="steps:1;10:12">
  <step class="- topic/li task/step " xtrf="file:/…/content/shared/reuse.dita" xtrc="step:1;27:30">
    <cmd class="- topic/ph task/cmd " xtrf="file:/…/content/shared/reuse.dita" xtrc="cmd:1;28:14">Sign in to <ph … xtrc="ph:3;28:52">CorgiBase</ph> …
  </step>
  <step class="- topic/li task/step " xtrf="file:/…/recording-intake.dita" xtrc="step:2;12:13"><cmd … xtrc="cmd:2;12:18">Click …
```

The source it came from:

```xml
 4    <title>Recording an animal intake</title>
 ⋮
10      <steps>
11        <step conkeyref="reuse/step-signin"><cmd/></step>
12        <step><cmd>Click <menucascade><uicontrol>Animals</uicontrol><uicontrol>New
```

### Exactly what the line and column mean

**The position is the end of the start tag.** A SAX parser reports its position when it
finishes reading a start tag. `<title>` on line 4 spans columns 3–9, so the position is `4:10`,
the character just after the `>`. For a start tag on one line, that's the line the element
starts on. If a start tag spans several lines (long attribute lists), the line is the one where
the tag closes.

**The count numbers elements of that name in that file.** `step:2` is the second `<step>` the
parser met in `recording-intake.dita`. The first was the `conkeyref` placeholder on line 11. We
don't use the count; we keep only what comes after the `;`.

**Columns are 1-based** and count characters, so a tab is one column.

### What later preprocessing does to the attributes

The later preprocessing steps work on the temporary files, so the attributes are carried along
with the elements:

- **conref and conkeyref.** The referenced element replaces the placeholder, and it keeps its
  **own** `xtrf`/`xtrc`. `plugins/org.dita.base/xsl/preprocess/conrefImpl.xsl` deliberately
  drops the placeholder's copies (lines 103 and 473: `match="@xtrc | @xtrf"` with an empty
  template). That's why step 1 above points at `content/shared/reuse.dita:27:30`, the
  `<step id="step-signin">` in the reuse file, and not at line 11 of the topic.
- **keyref.** The element containing the reference keeps its own location. The resolved text
  "CorgiBase" sits inside a `<ph>` from the topic (or from `reuse.dita` above), not from
  `keys.ditamap`.
- **DITAVAL filtering.** Excluded elements are removed. The elements that remain keep their
  locations.
- **Map-generated content.** Related links built from the map's relationship tables and
  `collection-type` carry the **map's** location. On the intake page, three related links
  point at lines 43, 86 and 88 of `content/shelter-guide.ditamap`.
- **Text DITA-OT generates itself**, such as "Procedure" headings, labels and navigation
  wrappers, has no `xtrf`, because no source element produced it.

---

## 2. How the plugin copies the locations into the HTML

### The hook: `commonattributes`

In `org.dita.html5`, almost every template that writes an HTML element calls one named
template to add the standard attributes (`class`, `id`, `lang`, `dir` and flagging styles).
`plugins/org.dita.html5/xsl/topic.xsl` calls it about 60 times. The template is defined at
`topic.xsl:1834`:

```xml
<xsl:template name="commonattributes">
  <xsl:param name="default-output-class"/>
  <xsl:apply-templates select="." mode="commonattributes">
    <xsl:with-param name="default-output-class" select="tokenize(normalize-space($default-output-class), '\s+')"/>
  </xsl:apply-templates>
</xsl:template>

<xsl:template match="@* | node()" mode="commonattributes">   <!-- topic.xsl:1841, the default -->
  …
</xsl:template>
```

The named template calls `apply-templates` in mode `commonattributes`. So a plugin can add a
template in that mode and run on every HTML element DITA-OT writes, without copying or
overriding any of DITA-OT's element templates. The context node is the DITA element being
converted, so its `@xtrf`/`@xtrc` are available.

### The plugin files

```
plugins/com.corgibase.sourcemap/
├── plugin.xml
├── params.xml
└── xsl/sourcemap.xsl
```

**`plugin.xml`** registers two features with the HTML5 plugin's extension points, which are
declared in `plugins/org.dita.html5/plugin.xml:11-12`:

```xml
<plugin id="com.corgibase.sourcemap" version="1.0.0">
  <require plugin="org.dita.html5"/>
  <feature extension="dita.xsl.html5" file="xsl/sourcemap.xsl"/>
  <feature extension="dita.conductor.html5.param" file="params.xml"/>
</plugin>
```

- `dita.xsl.html5` adds our stylesheet as an `xsl:import` in the HTML5 transform.
- `dita.conductor.html5.param` passes an Ant property into that transform as an XSLT parameter.

**`params.xml`** passes `corgi.sourcemap`, but only when the property is set:

```xml
<params xmlns:if="ant:if">
  <param name="corgi.sourcemap" expression="${corgi.sourcemap}" if:set="corgi.sourcemap"/>
</params>
```

Without this file, `-Dcorgi.sourcemap=yes` would set an Ant property the XSLT never sees.

**`xsl/sourcemap.xsl`** contains the whole implementation:

```xml
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:xs="http://www.w3.org/2001/XMLSchema" exclude-result-prefixes="xs">

  <xsl:param name="corgi.sourcemap" as="xs:string" select="'no'"/>

  <xsl:template match="*[@xtrf]" mode="commonattributes" priority="20">
    <xsl:next-match/>
    <xsl:if test="$corgi.sourcemap = 'yes'">
      <xsl:attribute name="data-src-file" select="@xtrf"/>
      <xsl:if test="contains(@xtrc, ';')">
        <xsl:attribute name="data-src-pos" select="substring-after(@xtrc, ';')"/>
      </xsl:if>
    </xsl:if>
  </xsl:template>
</xsl:stylesheet>
```

Line by line:

- **`xsl:param … select="'no'"`** sets the default to off. Production builds don't pass the
  parameter, so their output is byte-for-byte what plain DITA-OT produces.
- **`match="*[@xtrf]"`** runs only for elements that have a recorded source. Generated content
  falls through to DITA-OT's default.
- **`mode="commonattributes"`** runs inside the attribute-writing step, while the HTML element's
  start tag is still open, so `xsl:attribute` is allowed.
- **`priority="20"`** makes sure this template wins over other templates in the same mode that
  have the same import precedence (see below).
- **`xsl:next-match`** runs the template that would otherwise have handled the element first,
  normally DITA-OT's default at `topic.xsl:1841`. That writes `class`, `id`, `lang`, the
  flagging attributes and so on. We add attributes afterwards and never replace any.
- **`data-src-file`** is `@xtrf` unchanged: an absolute `file:` URI.
- **`data-src-pos`** is the part of `@xtrc` after the `;` (`12:13`), which drops the element
  name and count. The `contains` guard skips the attribute if a value has no position.

### How it is wired in: integration

DITA-OT doesn't read plugin folders at build time. `dita install` (integration) rewrites
DITA-OT's generated files from every installed plugin's `plugin.xml`. After installation, two
generated files contain our additions.

`plugins/org.dita.html5/xsl/dita2html5Impl.xsl:35`, generated from
`dita2html5Impl_template.xsl:38` (`<dita:extension id="dita.xsl.html5" …ImportXSLAction/>`):

```xml
<xsl:import href="plugin:com.corgibase.sourcemap:xsl/sourcemap.xsl"/>
```

`plugins/org.dita.html5/build_dita2html5.xml:123` and `:135`, the two XSLT calls of the HTML5
transform:

```xml
<param name="corgi.sourcemap" expression="${corgi.sourcemap}" if:set="corgi.sourcemap"/>
```

**Import precedence.** The extension point sits *after* DITA-OT's own `xsl:import`s of
`topic.xsl` and the other stylesheets. In XSLT, a later import has higher precedence than an
earlier one. So our template is chosen before DITA-OT's, and `xsl:next-match` then falls back
to DITA-OT's. The `priority` attribute matters only if another plugin adds a template in the
same mode.

**Installation in `build.sh`.** Plugins in this repo's `plugins/` folder are installed
automatically, and reinstalled only when their contents change:

```bash
for plugin in "$ROOT"/plugins/*/; do
  name="$(basename "$plugin")"
  hash="$(cd "$plugin" && find . -type f -print0 | sort -z | xargs -0 shasum | shasum | cut -d' ' -f1)"
  stamp="$DITA_HOME/plugins/$name/.installed-hash"
  if [[ "$(cat "$stamp" 2>/dev/null)" != "$hash" ]]; then
    rm -rf "$DITA_HOME/plugins/$name"
    cp -R "$plugin" "$DITA_HOME/plugins/$name"
    "$DITA" install          # re-integrate everything in $DITA_HOME/plugins
    echo "$hash" > "$stamp"
  fi
done
```

The plugin is copied into DITA-OT's `plugins/` folder and integrated with a bare
`dita install`. `dita install <folder>` didn't work for a local folder in 4.4.1. The CI cache key
includes `plugins/**`, so a changed plugin also invalidates the cached DITA-OT.

### Turning it on

`build.sh` passes the parameter when `SOURCEMAP=1`:

```bash
args=(--project="$ROOT/project.xml" --output="$ROOT/out")
if [[ "${SOURCEMAP:-}" == "1" ]]; then
  args+=(-Dcorgi.sourcemap=yes)
fi
```

The staging workflow runs `SOURCEMAP=1 ./build.sh`. The production workflow runs plain
`./build.sh`. The PR's baseline build also runs without it, so removed content shown in a
preview never has a location.

---

## 3. The result

`out/user/topics/animals/recording-intake.html` with `SOURCEMAP=1` (paths shortened):

```html
<h1 class="title" data-src-file="file:/…/recording-intake.dita" data-src-pos="4:10" id="ariaid-title1">
<p class="shortdesc" data-src-file="file:/…/recording-intake.dita" data-src-pos="5:14">
<ol class="ol steps" data-src-file="file:/…/recording-intake.dita" data-src-pos="10:12">
<li class="li step" data-src-file="file:/…/content/shared/reuse.dita" data-src-pos="27:30">
<li class="li step" data-src-file="file:/…/recording-intake.dita" data-src-pos="12:13">
<span class="ph cmd" data-src-file="file:/…/recording-intake.dita" data-src-pos="12:18">
<span class="ph uicontrol" data-src-file="file:/…/recording-intake.dita" data-src-pos="12:78">
<table class="simpletable choicetable …" data-src-file="file:/…/recording-intake.dita" data-src-pos="15:22">
```

On this page, 54 elements get a location:

| Source | Elements |
|---|---|
| `content/topics/animals/recording-intake.dita` | 47 |
| `content/shared/reuse.dita` (conkeyref'd step) | 4 |
| `content/shelter-guide.ditamap` (related links) | 3 |

Elements that DITA-OT creates without calling `commonattributes`, such as page wrappers, the
TOC `<nav>` and `<head>` content, get no attributes. Elements whose content is generated get no
attributes either.

### Post-processing for staging

The absolute `file:` URIs belong to the machine that ran the build. `scripts/stage_diff.py`
(`relativize_sources`, run with `--repo-root .`) turns each pair of attributes into one
repo-relative attribute:

```html
<li class="li step" data-src="content/topics/animals/recording-intake.dita:12:13">
```

It drops attributes that point outside the repository, for example at DITA-OT's own resources.

---

## 4. Checking it yourself

```bash
# Build one deliverable with locations
SOURCEMAP=1 ./build.sh user

# Every location on a page, counted by source file
grep -o 'data-src-file="[^"]*"' out/user/topics/animals/recording-intake.html \
  | sed 's#.*/content/#content/#' | sort | uniq -c

# Compare an element with its source line
sed -n '12p' content/topics/animals/recording-intake.dita

# Production builds have none
./build.sh user && grep -c 'data-src' out/user/topics/animals/recording-intake.html   # 0
```

---

## 5. Notes for other setups

- **Other output formats.** The plugin hooks only `org.dita.html5`. The older XHTML transform
  has its own `commonattributes` mode in `org.dita.xhtml`, and PDF (`org.dita.pdf2`) has one
  too (`xsl/fo/topic.xsl:1605`). Each would need its own feature (`dita.xsl.xhtml`,
  `dita.xsl.xslfo`) and its own way to emit the data, since PDF has no `data-` attributes.
- **Custom HTML plugins.** If your company's HTML plugin overrides element templates and writes
  attributes without calling `commonattributes`, those elements get no location. Add the call,
  or match those elements directly.
- **Other DITA-OT versions.** `xtrf`/`xtrc` and the `commonattributes` mode have existed for
  many releases, but check `conrefImpl.xsl` and `topic.xsl` in your version before relying on
  the conref behavior or the call sites described here.
- **Keeping output clean.** Gate the attributes behind a parameter, as here, so published pages
  never expose build paths. To reduce size, match only block elements (`*[@xtrf][contains(@class,
  ' topic/p ') or …]`) instead of every element.
- **Content preprocessed before DITA-OT.** If scripts generate or rewrite `.dita` files before
  the build, `xtrf` points at the generated files. Map them back to their real sources in
  post-processing, or exclude them.
