---
name: eiirp
version: 1.0.0
prompt_version: 1
description: |
  Everything In Its Right Place. The universal post-work organizer. After
  any significant work session, EIIRP runs a 7-phase audit: (1) inventory
  every output, (2) walk taxonomy to decide where each lands, (3) check
  schema-pack consistency against the brain's actual shape, (4) file
  enriched brain pages, (5) audit the skill graph for DRY+MECE, (6) verify
  resolvability, (7) report. Named after the Radiohead song. Nothing
  produced during significant work lives only in chat — knowledge becomes
  permanent, patterns become reusable.
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
filing_exempt: true
distinct_from:
  - name: brain-taxonomist
    reason: "brain-taxonomist classifies individual pages at write time (the filing GATE). EIIRP orchestrates the full post-work LIFECYCLE — inventory + taxonomy + schema + skillify + verify."
  - name: ingest
    reason: "ingest handles NEW content from external URLs/media. EIIRP handles COMPLETED research that needs to be decomposed and filed across multiple brain locations."
  - name: skillify
    reason: "skillify is the meta-skill for turning a feature into a tested skill. EIIRP calls skillify when Phase 5 identifies a reusable pattern."
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

**Confidence floor (codex finding #9):** when `gbrain schema suggest`
returns confidence < 0.6 on a proposed type, DO NOT auto-apply. Surface
the suggestion to the user and let them choose. The schema-cathedral
ships the primitives; EIIRP enforces the human-in-the-loop gate.

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
- Check if a brain page exists (`gbrain search "<name>"` or `gbrain get_page people/<slug>`).
- If exists: update State, append Timeline entry citing this research.
- If not: create with enrichment.

### 4c. Commit and verify
After ALL pages are written, run `gbrain sync` (or commit + push in the
brain repo). Verify every link resolves.

## Phase 5: SKILL GRAPH AUDIT — DRY + MECE on capabilities

This phase operates on the SKILL graph, not just the research.

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
- [ ] Any new skills have routing entries in `skills/RESOLVER.md`
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
  custom packs MUST get the right behavior automatically. Pinned by D9
  from /plan-eng-review.
- **Auto-applying low-confidence schema suggestions.** Confidence < 0.6
  from `gbrain schema suggest` is "manual review required" per codex
  finding #9. EIIRP surfaces it; the user accepts.
- **Skipping Phase 5 SKILL GRAPH AUDIT because "this was a one-off."**
  If the work took >10 minutes, the methodology is probably reusable.
  Audit anyway; defer the skillify decision to the user.
- **Filing synthesis output by topic alone.** Synthesis pages tied to a
  single source + reader are sui generis; they file under
  `media/<format>/<slug>-personalized.md`. See _brain-filing-rules.md
  "Sanctioned exception" section.
- **Treating non-English sources as secondary citations.** Multilingual
  sources are first-class.

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
