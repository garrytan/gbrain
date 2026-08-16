---
name: eiirp
version: 1.1.0
prompt_version: 1
description: |
  Everything In Its Right Place. The universal post-work organizer. After
  any significant work session, EIIRP runs a 7-phase audit: (1) inventory
  every output, (2) walk taxonomy to decide where each lands, (3) check
  schema-pack consistency against the brain's actual shape, (4) file
  enriched brain pages, (5) audit the skill graph for DRY+MECE, (6) verify
  resolvability, (7) report. Named after the Radiohead song. Nothing
  produced during significant work lives only in chat — knowledge becomes
  permanent, patterns become reusable. Also carries the always-on
  auto-fire gate: when >=500 words of structured analysis on a
  user-shared document is about to be delivered, file the brain page
  first, then deliver the analysis with the link in that same reply.
triggers:
  - "everything in its right place"
  - "eiirp"
  - "store this research"
  - "put this in the brain"
  - "file this properly"
  - "where does this research go"
  - "make this permanent"
  - "archive this research"
  - "archive this research thread"
  - "brain this"
  - "file all of this"
  - "organize all of this"
  - "organize all of this work"
  - "make this re-doable"
  - "DRY this up"
  - "check everything is in the right place"
  - "analyze this document"
  - "deep analysis"
  - "review this report"
tools:
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
mutating: true
writes_pages: true
# EIIRP files across the full canonical set — the actual destination
# per page is decided by brain-taxonomist consulting the active schema
# pack via `gbrain schema show --json`. List the gbrain-recommended set
# of canonical directories here so the filing-audit gate passes; on
# brains with custom packs, the routing surface is broader and routes
# through loadActivePack at write time.
writes_to:
  - people/
  - companies/
  - deals/
  - meetings/
  - concepts/
  - projects/
  - civic/
  - writing/
  - analysis/
  - guides/
  - research/
filing_exempt: true
# The auto-fire gate section below was merged from an upstream
# deep-analysis auto-filing skill:
upstream: deep-analysis-brain-auto
distinct_from:
  - name: brain-taxonomist
    reason: "brain-taxonomist classifies individual pages at write time (the filing GATE). EIIRP orchestrates the full post-work LIFECYCLE — inventory + taxonomy + schema + skillify + verify."
  - name: ingest
    reason: "ingest handles NEW content from external URLs/media. EIIRP handles COMPLETED research that needs to be decomposed and filed across multiple brain locations."
  - name: skillify
    reason: "skillify is the meta-skill for turning a feature into a tested skill. EIIRP calls skillify when Phase 5 identifies a reusable pattern."
  - name: signal-detector
    reason: "signal-detector ambiently captures the USER's ideas + entity mentions on every inbound message. EIIRP's auto-fire gate files the AGENT's own deliverable analysis at reply time. Both are always-on; they watch opposite directions of the conversation."
  - name: meeting-ingestion
    reason: "meeting-ingestion (like idea-ingest, media-ingest, voice-note-ingest, book-mirror) is a dedicated pipeline with its own brain-write logic. The auto-fire gate EXEMPTS dedicated-pipeline content — it never double-files."
---

# EIIRP — Everything In Its Right Place

> *"Everything in its right place"* — Radiohead, Kid A

## Contract

After any significant work, EIIRP organizes ALL outputs across two domains:

**Knowledge domain (brain):**
1. Every piece of knowledge lands in the correct brain location.
2. All sources are cited and linked.
3. The active schema pack is updated if a new content type emerged.
4. Entity pages created/updated with cross-links.

**Capability domain (skills):**
5. Every reusable pattern becomes a composable skill.
6. Existing skills are audited for DRY violations.
7. Skill graph is MECE — no gaps, no overlaps, no ambiguous routing.

**The meta-guarantee:** Nothing produced during significant work lives only in chat.
Knowledge → brain. Patterns → skills. Everything in its right place.

## When to Use

