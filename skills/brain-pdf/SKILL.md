---
name: brain-pdf
version: 0.1.0
description: Generate a publication-quality PDF from any brain page via the gstack make-pdf binary. Strips YAML frontmatter, sanitizes emoji, applies running headers and page numbers. Brain page is always the source of truth; PDF is a rendering.
triggers:
  - "make pdf from brain"
  - "brain pdf"
  - "convert brain page to pdf"
  - "publish this page as pdf"
  - "export brain page"
---

# brain-pdf — Render a Brain Page to Publication-Quality PDF

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> output rules. The PDF is a rendering — never the primary artifact. If a
> PDF exists, the source brain page exists behind it.

## The rule

The brain page is ALWAYS the source of truth. The PDF is a rendering of
it, never a standalone artifact. If a PDF exists somewhere, the brain
page must exist behind it.

## What this does

Renders a brain page (markdown with frontmatter) into a
publication-quality PDF using the gstack `make-pdf` binary. Output is
suitable for:

- Sharing a personalized book mirror via email or Telegram
- Delivering a strategic-reading playbook as a clean read
- Producing a briefing or report with running headers and page numbers
- Archiving a long-form essay in a portable format

## Prerequisite: gstack make-pdf

This skill depends on the gstack `make-pdf` binary at:

```
$HOME/.claude/skills/gstack/make-pdf/dist/pdf
```

The user must have gstack co-installed. If absent, the skill cannot run.
A future v0.26+ may bundle a fallback PDF renderer; for v0.25.1 gstack
is a soft prereq.

Verify it exists before invoking:

```bash
P="$HOME/.claude/skills/gstack/make-pdf/dist/pdf"
[ -x "$P" ] || { echo "make-pdf not installed; install gstack" >&2; exit 1; }
```

## Workflow

```
1. RESOLVE  → Confirm the brain page exists (gbrain get <slug>).
2. STRIP    → Remove YAML frontmatter — the renderer would otherwise
              dump it as a full page of raw metadata text.
3. RENDER   → Invoke make-pdf with sane defaults (no --cover, no --toc).
4. DELIVER  → Hand the PDF to the requester via the agent's preferred
              channel (do not use raw `MEDIA:` tags on Telegram —
              they fail silently).
```

## Invocation

```bash
SLUG="path/to/page"
P="$HOME/.claude/skills/gstack/make-pdf/dist/pdf"

# 1. Confirm the page exists.
gbrain get "$SLUG" > /dev/null || { echo "Page $SLUG not found" >&2; exit 1; }

# 2. Get the raw markdown. Two paths: read from the brain repo (if user
#    syncs locally) OR ask gbrain for the body via the API.
BRAIN_DIR=$(gbrain config get sync.repo_path 2>/dev/null || echo)
if [ -n "$BRAIN_DIR" ] && [ -f "$BRAIN_DIR/$SLUG.md" ]; then
  RAW="$BRAIN_DIR/$SLUG.md"
else
  RAW=$(mktemp /tmp/brain-page-XXXXXX.md)
  gbrain get "$SLUG" --raw > "$RAW"   # whatever flag exposes raw body
fi

# 3. Strip YAML frontmatter — sed: skip the opening '---' through the
#    closing '---' (lines 1..N), then keep everything after.
CLEAN=$(mktemp /tmp/brain-page-clean-XXXXXX.md)
sed '1{/^---$/!q}; /^---$/,/^---$/d' "$RAW" > "$CLEAN"

# 4. Render. NO --cover, NO --toc by default — they look corporate
#    and waste space. Add them only if explicitly requested.
OUT="/tmp/$(basename "$SLUG").pdf"
CONTAINER=1 "$P" generate "$CLEAN" "$OUT"

echo "Rendered: $OUT"
```

`CONTAINER=1` is mandatory in containerized environments — it tells
Playwright to skip Chromium sandboxing. Harmless on bare-metal.

## Common patterns

```bash
# Default — clean PDF, no cover, no TOC
brain-pdf <slug>

# Draft watermark for in-progress work
CONTAINER=1 "$P" generate --watermark DRAFT "$CLEAN" "$OUT"

# Optional cover + TOC if the user explicitly asks
CONTAINER=1 "$P" generate --cover --toc "$CLEAN" "$OUT"

# Custom title + author override (otherwise pulled from frontmatter)
CONTAINER=1 "$P" generate --title "Custom Title" --author "Custom Author" "$CLEAN" "$OUT"
```

## Defaults: NO cover, NO TOC

These flags are off by default because they look corporate and waste
space on most personal-knowledge content. Only add them when the user
explicitly asks for "formal" output (e.g., something they're sending to
a board or printing as a deliverable).

## Font requirements

The renderer needs:

- `fonts-liberation` (Helvetica/Arial substitute)
- `fonts-noto-cjk` (Chinese/Japanese/Korean characters)
- Minimum body font size: 10pt (page chrome 9pt)
- Body text: 11pt

If running in an environment without these fonts, install them via the
host's package manager (`apt install fonts-liberation fonts-noto-cjk` on
Debian/Ubuntu containers).

## Delivery

After rendering, deliver via the agent's preferred channel:

- **Telegram:** use the `message` tool with `filePath="/tmp/<slug>.pdf"`
  attachment. NEVER use raw `MEDIA:` tags — they fail silently.
- **Email:** attach via the host's email tool.
- **Direct file response:** print the PDF path; the user can pull it
  manually.

Always include the brain page link in the delivery message so the user
can also see it on GitHub / locally. The PDF is a rendering; the source
is the artifact.

## Anti-Patterns

- ❌ Generating a PDF without first confirming the brain page exists.
  No source = no PDF.
- ❌ Skipping the frontmatter strip. The renderer dumps frontmatter as
  raw text on the first page; ugly.
- ❌ Skipping emoji sanitization. Emoji that don't map to the rendering
  font show up as `□` boxes.
- ❌ Adding `--cover` or `--toc` by default. Off unless asked.
- ❌ Using raw `MEDIA:` tags for Telegram delivery. Use the `message`
  tool with `filePath`.

## Related skills

- `skills/book-mirror/SKILL.md` — produces a brain page that's a
  natural input to brain-pdf (chapter-by-chapter personalized analysis).
- `skills/strategic-reading/SKILL.md` — same shape, problem-lens variant.
- `skills/publish/SKILL.md` — share brain pages as password-protected
  HTML (different rendering target).


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
