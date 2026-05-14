# Spec: GBrain Customized Domain (VC to Developer)

## Intro

GBrain is a personal knowledge brain that teaches AI agents to persist and
retrieve structured knowledge. Out of the box, it is built for a VC/executive
use case: tracking people (founders, investors, colleagues), companies
(portfolio, prospects, competitors), deals (funding rounds, term sheets), and
meetings (board meetings, 1:1s, pitch sessions). The enrichment pipeline fires
on every person or company mention, building dossier-style pages with career
history, beliefs, motivations, relationship context, and a reverse-chronological
timeline of interactions.

We want to adapt gbrain to a **developer use case**: documenting development
processes, architectural decisions, debug trails, coding patterns, tool
knowledge, and project context. Instead of compounding knowledge about people
and companies, the brain should compound knowledge about how software gets
built. The agent should capture technical decisions as they happen, record
root causes when bugs are debugged, and solidify repeatable processes so that
a completely new Claude agent in a fresh devcontainer can reproduce them.

The adaptation follows the "thin harness, fat skills" methodology from
`docs/ethos/THIN_HARNESS_FAT_SKILLS.md`: the gbrain CLI (deterministic layer)
stays unchanged. The skill files (latent-space layer) are where domain
knowledge lives, and those are what we rewrite. When a development process
proves repeatable, it graduates from a brain page to a skill file.

## Important Files

GBrain's agent behavior is driven by skill files that get concatenated into
`~/.claude/CLAUDE.md` at devcontainer boot (see `entrypoint.sh` lines 149-183).
These files form a layered instruction set that controls how the agent reads
and writes to the brain.

### Layer 1: Routing (which skill handles which intent)

| File | Role | Domain-specific? |
|------|------|-----------------|
| `skills/RESOLVER.md` | Trigger-to-skill routing table. When user says X, load skill Y. | YES — every trigger is VC-oriented ("investor updates", "donations", "who is") |

### Layer 2: Always-on behaviors (fire on every message)

| File | Role | Domain-specific? |
|------|------|-----------------|
| `skills/signal-detector/SKILL.md` | Ambient capture: detects entities and original thinking on every inbound message. Defines WHAT the agent looks for. | YES — detection list is people, companies, media. Writes to people/, companies/, concepts/ |
| `skills/brain-ops/SKILL.md` | The read-enrich-write loop engine. Defines WHEN the agent checks the brain, WHEN it writes back, and WHEN it enriches. Touches all 6 loop phases. | PARTIALLY — the loop mechanics are domain-agnostic but entity triggers say "person or company" at 8 hard-gate sites |

### Layer 3: Conventions (cross-cutting rules for all brain writes)

| File | Role | Domain-specific? |
|------|------|-----------------|
| `skills/conventions/quality.md` | Canonical Iron Law definition (back-linking), citation format, notability gate, source precedence. Every other file delegates here. | PARTIALLY — Iron Law scoped to "person or company" (line 25). Notability gate has criteria only for people/companies/concepts |
| `skills/conventions/brain-first.md` | Lookup chain (search -> query -> get_page -> external APIs). Entity conventions table maps directories to types. | PARTIALLY — table lists people/, companies/, deals/, meetings/, projects/, yc/. Agent constructs slugs from this |
| `skills/conventions/brain-routing.md` | Which brain (DB) and which source (repo) to target. Multi-brain federation rules. | NO — domain-agnostic routing. Relevant even in single-brain Topology 1 for source-axis awareness |
| `skills/_brain-filing-rules.md` | Where to file new pages. Decision protocol, misfiling table, dream-cycle synthesis paths. | YES — entire taxonomy is VC-oriented (people/, companies/, deals/) |
| `skills/_brain-filing-rules.json` | Machine-readable companion. `kind` entries and `dream_synthesize_paths.globs` array. | YES — missing developer entity kinds |

### Layer 4: Output quality (how brain pages should read)

| File | Role | Domain-specific? |
|------|------|-----------------|
| `skills/_output-rules.md` | Deterministic links, no slop, exact phrasing preservation, title quality. | NO — rules are genuinely domain-neutral |

### Layer 5: Code (enforces behavior regardless of skill instructions)

| File | Role | Domain-specific? |
|------|------|-----------------|
| `src/core/types.ts` | `PageType` union type. Compile-time gate: types not in the union cannot be assigned. | YES — missing developer types (decision, debug-trail, pattern, process, tool, goal, environment) |
| `src/core/markdown.ts` `inferType()` | Maps directory paths to `PageType`. Determines what type a page gets when imported. | YES — missing developer directory mappings |
| `src/core/link-extraction.ts` | `DIR_PATTERN` regex for auto-link. Determines which directory references create graph edges. | YES — missing developer directories |