- After completing a deep research thread.
- After building something new (code, pipeline, workflow).
- After a multi-source analysis that produced significant findings.
- When the user says "EIIRP", "organize this", "DRY this up", "make this re-doable".
- When a work session produced both knowledge AND new capabilities.
- When you notice skill overlap, duplication, or gaps.

## Auto-Fire Gate — file before you deliver (ALWAYS-ON)

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md)
> — this is its write side. Substantial analysis belongs in the brain, not
> only in chat.

Unlike the 7-phase audit above (which the user invokes after a work
session), this gate is an **always-on agent-side convention**, like
`signal-detector`: the agent applies it on every substantive reply, not
when a trigger phrase routes here. Always-on is a harness-routing
convention that a well-behaved agent follows — not a mechanical
guarantee; nothing in the gbrain runtime blocks a reply if the skill
never loads.

**The moment of evaluation is delivery, not request.** The gate
evaluates when substantial analysis (>=500 words of structured output
on a user-shared document) is ABOUT to be delivered — the analysis is
done and the reply is being composed. At that moment, file the brain
page FIRST, then deliver the analysis plus the page link in that same
reply. The user should never have to ask "did you file this?"

### Fire conditions (all three must hold)

1. The user shared a document — a PDF, a file attachment, a link to a
   doc, or pasted long-form content.
2. The reply about to be delivered contains substantial analysis:
   >=500 words of structured output (findings, recommendations, or
   extracted data — not restatement or formatting).
3. The content is knowledge worth re-finding — someone reading the
   brain months later would want this page.

### Does NOT fire

- Quick answers ("what page is X on?", "what date is on this?").
- Simple lookups, or forwarding a document unchanged.
- Purely operational content (task lists, calendar items, status pings).
- Documents already flowing through a dedicated pipeline (next list).
- Users who have turned auto-filing off (storage policy below).

### Dedicated-pipeline exemptions

These pipelines own their brain-write logic; the gate must NOT
double-file on top of them. If one of these is the right route, invoke
it and let it file:

- `skills/meeting-ingestion/SKILL.md` — transcripts + attendee propagation
- `skills/idea-ingest/SKILL.md` — articles with author/publication metadata
- `skills/media-ingest/SKILL.md` — bulk file ingestion
- `skills/voice-note-ingest/SKILL.md` — voice notes
- `skills/book-mirror/SKILL.md` — personalized book mirrors

### Filing mechanics (before the reply goes out)

1. **Path** — consult `skills/brain-taxonomist/SKILL.md`. It reads the
   active schema pack (`gbrain schema show --json`); document analysis
   usually lands under `analysis/` or `research/`, entity-centric
   findings under `people/` or `companies/`.
2. **Write** — file via capture:

   ```bash
   gbrain capture --file <analysis.md> --slug <taxonomist-path>
   ```

   (or `put_page` over MCP on thin-client installs). Full frontmatter
   per Phase 4a. The page must be self-contained — a reader months
   later gets the full picture without the chat thread.
3. **Link in the SAME reply** — the analysis inline (conversational,
   not just "see the brain page") plus a link line to the filed page,
   formatted per `skills/brain-link-discipline/SKILL.md` (it owns the
   link format and the resolve-verification step). Multiple pages →
   list every link.
4. **First-fire notice.** The very first time the gate fires for a
   user, append one line to the delivery reply so they learn about
   auto-filing at the moment it starts, not after: `Auto-filed to
   <path>; say "stop auto-filing" to disable.` Record that the notice
   was given (a per-user storage-policy note) so it never repeats.
   Alternatively, ask once at setup and record the policy before the
   first write.

### Per-user storage policy

Auto-filing is a DEFAULT, not a mandate — a per-user storage policy.
If the user says to stop auto-filing document analyses (or asks for
chat-only handling of a specific document), record that preference and
stop firing the gate: deliver the analysis without a page. Re-enable
on request.

### Relationship to the 7-phase audit

The gate is the single-deliverable fast path: one document → one page →
link in the delivery reply. A full work session still deserves the
complete EIIRP pass below; the gate just ensures no individual analysis
waits for it.

