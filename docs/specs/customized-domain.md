# Spec: GBrain Customized Domain (VC to Developer)

## Goal

Customize gbrain from a VC/executive personal intelligence system to a developer
knowledge base that documents development processes, architectural decisions, debug
trails, and patterns. The brain should compound development knowledge the same way
upstream gbrain compounds people/company knowledge.

The key constraint: a new Claude agent in a fresh devcontainer (built from the
Dockerfile at `/workspaces/practicespace-2/.devcontainer/Dockerfile`) should be
able to read the brain and repeat a development process. The brain is institutional
memory that survives across agent sessions and environments.

## Closed-Loop Criterion

Knowledge flows in a 6-phase loop. Every file that touches any phase must be
audited. If a file says "people" or "companies" anywhere in the loop, it is a
potential break point where developer knowledge gets lost.

```
1. DETECT   - agent recognizes something worth capturing
2. WRITE    - agent creates/updates a brain page (put_page, add_link, add_timeline_entry)
3. STORE    - page lands in PGLite with embeddings for vector search
4. RETRIEVE - agent searches the brain when answering questions (search, query, get_page)
5. PRESENT  - agent uses retrieved knowledge in its response
6. ENRICH   - on subsequent interactions, agent updates existing pages
```

## Developer Entity Types

Replacing the upstream VC taxonomy (people/, companies/, deals/, meetings/):

| Directory | Type | Example | Description |
|-----------|------|---------|-------------|
| `projects/` | project | `projects/my-app.md` | Hub pages for active codebases. Sub-pages for project-specific decisions and debug trails |
| `decisions/` | decision | `decisions/chose-postgres-over-sqlite.md` | ADR-style technical decisions with rationale. Cross-project |
| `debug-trails/` | debug-trail | `debug-trails/auth-jwt-rotation-cache-bug.md` | Bugs investigated, root causes, fixes applied |
| `patterns/` | pattern | `patterns/repository-pattern.md` | Reusable dev patterns and practices |
| `processes/` | process | `processes/deploy-to-production.md` | Step-by-step workflows: deploy, test, setup |
| `tools/` | tool | `tools/docker-compose.md` | Tool config, gotchas, setup knowledge |
| `goals/` | goal | `goals/migrate-to-nextjs.md` | Target outcomes per project, links to /goal skill |
| `environments/` | environment | `environments/devcontainer-v2.md` | Devcontainer/Dockerfile fingerprint, toolchain versions |
| `concepts/` | concept | `concepts/event-sourcing.md` | Kept from upstream. Works for dev concepts |
| `meetings/` | meeting | `meetings/2026-05-14-sprint-retro.md` | Kept from upstream. Meetings still happen |

### Hybrid taxonomy (Option A)

Project-specific knowledge nests under the project hub:
```
brain/
+-- projects/
|   +-- my-app.md                  <- hub page
|   +-- my-app/
|   |   +-- decisions/             <- project-specific decisions
|   |   +-- debug-trails/          <- project-specific debug trails
+-- patterns/                      <- cross-project (transferable)
+-- tools/                         <- cross-project
+-- processes/                     <- cross-project
+-- decisions/                     <- cross-project decisions
+-- goals/
+-- environments/
+-- concepts/
+-- meetings/
```

Filing test: does this knowledge transfer to the next project? If yes, file at
the top level. If no, file under the project.

### Brain-to-skill promotion pipeline

The brain documents HOW you figured something out. When a process proves
repeatable (2-3 times with only argument changes), it graduates from a
`processes/` brain page to an actual skill file. The brain page keeps the
evidence trail and links to the skill. This is the feedback loop from the
"thin harness, fat skills" ethos.

- Brain stores: context, evidence, tradeoffs, project-specific constraints, debug history
- Skill files store: stable, parameterized procedures with deterministic steps
- Promotion rule: if reused successfully 2-3 times with only argument changes, graduate to a skill
- Bidirectional links: process page links to skill file path, skill references source brain pages

## Analysis History (3 rounds)

### Round 1: Write-side only (3 files)

First pass identified 3 files to rewrite, 4 to keep unchanged. Focused
entirely on the DETECT and WRITE phases. Did not consider retrieval at all.