### How the layers compose

```
User message arrives
  |
  v
Layer 1 (RESOLVER) -----> routes to the right skill
  |
  v
Layer 2 (signal-detector) -> DETECTS entities worth capturing
Layer 2 (brain-ops) -------> READ brain, ENRICH pages, WRITE back
  |
  v
Layer 3 (quality.md) ------> HOW to write (citations, back-links)
Layer 3 (brain-first.md) --> HOW to read (lookup chain, slug construction)
Layer 3 (brain-routing.md) > WHICH brain/source to target
Layer 3 (filing-rules) ----> WHERE to file (directory taxonomy)
  |
  v
Layer 4 (output-rules) ----> page quality standards
  |
  v
Layer 5 (code) ------------> enforces types, auto-link, type inference
```

The agent reads all layers at boot (concatenated into CLAUDE.md). When any
layer mentions "person or company" as a hard gate, developer entities are
invisible to that layer. The customization must patch every hard gate across
all layers.

## Goal

Customize gbrain from a VC/executive personal intelligence system to a developer
knowledge base that documents development processes, architectural decisions, debug
trails, and patterns. The brain should compound development knowledge the same way
upstream gbrain compounds people/company knowledge.

The key constraint: a new Claude agent in a fresh devcontainer (built from the
Dockerfile at `/workspaces/practicespace-2/.devcontainer/Dockerfile`) should be
able to read the brain and repeat a development process. The brain is institutional
memory that survives across agent sessions and environments. The cross-environment
reproducibility mechanism is the system-of-record contract: the brain repo (git)
is the portable artifact, and `gbrain sync && gbrain extract all` rebuilds the
DB from it in any fresh environment.

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
| 9 | `/workspaces/practicespace-2/.devcontainer/entrypoint.sh` | Lines 154-165: drop 2 files from the array (subagent-routing.md, ask-user/SKILL.md). Keep brain-routing.md for source-axis awareness. Result: 8 files loaded instead of 10 |

#### Unchanged (1)

| # | File | Loop Phase | Why safe |
|---|------|-----------|---------|
| 10 | `skills/_output-rules.md` | PRESENT | Rules are genuinely domain-neutral. "Deterministic links", "No slop", "Exact phrasing preservation" work for any entity type. Examples are VC-flavored but illustrative, not behavioral gates |

### Tier 2: Important but not loop-breaking

| File | Change | Priority |
|------|--------|----------|
| `src/core/types.ts` `PageType` union | Add decision, debug-trail, pattern, process, tool, goal, environment to the type union + `ALL_PAGE_TYPES`. Compile-time break without this | **HIGH (Tier 1)** |
| `src/core/markdown.ts` `inferType()` | Add developer directory-to-type mappings. Ordering: longest prefix first (decisions/ before projects/) for hybrid paths | **HIGH (Tier 1)** |
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
| Code/config patch | 4 | types.ts, markdown.ts, link-extraction.ts, _brain-filing-rules.json |
| Entrypoint edit | 1 | entrypoint.sh |
| Unchanged | 2 | _output-rules.md, brain-routing.md |
| **Total** | **13** | |

## Execution Order

1. **quality.md** first (root of delegation chain, every other file inherits)
2. **brain-ops/SKILL.md** second (the loop engine)
3. **signal-detector/SKILL.md** (detection layer)
4. **_brain-filing-rules.md** + **_brain-filing-rules.json** (filing taxonomy)
5. **RESOLVER.md** (routing table)
6. **brain-first.md** (retrieval conventions)
7. **link-extraction.ts** (auto-link code)
8. **types.ts** (PageType union — compile-time prerequisite for markdown.ts)
9. **markdown.ts** `inferType()` (longest-prefix ordering for hybrid paths)
10. **entrypoint.sh** (drop 2 irrelevant files, keep brain-routing.md)
11. Tier 2 code changes (doctor.ts) if time allows

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

## Architecture Compliance

Audited against `/workspaces/gbrain/docs/architecture/` (4 docs).

### system-of-record.md — REQUIRES FIXES

The FS-canonical contract says: markdown repo is the system of record, PGLite
is a derived cache. `gbrain sync && gbrain extract all` rebuilds the DB from
scratch. This spec's closed-loop diagram says "STORE = page lands in PGLite"
which is misleading. The correct flow is:

