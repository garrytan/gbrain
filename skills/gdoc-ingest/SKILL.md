---
name: gdoc-ingest
version: 0.7.0
# Sprints completed:
#   1: doc ingestion (MVP)
#   2: slides + entities + meeting detection
#   3: vision pipeline (slides w/ bitmap charts)
#   4: sheets + bug fix (lock contention via batchRead)
#   5: PDF + crons (crawler/triagem/stale) + Slack auto-trigger
#   6: Iron Law back-links + successor detection
#   7: LLM evals + E2E + filing rules entry + USAGE.md
# Status: properly skilled (10/10), 64 tests, E2E validated
description: |
  Index Google Workspace documents (Docs/Sheets/Slides) into the brain as
  searchable references with summary, owner, status, kind, disciplina/tema
  proposal, secondary tags, slide stats (skip hidden), entity extraction,
  and a link back to Drive. Drive remains the source of truth; the brain
  is the index. Triage promotes pages from `docs/inbox/<slug>` to
  `docs/<disciplina>/<tema>/<slug>`.
triggers:
  - "indexa esse doc"
  - "salva esse link"
  - "ingest gdoc"
  - "ingest gsheet"
  - "ingest gslide"
  - "ingest pdf"
auto_triggers:
  # When the agent sees a Drive link in a message, run gdoc-ingest in
  # background WITHOUT a verbose response. This is the signal-detector
  # pattern — silent ingestion, log to docs/inbox, ping only on triagem-ping cron.
  - link_pattern: "docs.google.com/(document|spreadsheets|presentation)/d/[a-zA-Z0-9_-]{20,}"
  - link_pattern: "drive.google.com/file/d/[a-zA-Z0-9_-]{20,}"
  - mode: "silent_background"  # ingest --commit, no chat reply unless asked
  - skip_channels: ["#docs-ignore"]  # honor opt-out
  - debounce_seconds: 5  # avoid duplicate ingest if URL re-pasted in 5s window
tools:
  - search
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
writes_to:
  - docs/
---

# gdoc-ingest

Index Google Workspace documents (Docs / Sheets / Slides / PDFs in Drive) into
the brain as searchable references. Drive remains source of truth; the brain
becomes the canonical INDEX.

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any
> new page. The PRIMARY SUBJECT of the document decides where it goes after
> triage; while in inbox it lives at `docs/inbox/<slug>`.

## The rule

**Every Google Workspace document Rafael cares about must be reachable via
`gbrain__search` within 30 seconds.** No more hunting links across Slack,
email, and meeting transcripts. The brain is the catalog; Drive is the
warehouse.

## Contract (v0.2)

This skill guarantees:

- **One page per indexed Drive doc** at `docs/inbox/<slug>` with frontmatter
  carrying `type: document`, `status: draft-index`, `disciplina`, `tema`,
  `secondary_tags`, `kind`, `owner`, `url_drive`, `file_id`, `mimetype`,
  `last_modified_drive`, `indexed_at`, `indexed_via`, `raw_char_count`,
  `is_meeting_doc` (when detected), `slide_stats` (when slide).
- **Slug proposal** for the final filed location:
  `docs/<disciplina>/<tema>/<slug>` derived from title via `inferDisciplinaTema`
  (taxonomy match, **title-first per
  [`concepts/title-first-classification`](../../docs/concepts/title-first-classification.md)**)
  + `slugifyTitle` (kebab-case).
- **Slide hidden filter** — for Slides, `slides.getAllContent` (default
  `includeHidden: false`) skips hidden slides; the page logs total /
  visible / hidden counts for transparency.
- **Meeting-doc detection** — filenames matching `Google Meet transcript-`,
  `Anotações do Gemini`, or raw `transcript-xxx-xxxx-xxx` patterns flag the
  page with a banner suggesting also routing to `meeting-ingestion`.
- **Entity extraction** — heuristic `extractEntities()` returns candidate
  people / projects / decisions for the Triagem section. Filter PEOPLE_STOPWORDS
  removes false positives like "Plano Futuro" / "Status Atual".