## Phase 1: INVENTORY — What did we produce?

Scan the current session/thread and identify ALL outputs across both domains.

### Knowledge outputs
```
□ Primary findings (the synthesis)
□ Source documents (URLs, PDFs, articles, tweets)
□ Entity mentions (people, companies, organizations, places)
□ Concepts/frameworks (reusable mental models)
□ Data artifacts (structured data, timelines, statistics)
```

### Capability outputs
```
□ New skills created or modified
□ Scripts/code written (should they be in lib/ or scripts/?)
□ Methodology used (search patterns, source chains, verification steps)
□ Workflows that could be automated (cron, pipeline, webhook)
□ Patterns that will recur (→ candidate for skillification)
```

Produce a manifest:

```markdown
## EIIRP Manifest
- Topic: [topic]
- Date: [date]
- Knowledge outputs: [count] (sources, entities, concepts)
- Capability outputs: [count] (skills, scripts, patterns)
- Reusable methodology: [yes/no — describe if yes]
```

## Phase 2: TAXONOMY — Where does each piece go?

**Read the active schema pack first** (the single source of truth for
filing decisions in v0.39+):

```bash
gbrain schema show --json
```

The pack's `page_types[]` lists every directory the brain accepts plus
the primitive each maps to. Walk it for each output and pick the directory
whose `path_prefixes` matches the content's primary subject.

If `brain-taxonomist` is installed, INVOKE IT for ambiguous cases. It runs
the same decision protocol against the active pack and gives you a single
recommended filing path with reasoning.

Output: a filing plan table:

```
| Content | Brain path | Action |
|---------|-----------|--------|
| Primary research | reference/.../page.md | CREATE |
| Person X | people/x-slug.md | CREATE |
| Person Y | people/y-slug.md | UPDATE (already exists) |
| ... | ... | ... |
```

## Phase 3: SCHEMA CHECK — Does the active pack cover this content?

This is where EIIRP closes the schema-derivation loop. If the work
produced content that doesn't fit any existing `page_types`, propose
adding a new type via the v0.39 cathedral:

```bash
# What's emerging in the brain that the active pack doesn't cover?
gbrain schema detect --json

# LLM-refined suggestions (heuristic when no API key set).
gbrain schema suggest --json

# Review what's pending; promote or ignore each candidate.
gbrain schema review-candidates --json
gbrain schema review-candidates --apply <prefix-or-type-name>
```

**Confidence floor:** when `gbrain schema suggest` returns confidence
< 0.6 on a proposed type, DO NOT auto-apply. Surface the suggestion to
the user and let them choose. The schema-cathedral ships the
primitives; EIIRP enforces the human-in-the-loop gate.

If schema needs change:
- Propose the addition to the user before running `review-candidates --apply`.
- Document the change in the commit message of the next sync.
- The schema-pack engine writes the delta to
  `~/.gbrain/schema-pack-deltas/` — review and merge into the active
  pack via `gbrain schema edit` (or hand-edit the YAML).

## Phase 4: FILE — Create enriched brain pages

For each item in the filing plan:

### 4a. Primary research page
Use the brain page template. MUST include:
- Proper frontmatter (`type`, `title`, `date`, `tags`, sources)
- **State** section — current status/key findings
- **Sources** section — every source with URL, author, date, language
- **Timeline** section — chronological development
- **Entity links** — backlinks to all related brain pages
- **See Also** — related concepts, reference pages

### 4b. Entity pages (people, companies)
For each entity mentioned:
- Check if a brain page exists (`gbrain search "<name>"` or `gbrain get people/<slug>`).
- If exists: update State, append Timeline entry citing this research.
- If not: create with enrichment.

### 4c. Commit and verify
After ALL pages are written, run `gbrain sync` (or commit + push in the
brain repo). Verify every link resolves.

## Phase 5: SKILL GRAPH AUDIT — DRY + MECE on capabilities

This phase operates on the SKILL graph, not just the research.