```
agent calls put_page -> markdown written to brain repo -> sync imports to DB -> extract rebuilds graph
```

The spec must NOT frame the DB as the primary store. All developer knowledge
follows the same FS-canonical contract as upstream: markdown is canonical,
DB is derived. The `put_page` MCP tool writes to the DB, but `gbrain export`
materializes pages as markdown (entrypoint.sh line 186 runs this every 2min),
and `gbrain sync` rebuilds from markdown. The rebuild invariant must hold:
wipe the DB, re-import from the brain repo, and all developer knowledge
(decisions, patterns, processes, etc.) regenerates identically.

Callout: the process page template's `---` separator before `## Timeline` must
be placed immediately before the heading to satisfy `markdown.ts`'s sentinel
detection (`<!-- timeline -->`, `--- timeline ---`, or `---` immediately before
`## Timeline`/`## History`). The template in this spec follows that convention.

**Action:** Update the closed-loop diagram phase 3 from "STORE - page lands in
PGLite" to "STORE - page materializes as markdown, DB rebuilt from repo."

### brains-and-sources.md — REQUIRES CLARIFICATION

This spec targets Topology 1: single brain, single source, single machine
(PGLite in a devcontainer). The developer directory taxonomy replaces the
default source's directory structure, not the brain or source axis. No new
brains or sources are created.

Codex flagged: even in Topology 1, the two-axis resolution contract still
exists. Saying `--brain` and `--source` are "irrelevant" is too strong.
The correct framing: the default resolution (`host` brain, `default` source)
handles this setup correctly without explicit flags. The axes exist but the
defaults are sufficient.

Codex also flagged: dropping `brain-routing.md` from the entrypoint removes
agent awareness of the source/brain axis entirely. Even for a single-brain
setup, the agent should understand the axis model in case the user adds a
second source later. **Decision: keep brain-routing.md in the entrypoint
but deprioritize it (no changes needed to its content).** This changes the
entrypoint from "drop 3 files" to "drop 2 files" (subagent-routing.md and
ask-user/SKILL.md only).

### infra-layer.md — REQUIRES ADDITIONAL CODE CHANGES

Search architecture (tsvector + pgvector + RRF) is content-based, not
type-based. Developer pages get identical search treatment. No conflict there.

However, Codex found a compile-time break the spec missed:

**`src/core/types.ts` PageType union.** The union type does NOT include
`decision`, `debug-trail`, `pattern`, `process`, `tool`, `goal`, or
`environment`. Adding these to `inferType()` in `markdown.ts` without updating
the `PageType` union in `types.ts` is a TypeScript compile error. This is a
Tier 1 blocker, not Tier 2.

**`inferType()` ordering for hybrid paths.** The hybrid taxonomy nests
`projects/my-app/decisions/` under `projects/`. If `inferType` checks
`/projects/` before `/decisions/`, nested decision pages get typed as
`project` instead of `decision`. The check order must be: longest prefix
match first (decisions before projects).

**Link relationship heuristics.** Adding directories to `DIR_PATTERN` enables
auto-link to CREATE edges, but `inferLinkType` classifies all developer
relationships as `mentions` (the default fallback). Functionally degraded
graph behavior, acceptable for v1 but should be noted as a known limitation,
not claimed as compliant.

### topologies.md — REQUIRES RECONCILIATION

Topology 1 (single brain on one machine). The devcontainer's entrypoint runs
`gbrain init` (PGLite) + `gbrain serve` (stdio MCP).

Codex flagged a contradiction: the spec's goal says "a new Claude agent in a
fresh devcontainer should be able to read the brain and repeat a development
process." That is a cross-environment portability claim. But the architecture
section says "no cross-machine concerns apply." These conflict.

The bridge is the system-of-record contract: the brain repo (git) is the
portable artifact. A fresh devcontainer runs `gbrain sync --repo ~/brain &&
gbrain extract all` and the DB rebuilds from the repo. The spec should state
this explicitly as the cross-environment reproducibility mechanism, rather
than claiming no cross-machine concerns exist.

### Changes required by architecture audit

Added to the change manifest:

| # | File | What changes | Tier |
|---|------|-------------|------|
| NEW | `src/core/types.ts` | Add developer types to `PageType` union and `ALL_PAGE_TYPES` | Tier 1 (compile-time break) |
| UPDATED | entrypoint.sh | Drop 2 files (not 3) — keep brain-routing.md | Tier 1 |
| UPDATED | `src/core/markdown.ts` `inferType()` | Moved from Tier 2 to Tier 1 — ordering matters for hybrid paths | Tier 1 |

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