- **Provenance** on every page (format per `conventions/quality.md`).
- **Linking** scaffolded in the Triage section; rules in `conventions/quality.md`.
  v0.2 surfaces candidates; full auto-resolution is a future phase.
- **No mutation of Drive** — read-only.
- **Fail-soft** — if content extraction fails, the page is still created
  with metadata + a clear `_Falha ao extrair conteúdo_` marker.

> **Convention:** all writing follows [`conventions/quality.md`](../conventions/quality.md). See it for the canonical rules; we do not restate them here.

## How to use

**As an agent (preferred):**
- User pastes a Google Drive URL in `#docs-inbox` (Slack)
- Agent invokes the skill: `bun ~/gbrain/skills/gdoc-ingest/scripts/gdoc-ingest.mjs "<url>" --via slack-paste`
- Agent reads the JSON output and commits via `gbrain__put_page` MCP tool (preferred) or with `--commit` flag (CLI path)
- Agent posts back: "📎 Indexado em `docs/inbox/<slug>` — proposta: `docs/<disciplina>/<tema>/<slug>`. Confirma?"

**As a human (CLI):**
```bash
# Dry run — print the rendered payload without touching the brain:
bun ~/gbrain/skills/gdoc-ingest/scripts/gdoc-ingest.mjs "https://docs.google.com/document/d/.../edit"

# Commit (CLI path — uses gbrain put):
bun ~/gbrain/skills/gdoc-ingest/scripts/gdoc-ingest.mjs "https://docs.google.com/document/d/.../edit" --commit

# Batch:
bun ~/gbrain/skills/gdoc-ingest/scripts/gdoc-ingest.mjs --batch \
  "https://docs.google.com/document/d/abc/edit" \
  "https://docs.google.com/spreadsheets/d/def/edit" \
  --commit --via manual-cli
```

## Phases (v0.2)

### Phase 1 — Parse URL & detect kind
- `parseDriveUrl(url)` → `{ kind: doc|sheet|slide|drive-file, fileId }`
- Null → reject with "URL inválida ou não-Drive"

### Phase 2 — Fetch via GAS Workspace Bridge
- `docs.getContent` / `sheets.getSheetInfo` / `slides.getAllContent`
- For PDFs (drive-file): metadata only in MVP

### Phase 3 — Slide-specific text extraction
- `extractSlideText(slidesJSON)` walks GAS tree, pulls plain text
- Skips hidden slides; counts total / visible / hidden

### Phase 4 — Detect meeting-doc pattern
- `detectMeetingDoc(name)` matches transcript / Gemini patterns
- When true: page emits banner suggesting also `meeting-ingestion`

### Phase 5 — Propose disciplina + tema + slug
- `inferDisciplinaTema(title, body)` — TITLE-FIRST
- Returns `{ disciplina, tema, secondaryTags }`
- Default: `('ops', 'projetos-especiais')`
- `slugifyTitle(title)` → kebab-case ASCII, ≤60 chars

### Phase 6 — Entity extraction (heuristic)
- `extractEntities(text)` → `{ people, projects, decisions }`
- PEOPLE_STOPWORDS filters PT-BR false positives

### Phase 7 — Summarize
- `summarizeWithLLM` (env-gated; defaults to fallback)
- `summarizeFallback` — deterministic 3-bullet placeholder
- Agent layer overwrites with real LLM summary during triage

### Phase 8 — Render the page
- `renderInboxPage(args)` returns markdown w/ full frontmatter
- Sections: Title, citation, slide-stats, meeting-banner, Resumo, Entidades, Triagem, Histórico

### Phase 9 — Commit
- Agent path: `gbrain__put_page(slug, content)` MCP tool (preferred)
- CLI path: `callBrainPutPage` shells out to `gbrain put` (cron-only; needs OpenAI quota for embeddings)

### Batch mode
- `ingestBatch(urls, opts)` — sequential with per-item error capture