> **Read-only plugin installs:** the shipped plugin snapshot is not
> writable. New or updated skills and `lib/` extractions target your
> own project skill directory or a brain-resident skillpack
> (`gbrain skillpack init-brain-pack`), never the shipped snapshot.
> Phases 1-4 and the `gbrain` CLI checks in Phase 6 work everywhere.

### 5a. New pattern identification

Ask: did this work reveal REPEATABLE patterns that will recur?

**Indicators of a reusable pattern:**
- You used a specific sequence of searches across multiple sources.
- You followed a specific verification/cross-referencing methodology.
- You wrote code that could be parameterized for different inputs.
- The output format is generalizable.
- The user is likely to ask for similar work on a different topic.

**For each identified pattern:**
1. Identify the composable pieces (DRY, MECE):
   - Shared logic → `lib/` (not copy-pasted into skills)
   - Search methodology → skill or lib function
   - Output template → brain template or skill phase
   - Filing logic → already covered by brain-taxonomist + active pack
2. DRY check via the v0.19 resolver:
   ```bash
   gbrain check-resolvable
   ```
   Look for overlapping triggers or unreachable skills.

### 5b. Existing skill audit
For ALL skills used or touched during this work, check:
1. Were any skills BYPASSED? (did you do something manually that a skill should handle?)
2. Are there skills that OVERLAP with what you just did? (merge candidates)
3. Is shared code copy-pasted between skills? (extract to `lib/`)

**The MECE question:** If someone asked for this exact work again tomorrow on a different topic, which skills would they invoke? Is the path clear and unambiguous? If not, fix the routing.

### 5c. Present the plan
```
## Skill Graph Changes

### New skills to create
1. **[skill-name]** — [what it does]
   - DRY check: [clean / overlaps with X]
   - Recommendation: [create / merge into X]

### Existing skills to update
1. **[skill-name]** — [what changed, why]

### Code to extract to lib/
1. **lib/[name].ts** — [what it does, which skills use it]

### Skills to merge or deprecate
1. **[skill-A] + [skill-B]** → [merged-skill] — [why]
```

On approval: invoke `/skillify` for each new/modified skill.

## Phase 6: CHECK_RESOLVABLE — Verify everything routes

After all filing and skillification:

```bash
gbrain check-resolvable                         # routing-table reachability
gbrain doctor --json                            # health surface
gbrain search "<topic keywords>"                # brain pages findable
gbrain orphans                                  # any pages without inbound links?
```

Confirm:
- [ ] All brain pages have proper frontmatter against active schema pack
- [ ] All entity pages are cross-linked
- [ ] Any new skills have routing entries in `skills/RESOLVER.md` (where the skills tree is writable)
- [ ] No DRY violations (no duplicated logic across skills)
- [ ] No MECE violations (no ambiguous routing between skills)
- [ ] Active schema pack updated if new content types emerged
- [ ] `gbrain doctor` reports `schema_pack_consistency: ok`

## Phase 7: REPORT — Summary

```markdown
## EIIRP Complete: [Topic]

### Brain pages created/updated
- [path] — [description]
- ...

### Entity pages
- [path] — [created/updated]
- ...

### Schema changes
- [none / description of changes + which pack delta file]

### Skills identified
- [skill-name] — [status: created / merged / deferred]
- ...

### Resolver status
- DRY check: [clean]
- MECE audit: [clean]
- Active pack: [name] v[version]
- schema_pack_consistency: [ok / warn — pct untyped]
```

## Output Format

EIIRP produces a single Phase 7 report block. Plain markdown:

```markdown
## EIIRP Complete: [topic]

### Brain pages created/updated
- [path] — [description]

### Entity pages
- [path] — [created|updated]

### Schema changes
- [none | description of changes + which pack delta file]

### Skills identified
- [skill-name] — [status: created|merged|deferred]

### Resolver status
- DRY check: [clean|N violations]
- MECE audit: [clean|N overlaps]
- Active pack: [name] v[version]
- schema_pack_consistency: [ok|warn — N% untyped]
```