### Round 2: Codex second opinion (+2 read-side patches)

Codex flagged that 3 write-side files are not sufficient for reliable retrieval:

- `brain-ops/SKILL.md` Phase 3: "person, company, or topic" biases trigger
  behavior. Developer question types need to be explicit.
- `brain-first.md` entity conventions table: acts as a behavioral filter. Agent
  constructs slugs from this table.

### Round 3: Closed-loop audit (+1 skill patch, +2 code patches)

A fresh agent traced every entity-type mention through all 6 loop phases.

**Key insight #1: quality.md is NOT domain-neutral.** The previous plan marked
it as "keep unchanged" because citation rules seemed universal. Wrong.
`quality.md` line 25 contains the canonical Iron Law definition: "Every mention
of a person or company WITH a brain page MUST create a back-link." Every other
file's Iron Law reference delegates HERE. If this says "person or company",
back-linking is scoped to only those types system-wide.

`quality.md` lines 34-36 contain the Notability Gate with criteria for People,
Companies, and Concepts only. Zero criteria for developer entities. Without
positive guidance, the agent defaults to "when in doubt, DON'T create."

**Key insight #2: brain-ops needs 8 changes, not 1.** Phase 2 trigger (line 69)
is the ENGINE of the loop: "Every message that references a person or company."
If it only fires for people/companies, the READ-ENRICH-WRITE loop is dead for
developer entities. The previous plan found 1 of 8 required changes.

**Key insight #3: code files participate in the loop.** `link-extraction.ts`
DIR_PATTERN regex only matches upstream directories. Auto-link will NOT create
graph edges for developer directories. `_brain-filing-rules.json` is the
machine-readable companion missing developer `kind` entries.

## Delegation Chain

The reason quality.md is the single most important patch:

```
signal-detector/SKILL.md line 47  --+
brain-ops/SKILL.md line 51        --+--> quality.md line 25 (Iron Law canonical def)
_brain-filing-rules.md line 63    --+    "Every mention of a person or company..."

                                          If this says "person or company",
                                          back-linking is scoped to ONLY those
                                          types system-wide, regardless of what
                                          the other files say.
```

Fix quality.md first. Every file that delegates to it inherits the fix.

## Complete Change Manifest

### Tier 1: Loop-breaking (without these, developer knowledge is lost)

#### Files to FULLY REWRITE (3)

| # | File | Loop Phase | Reason |
|---|------|-----------|--------|
| 1 | `skills/RESOLVER.md` | DETECT | Every trigger is VC-specific. Replace with developer triggers |
| 2 | `skills/signal-detector/SKILL.md` | DETECT + WRITE | Entity detection list (line 70) defines what gets captured. Currently: people, companies, media. Must become: projects, tools, decisions, patterns, processes |
| 3 | `skills/_brain-filing-rules.md` | WRITE + STORE | Entire taxonomy, misfiling table, notability gate, dream-cycle paths |

#### Skill files to PATCH (3)

| # | File | Sections to change | Loop Phase | What changes |
|---|------|-------------------|-----------|--------------|
| 4 | `skills/brain-ops/SKILL.md` | Frontmatter `writes_to`, Phase 2 trigger (line 69) + detect (line 71), Iron Law scope (line 49), Phase 4 enrichment triggers (lines 111-112), anti-patterns (line 146). 8 sites total. | ALL | Replace "person or company" with developer entity list at every hard-gate mention |
| 5 | `skills/conventions/brain-first.md` | Header (line 1), entity conventions table (lines 57-64): add 8 rows for developer dirs, replace 4 VC-only rows, remove `deals/` and `yc/` | RETRIEVE | Agent needs slug-construction guidance for all developer directories |
| 6 | `skills/conventions/quality.md` | Iron Law (line 25): generalize to "any entity with a brain page". Notability Gate (lines 34-36): add criteria for projects, decisions, tools, patterns, processes, debug-trails, goals, environments. Example (line 40): replace VC example | WRITE | Root of the delegation chain. All other files inherit from this |

#### Code/config files to PATCH (2)