## Output format

```jsonc
{
  "slug": "docs/inbox/<slug>",
  "proposedFinalSlug": "docs/<disciplina>/<tema>/<slug>",
  "title": "...",
  "fileId": "...",
  "kind": "doc|sheet|slide|drive-file",
  "disciplina": "ops",
  "tema": "df",
  "secondaryTags": ["backlog", "inativos"],
  "page": "(markdown body)",
  "charCount": 1234,
  "indexedAt": "ISO-8601",
  "indexedVia": "slack-paste|drive-crawler|manual-cli",
  "isMeetingDoc": false,
  "slideStats": { "totalSlides": 15, "visibleSlides": 15, "hiddenSlides": 0 },
  "entities": { "people": [...], "projects": [...], "decisions": [...] },
  "committed": true   // only when --commit was passed
}
```

## MECE versus sibling skills

- `media-ingest` — PDFs OUTSIDE Drive, video, audio, screenshots, GitHub repos
- `meeting-ingestion` — transcripts. gdoc-ingest detects meeting-doc pattern in Drive and suggests chaining
- `archive-crawler` — bulk archive imports (Dropbox, B2, Gmail-takeout) with allowlist
- `ingest` (router) — gdoc-ingest is a destination, not a router

## Triage workflow (out of scope for the script; lives in the agent)

After the page lands in `docs/inbox/<slug>`:

1. **Cron Friday 15:00 BRT** (`com.opsos.gdoc-inbox-triagem-ping`) — agent
   posts triage batch in `#docs-inbox` listing all pages with `status: draft-index`
2. **On demand** — Rafael writes "triagem docs" in any monitored channel
3. **Auto-stale** (`com.opsos.gdoc-inbox-stale-check`, daily 09:00) — items >30d
   are flagged 🟡; >60d auto-archived with `status: stale-untriaged`
4. **Drive crawler** (`com.opsos.gdoc-crawler-weekly`, Friday 17:00) — finds
   recently-modified docs not yet indexed and ingests them
5. **Triage action** — Rafael approves the proposed slug or proposes another

## Cron handlers (Sprint 2)

LaunchAgents installed at `~/Library/LaunchAgents/com.opsos.gdoc-*.plist`,
shell scripts at `~/.gbrain/gdoc-*.sh`:

- `com.opsos.gdoc-crawler-weekly` — Friday 17:00 BRT
- `com.opsos.gdoc-inbox-triagem-ping` — Friday 15:00 BRT
- `com.opsos.gdoc-inbox-stale-check` — Daily 09:00 BRT (placeholder; full
  query-based implementation pending)

To activate (Rafael auth required):
```bash
launchctl load ~/Library/LaunchAgents/com.opsos.gdoc-crawler-weekly.plist
launchctl load ~/Library/LaunchAgents/com.opsos.gdoc-inbox-triagem-ping.plist
launchctl load ~/Library/LaunchAgents/com.opsos.gdoc-inbox-stale-check.plist
```

## Tests

- Unit: `~/gbrain/test/gdoc-ingest.test.ts` — 53 tests covering parse, slugify,
  taxonomy, render, slide extraction, entity extraction, meeting detection
- Routing eval: `~/gbrain/skills/gdoc-ingest/routing-eval.jsonl` — 12 fixtures
  (8 positive + 4 MECE counter-cases)
- E2E (guarded): `~/gbrain/test/e2e/gdoc-ingest-e2e.test.ts` — env `OPSOS_GDOC_E2E=1`
- Integration: real GAS smoke test via CLI

## Source

- Created from PRD `prds/gdoc-ingest` v1.0 (locked 2026-05-06)
- Sprint 1 (MVP, v0.1.0): docs + sheets, heuristic, no slides
- Sprint 2 (v0.2.0): + slides + entity extraction + secondary tags +
  meeting-doc detection + batch mode + 3 crons + stop-word filter
- Conversation: Slack #assistente, Rafael 2026-05-06
