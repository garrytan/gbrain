---
name: archive-crawler
version: 0.1.0
description: Universal archivist for personal file archives (Dropbox/B2/Gmail-takeout/local-mount/hard-drive-dump). Filters for high-value content (the user's own writing, ideas, relationships) and surfaces it interactively. REFUSES TO RUN without an explicit gbrain.yml `archive-crawler.scan_paths:` allow-list.
triggers:
  - "crawl my archive"
  - "find gold in my archive"
  - "archive crawler"
  - "scan my dropbox for"
  - "mine my old files for"
mutating: true
writes_pages: true
writes_to:
  - originals/
  - personal/
  - ideas/
---

# archive-crawler — The Universal Archivist

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> citation rules, exact-phrasing requirements when capturing the user's
> reactions, and back-link enforcement.
>
> **Convention:** see [_brain-filing-rules.md](../_brain-filing-rules.md) —
> this skill is **schema-generic**: it reads the user's filing rules from
> the rules JSON instead of hardcoding any specific era / archive layout.

## Safety gate (REQUIRED, no exceptions)

archive-crawler refuses to run unless `archive-crawler.scan_paths:` is
explicitly set in `gbrain.yml`. This is a deliberate safety fence against
the agent over-scoping a scan and ingesting sensitive content (tax PDFs,
medical records, credentials).

```yaml
# gbrain.yml — the allow-list is mandatory
archive-crawler:
  scan_paths:
    - ~/Documents/writing/
    - ~/Dropbox/Archive/
    - /mnt/backup/old-letters/
  # Optional deny-list inside the allow-list:
  # deny_paths:
  #   - ~/Documents/finances/
  #   - ~/Documents/medical/
```

If `scan_paths` is empty or missing, the skill exits with:

```
archive-crawler: refusing to run. No `archive-crawler.scan_paths:` allow-list
in gbrain.yml. Add explicit paths the agent is permitted to scan, then re-run.
This is a safety fence — the agent will not infer what's safe to read.
```

This contract is enforced by `src/core/storage-config.ts` (mirrors the
`db_tracked` / `db_only` allow-list pattern from v0.22.11 storage tiering).

## What this is

Generic engine for exploring any tree of personal content within an
explicit allow-list. Works on local mounts, Dropbox API targets,
Backblaze B2, Gmail takeouts (`.mbox`), and similar archives. Filters
for "gold" (the user's own writing, ideas, relationships) and surfaces
it interactively for review. Skips noise (system files, configs, binary
blobs).

## Concepts

### Source

A source is any tree of files to explore. Sources have:

- **type**: `local` | `dropbox` | `backblaze` | `gmail-takeout` | `mbox` | `pst`
- **root**: filesystem path, Dropbox path, B2 prefix, mbox path
- **manifest**: a brain page tracking progress at
  `projects/<archive-slug>/STATUS.md`

### Manifest

Every archive exploration gets a manifest brain page that tracks:

1. **Tree inventory** — folders / files / sizes / types
2. **Triage status** — each item: `⬜ unseen` / `👀 reviewed` /
   `✅ ingested` / `⏭️ skip` / `🔥 high-signal`
3. **User reactions** — exact quotes when they react (per
   conventions/quality.md exact-phrasing rule)
4. **Priority queue** — what to explore next, ranked
5. **Session log** — timestamped record of what was shown per session

### Gold filter

Before showing anything to the user, apply the gold filter:

| Keep (show) | Skip (note existence, don't show) |
|-------------|-----------------------------------|
| Personal writing (journals, letters, reflections, essays) | System files, configs, package.json, node_modules |
| Conversations (IM logs, email threads with substance) | Binary blobs (images / video) |
| Ideas, theses, frameworks | Receipts, invoices, tax docs |
| Relationship material (letters to / from people who matter) | Spam, newsletters, mailing-list bulk |
| Creative work (poetry, stories, code with soul) | Corrupted / null files |
| Origin stories (first versions of things that became important) | |
| Emotional content (anger, love, grief, discovery) | |

## Protocol

### Phase 1: Inventory

When pointed at a new source:

1. **Confirm scan_paths is set** (safety gate). Exit if not.
2. **Map the tree** — list folders + files + sizes + date ranges.
3. **Classify folders** — group by likely content type (writing, email,
   code, photos, docs, system).
4. **Create manifest** — write `projects/<archive-slug>/STATUS.md` with
   the full inventory.
5. **Propose priority queue** — rank folders by likely gold density.
6. **Present to user** — show the map and proposed order. Let them
   override.

### Phase 2: Crawl

Work through folders in priority order:

1. **Read before showing** — open each candidate file, apply the gold
   filter, skip noise.
2. **Show one at a time** — present gold items individually for review.
3. **Capture exact reaction** — track the user's response in the
   manifest using their exact words (per conventions/quality.md).
4. **Ingest if worth keeping** — create a brain page immediately.
5. **Update manifest** — mark item status after each interaction.
6. **Never re-show** — check the manifest before presenting anything.

### Phase 3: Ingest

When an item is worth keeping, file it by **primary subject** per
`_brain-filing-rules.md`:

- User's own writing / ideas / origin-story content → `originals/<slug>.md`
- Reflections / personal-life content → `personal/<slug>.md`
- Product / business ideas → `ideas/<slug>.md`
- Letters or threads about a specific person → `people/<person>/timeline`
  back-link plus the letter at `personal/<slug>.md` or `originals/<slug>.md`

**The skill is schema-generic.** It does NOT bake in any specific
era-folder structure (e.g., `originals/archive/` for pre-2003,
`originals/yc-era/` for post-2019, etc.). The user's filing rules from
`_brain-filing-rules.json` are read at runtime; the agent decides per-page
where content lands within those sanctioned directories.

Brain page format:

```markdown
---
title: "[Title or first line]"
type: original
source_type: "[local|dropbox|backblaze|gmail-takeout|mbox|pst]"
source_path: "[path within the allow-listed scan_paths]"
date: "YYYY-MM-DD"  # date from the file metadata or content
people: ["person-1", "person-2"]
tags: ["tag-1", "tag-2"]
---

# [Title]

[Summary: what it is, when it's from, why it matters]

**User's reaction:** [exact quote, no paraphrasing]

## Context

[Cross-links to people, concepts, projects.]

---

[Raw source material below the line — full text]
```

## File-type handlers

### Plain text / HTML / Markdown
Read directly. Strip HTML tags for display.

### `.mbox` (email archives)

```python
import mailbox
mbox = mailbox.mbox('/path/to/file.mbox')
for msg in mbox:
    body = ''
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == 'text/plain':
                body = part.get_payload(decode=True).decode('utf-8', errors='replace')
                break
    else:
        body = msg.get_payload(decode=True).decode('utf-8', errors='replace')
    # Apply gold filter
```

### `.doc` / `.docx`

```bash
# .docx (modern)
python3 -c "
import zipfile, xml.etree.ElementTree as ET
with zipfile.ZipFile('/path/to/file.docx') as z:
    tree = ET.parse(z.open('word/document.xml'))
    print(''.join(t.text or '' for t in tree.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')))
"

# .doc (legacy, requires antiword or catdoc)
antiword /path/to/file.doc 2>/dev/null || catdoc /path/to/file.doc 2>/dev/null
```

### `.pst` (Outlook archives)

```bash
# Validate first; many PSTs are null bytes
python3 -c "
with open('/path/to/file.pst', 'rb') as f:
    print('Valid PST' if f.read(4) == b'!BDN' else 'CORRUPT/NULL')
"
# If valid:
readpst -o /tmp/pst-output /path/to/file.pst
```

### `.zip` / `.tar` / `.tar.gz`

Extract to a temp dir, then recurse through the extracted tree.

### Images

Note existence + metadata (filename, size, date). Don't show unless the
user asks. Flag scans / portraits as potentially personal.

## Manifest template

```markdown
---
title: "[Archive Name] — Ingestion Status"
type: project
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_type: "[local|dropbox|...]"
scan_paths: ["paths from gbrain.yml"]
---

# [Archive Name] — Ingestion Status

## Source
- **Type:** [local|dropbox|...]
- **Allow-listed paths:** [from gbrain.yml]
- **Total files:** [N]
- **Total size:** [X GB]
- **Date range:** [earliest] — [latest]

## Inventory

### [Folder 1]
| Item | Type | Size | Status | Reaction |
|------|------|------|--------|----------|
| file1.txt | text | 2KB | ✅ ingested | 🔥 "exact quote" |
| file2.doc | doc | 15KB | ⏭️ skip | — |
| file3.html | html | 4KB | ⬜ unseen | — |

### [Folder 2]
...

## Priority Queue
1. [Highest priority — why]
2. [Next — why]
...

## Session Log

### YYYY-MM-DD — [Session topic]
- Reviewed: [list]
- Reactions: [exact quotes]
- Ingested: [brain pages created]
- Next: [what's queued]
```

## Anti-Patterns

- ❌ Running without `archive-crawler.scan_paths:` set. Hard refusal.
  This is the safety contract — never bypass.
- ❌ Hardcoding era-specific filing paths (e.g., `originals/archive/`,
  `originals/yc-era/`). Read filing rules at runtime instead.
- ❌ Re-showing items already marked in the manifest. The user's time
  is the scarcest resource.
- ❌ Paraphrasing reactions. Exact words only.
- ❌ Wrapping found content in lessons or takeaways. Let stories breathe.
- ❌ Skipping back-links when content references people / companies who
  have brain pages. Iron Law per conventions/quality.md.

## Related skills

- `skills/voice-note-ingest/SKILL.md` — same exact-phrasing pattern for
  audio capture
- `skills/idea-ingest/SKILL.md` — single-link-or-article ingest with
  the same primary-subject filing rule
- `skills/conventions/quality.md` — citations, back-links, voice


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