| # | File | What changes | Loop Phase |
|---|------|-------------|-----------|
| 7 | `src/core/link-extraction.ts` | Add `decisions\|debug-trails\|patterns\|processes\|tools\|goals\|environments` to `DIR_PATTERN` regex at line 46 | STORE (auto-link) |
| 8 | `skills/_brain-filing-rules.json` | Add developer `kind` entries + update `dream_synthesize_paths.globs` array | STORE (dream cycle) |

#### Entrypoint edit (1)

| # | File | What changes |
|---|------|-------------|
| 9 | `/workspaces/practicespace-2/.devcontainer/entrypoint.sh` | Lines 154-165: drop 3 files from the array (brain-routing.md, subagent-routing.md, ask-user/SKILL.md). Result: 7 files loaded instead of 10 |

#### Unchanged (1)

| # | File | Loop Phase | Why safe |
|---|------|-----------|---------|
| 10 | `skills/_output-rules.md` | PRESENT | Rules are genuinely domain-neutral. "Deterministic links", "No slop", "Exact phrasing preservation" work for any entity type. Examples are VC-flavored but illustrative, not behavioral gates |

### Tier 2: Important but not loop-breaking

| File | Change | Priority |
|------|--------|----------|
| `src/core/markdown.ts` `inferType()` | Add developer directory-to-type mappings so pages get correct `PageType` instead of falling through to `concept` | Medium |
| `src/commands/doctor.ts` graph_coverage | Expand `type IN (...)` clause to include developer types | Low |
| `brain-ops/SKILL.md` Phase 2.5 | Add developer relationship types (uses, depends_on, decided_in) as examples | Low |

### Tier 3: Cosmetic / examples only

| File | Change |
|------|--------|
| `_output-rules.md` lines 39-40 | Optionally replace VC-flavored title examples |
| `brain-first.md` examples | Replace `paul-graham.md` with developer examples |
| `quality.md` line 40 | Replace "400-follower person" with developer equivalent |

## File Count Summary

| Category | Count | Files |
|----------|-------|-------|
| Full rewrite | 3 | RESOLVER.md, signal-detector/SKILL.md, _brain-filing-rules.md |
| Skill file patch | 3 | brain-ops/SKILL.md, brain-first.md, quality.md |
| Code/config patch | 2 | link-extraction.ts, _brain-filing-rules.json |
| Entrypoint edit | 1 | entrypoint.sh |
| Unchanged | 1 | _output-rules.md |
| **Total** | **10** | |

## Execution Order

1. **quality.md** first (root of delegation chain, every other file inherits)
2. **brain-ops/SKILL.md** second (the loop engine)
3. **signal-detector/SKILL.md** (detection layer)
4. **_brain-filing-rules.md** + **_brain-filing-rules.json** (filing taxonomy)
5. **RESOLVER.md** (routing table)
6. **brain-first.md** (retrieval conventions)
7. **link-extraction.ts** (auto-link code)
8. **entrypoint.sh** (drop 3 irrelevant files)
9. Tier 2 code changes (markdown.ts, doctor.ts) if time allows

## Process page template (for developer entities)

Every process page should include these sections to support reproducibility:

```markdown
---
type: process
title: Deploy to Production
tags: [deploy, production, ci]
---

# Deploy to Production

> One-paragraph summary of what this process achieves and when to use it.

## Preconditions
- What must be true before starting

## Inputs / Parameters
- What varies between runs

## Steps
1. Exact commands, in order
2. Expected output at each step
3. Checkpoints where you verify before continuing

## Failure Modes
- What can go wrong and how to recover

## Verification
- How to confirm the process succeeded

## Artifacts Produced
- What exists after completion that didn't before

---

## Timeline
- **YYYY-MM-DD** | Source - What happened, who ran it, what changed
```

## What was missed and why

The original analysis treated files as independent. The closed-loop audit
revealed they form a delegation chain where a single entity-type mention in a
canonical source (quality.md) propagates constraints across the entire system.

Three rounds of analysis were needed:
1. First pass: 3 write-side files (missed read path entirely)
2. Codex second opinion: +2 read-side patches (missed delegation chain and code)
3. Closed-loop audit: +1 skill patch + 2 code patches (complete)

The lesson: when customizing a domain, trace the delegation chain, not just
individual files. A "keep unchanged" file can be the root constraint that
silently blocks the entire new domain.