Always machine-readable: stable section headers + bullet-per-item. The
report doubles as a sync checkpoint for downstream skills (skillpack-check
reads it; doctor cross-references the pack version).

## Anti-Patterns

- **Hardcoding directory tables in EIIRP's logic.** Every filing decision
  reads `gbrain schema show --json`. Users on `gbrain-recommended` AND
  custom packs MUST get the right behavior automatically.
- **Auto-applying low-confidence schema suggestions.** Confidence < 0.6
  from `gbrain schema suggest` means manual review is required. EIIRP
  surfaces it; the user accepts.
- **Skipping Phase 5 SKILL GRAPH AUDIT because "this was a one-off."**
  If the work took >10 minutes, the methodology is probably reusable.
  Audit anyway; defer the skillify decision to the user.
- **Filing synthesis output by topic alone.** Synthesis pages tied to a
  single source + reader are sui generis; they file under
  `media/<format>/<slug>-personalized.md`. See _brain-filing-rules.md
  "Sanctioned exception" section.
- **Treating non-English sources as secondary citations.** Multilingual
  sources are first-class.
- **Delivering substantial document analysis without a filed page + link.**
  The auto-fire gate files FIRST, then delivers analysis + link in the
  same reply. Never "I'll create the page" as a future action; never the
  link in a follow-up message; never wait for the user to ask.
- **Double-filing dedicated-pipeline content.** Meeting transcripts,
  articles, bulk media, voice notes, and book mirrors have their own
  ingestion skills with their own brain-write logic. The gate exempts
  them.
- **Auto-filing after the user turned it off.** Auto-filing is a
  per-user storage-policy default, not a mandate. Honor the recorded
  preference.

## Hard Rules

### Knowledge domain
- **Never leave research only in chat.** If it took >10 minutes to produce, it gets a brain page.
- **Every source gets a citation.** No "according to reports" without a URL.
- **Entity pages get updated, not just created.** If a brain page exists, UPDATE it.
- **Schema changes require confirmation.** The active pack is load-bearing.
- **Multilingual sources are first-class.** Never treat non-English sources as secondary.

### Capability domain
- **DRY is sacred.** If the same logic appears in two skills, extract it to `lib/`.
- **MECE is sacred.** Every trigger phrase routes to exactly one skill.
- **Composability over monoliths.** Small skills that compose > one giant skill that does everything.
- **Skillify only what recurs.** One-off work doesn't need a skill. Patterns that repeat 2+ times do.

### Meta
- **EIIRP is idempotent.** Running it twice on the same work should produce no changes the second time.
- **EIIRP consumes the active schema pack as data.** Never hard-code directory tables in EIIRP's logic — read from `gbrain schema show --json` so users who picked `gbrain-recommended` OR custom packs get the right behavior automatically.

## Changelog

### v1.1.0 — auto-fire gate merge (from an upstream deep-analysis auto-filing skill)
- Merged the always-on auto-fire gate: when >=500 words of structured
  analysis on a user-shared document is about to be delivered, file the
  brain page first, then deliver analysis + link in that same reply.
- Filing routes through brain-taxonomist (active schema pack) +
  `gbrain capture` instead of the donor's git-commit mechanics; the
  donor's direct GitHub-API link check was dropped in favor of the
  brain-link-discipline skill's link format + verify step.
- Donor examples and origin story genericized per CLAUDE.md privacy
  rules; added dedicated-pipeline exemptions and the per-user
  storage-policy off switch.

### v1.0.0 — gbrain v0.39.0.0
- Initial port from upstream OpenClaw. Genericized — no references to
  private fork names per CLAUDE.md privacy rules.
- Phase 3 SCHEMA CHECK rewritten to consume the v0.39 cathedral CLI
  (`detect | suggest | review-candidates`) instead of a private
  `brain/schema.md`.
- Phase 5 SKILL GRAPH AUDIT calls `gbrain check-resolvable` instead of
  upstream `scripts/skill-dry-check.mjs`.
- Phase 6 verification uses `gbrain doctor`'s schema_pack_consistency
  check (T7) for the persistent surface.
