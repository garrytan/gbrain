# Design: `gbrain onboard` — Guided Brain Health + Migration System

## Status: Proposal
## Related: #1383

## Problem

When an agent connects to gbrain for the first time or after an upgrade, there is no guided path to diagnose and fix common health issues. Agents wire up gbrain and never discover that the brain is severely underperforming.

Production data from a 165K-page brain after 6 weeks of agent use:

| Metric | Actual | Healthy target |
|--------|--------|----------------|
| Orphan pages (no inbound links) | 88% | <30% |
| Entity link coverage | 32% | >70% |
| Timeline coverage | 69% | >90% |
| Stale embeddings | 25K pages | 0 |
| Takes (typed claims) | 0 | >100 |
| Brain score | 56/100 | >80/100 |

These issues accumulate silently. The operator discovered them months in.

## Root Cause

1. **No post-install health check.** `gbrain init` creates the schema but doesn't assess content health.
2. **No migration prompts on upgrade.** New features (think, brainstorm, salience, extract_facts) ship but agents don't know to use them.
3. **No progressive onboarding.** A brain with 10 pages needs different guidance than one with 165K pages.
4. **doctor reports problems but doesn't fix them.** It says "32% link coverage" but doesn't offer `gbrain extract links --ner` as a fix.

## Proposed Solution: `gbrain onboard`

### CLI Interface

```bash
gbrain onboard          # interactive — diagnose + prompt for each fix
gbrain onboard --auto   # apply all recommended fixes automatically
gbrain onboard --check  # dry-run — show what would be recommended
gbrain onboard --json   # machine-readable for agent integration
```

### What it does

1. **Diagnose** — runs doctor + health + features + schema stats
2. **Prioritize** — ranks issues by impact (orphans > stale embeds > link coverage > timeline > takes)
3. **Prompt** — for each fixable issue, presents a migration prompt with the command to run
4. **Execute** — runs the fix (interactive) or queues it (--auto)
5. **Record** — stores completed migrations in kv table (idempotent re-runs)

### Migration System

Each migration is a declarative spec:

```yaml
id: auto-link-entity-mentions-v1
version_introduced: 0.42.0
condition: orphan_ratio > 0.5
priority: 1
prompt: "{orphan_pct}% of pages have no inbound links. Extract entity mentions to create links?"
command: gbrain extract links --by-mention
estimated_time: "~5 min per 10K pages"
auto_eligible: true
```

Migrations are:
- **Idempotent** — re-running is safe
- **Recorded** — kv table tracks which migrations ran and when
- **Versioned** — new gbrain versions can ship new migrations
- **Conditional** — only fires when the condition is true for this brain

### The Five Migrations (priority order)

#### 1. Auto-Link Entity Mentions (Orphan Reduction)

**Condition:** orphan_ratio > 0.5
**Impact:** Highest — 88% orphans means think can't traverse the graph

The current link extraction only finds explicit markdown links. When a page mentions "Acme Corp" in body text, no link is created. Proposed: scan page text for mentions of known entity names (using the brain's own pages as a gazetteer) and create `mentions` links.

**Implementation approach:**
- Build a trie/set from all entity page titles + frontmatter aliases
- For each page, tokenize body text and fuzzy-match against the entity set
- Create `mentions` links with dedup
- Gate behind config: `gbrain config set auto_link_mentions true`

**Agent onboarding:** doctor detects orphan_ratio > 50%, recommends enabling auto-link.

#### 2. Smart Embed Scheduling (Stale Catch-Up)

**Condition:** stale_count > 1000
**Impact:** High — stale embeddings mean vector search returns outdated content

Current `gbrain embed --stale` processes pages one at a time. With 25K stale pages, daily crons can't keep up.

**Implementation approach:**
- Add `--batch-size N` and `--priority recent` flags
- Add `--catch-up` mode that runs until backlog is clear (with rate limiting)
- Dream cycle reports stale count and auto-escalates batch size when backlog grows

#### 3. NER-Based Entity Link Extraction

**Condition:** entity_link_coverage < 0.5
**Impact:** Medium-high — typed links (works_at, founded, invested_in) enable find_experts, find_trajectory

The schema pack defines link verbs but the data isn't there because extraction only works on frontmatter fields.

**Implementation approach:**
- Regex-based NER over page body text matching schema pack link_type inference patterns
- "CEO of Acme" → works_at link, "invested in Acme" → invested_in link
- Use schema pack's `link_types[].inference.regex` as the pattern source
- Add `gbrain extract links --ner` flag

#### 4. Timeline Extraction from Meetings

**Condition:** timeline_coverage < 0.7
**Impact:** Medium — timeline enables find_trajectory

Meeting pages discuss entities but timeline entries aren't extracted.

**Implementation approach:**
- For each meeting page, identify discussed entities from attendees + body text
- Create timeline entries on entity pages: "[date] Discussed in [meeting title]"
- Add `gbrain extract timeline --from-meetings` flag

#### 5. Takes Bootstrap from Existing Content

**Condition:** takes_count == 0
**Impact:** Medium — takes enable calibration, takes_search, scorecard

The takes system has full infrastructure but zero data because no extraction path exists.

**Implementation approach:**
- Scan concept/atom/lore pages for claim-like sentences
- Use LLM to classify: fact/take/bet/hunch
- Extract claim text, attribute to source page
- Add `gbrain takes extract --from-pages`
- Dream step: run takes extraction on recently-modified pages

### Agent Integration

`INSTALL_FOR_AGENTS.md` should instruct agents to run:
```bash
gbrain onboard --check --json
```

On first connection and after every upgrade. The JSON output tells the agent what health issues exist and what commands to run.

### Upgrade Path

Every gbrain version bump can include migration specs. The migration runner:
1. Reads all migration specs from `src/migrations/`
2. Checks kv table for already-completed migrations
3. Evaluates conditions against current brain state
4. Runs (or prompts) any applicable migrations
5. Records completion

This means existing users who upgrade automatically get prompted to fix their brain health.

## Implementation Plan

1. **v0.42.0:** `gbrain onboard` command with migration #1 (auto-link entity mentions)
2. **v0.42.1:** Migration #2 (smart embed scheduling)
3. **v0.43.0:** Migrations #3-5 (NER, timeline, takes)
4. **v0.43.1:** Agent integration (INSTALL_FOR_AGENTS.md + JSON output)
