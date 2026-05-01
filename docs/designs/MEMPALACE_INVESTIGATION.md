# Mempalace Investigation: What to Steal, What to Skip

Investigated 2026-04-07. Source: [milla-jovovich/mempalace](https://github.com/milla-jovovich/mempalace).

Mempalace achieved 96.6-100% on LongMemEval (highest published score, free or paid).
Uses ChromaDB + SQLite locally. GBrain uses Postgres + pgvector on Supabase.

## TL;DR

GBrain + OpenClaw already delivers 90% of what mempalace offers, through a better
architecture: LLM-driven skills instead of regex heuristics, compiled truth instead
of raw conversation dumps, and Postgres instead of ChromaDB.

**Ship one thing:** search boosting (keyword overlap + temporal). Three files, zero
schema changes, measurable retrieval improvement.

**Build one thing:** an eval set to measure retrieval quality before and after.

**Skip the rest.** The triples table, conversation mining, entity detection, and
agentic retrieval are all things the OpenClaw agent already does through skills.
Building them into core would be a downgrade from LLM intelligence to regex heuristics.

## What mempalace does

- **Palace Structure:** Wings (domains), halls (memory types), rooms (specific ideas),
  drawers (individual memories). Spatial metaphor for organizing conversations.
- **AAAK Compression:** 30x compression dialect (entity codes, emotion markers, key
  quotes). Loads months of context in ~120 tokens.
- **Verbatim Storage:** Stores raw conversation text, no LLM extraction. This is why
  it scores so high on LongMemEval: no information lost.
- **Knowledge Graph:** SQLite triples with temporal validity (valid_from/valid_to).
  Entity registry with disambiguation for common names.
- **Conversation Mining:** 16 regex patterns classify text into decisions, preferences,
  milestones, problems, emotional context.
- **Entity Detection:** Two-pass pipeline. Pass 1: find capitalized sequences. Pass 2:
  signal-based classification (person verbs, project verbs).
- **Search Boosting:** Keyword overlap (+1.2%), temporal proximity (+0.6%), preference
  synthetic docs (+1.8%), LLM rerank (+0.4%). Together: 96.6% to 100%.
- **MCP Server:** 19 tools including diary, graph traversal, tunnel detection.

## What GBrain already has that mempalace doesn't

| Capability | GBrain | Mempalace |
|-----------|--------|-----------|
| Compiled truth (editable synthesis) | Yes | No (raw text only) |
| Timeline (append-only evidence) | Yes | No |
| Hybrid search (RRF fusion) | Yes | Basic vector only |
| Multi-query expansion (Haiku) | Yes | No |
| 4-layer dedup pipeline | Yes | No |
| 3-tier chunking (recursive, semantic, LLM) | Yes | Exchange-pair only |
| Postgres + pgvector (production-grade) | Yes | ChromaDB (local) |
| Agent-driven enrichment | Yes (skills) | No |
| Dream cycle (overnight maintenance) | Yes (OpenClaw) | No |
| Version history | Yes | No |
| File storage + migration | Yes | No |
| Page types + tags + links | Yes | Wings/rooms |

GBrain's compiled truth model is strictly more expressive than mempalace's raw
storage. Mempalace stores everything verbatim because that's all it has. GBrain
separates signal (compiled truth) from evidence (timeline). Both are searchable.

## Feature-by-feature assessment

### DO: Search Boosting
**Status: Not yet in GBrain. Ship this.**

Mempalace measured concrete retrieval gains:
- Keyword overlap boost: +1.2% (Jaccard word overlap between query and chunk)
- Temporal boost: +0.6% (results near a target date score higher)
- LLM rerank: +0.4% (Haiku reorders top-10, opt-in only)

Implementation: extend `src/core/search/hybrid.ts`. Add boosting functions between
`rrfFusion()` and `dedupResults()`. Add `getPageDates()` batch method to engine for
temporal boost. Three files changed, zero schema changes.

The keyword overlap boost is especially interesting because GBrain's keyword search
ranks at the page level, then joins chunks. Chunk-level overlap boosting would help
surface the most relevant chunk, not just the most relevant page.

### DO: Build an Eval Set
**Status: Not yet in GBrain. Do this before any search changes.**

Mempalace's biggest advantage isn't their code, it's their benchmarks. They can
prove their retrieval works. GBrain can't. Before shipping search boosting, build
a corpus of 50-100 queries against the real brain with expected results. Measure
R@5 before and after. This is how you know if changes help.

### SKIP: Knowledge Graph (Triples Table)

The CEO review designed a full triples table with temporal validity, contradiction
detection, and entity dossier commands. After seeing GBrain in production with
OpenClaw, the assessment changed.

**Why skip:** Compiled truth pages ARE your knowledge graph. "Pedro Franceschi
co-founded Brex in 2017" lives in the compiled truth of `people/pedro-franceschi`.
The agent maintains this through skills. A triples table would store the same
information in a less expressive format (subject-predicate-object vs. prose).

**When to revisit:** If you need queries like "who co-invested in companies that
Pedro also invested in?" that require multi-hop graph traversal across structured
relationships. Today's `traverseGraph()` + links table handles simple cases. If
you hit a query that compiled truth can't answer, then build triples.

### SKIP: Conversation Mining

Mempalace uses 16 regex patterns to extract decisions, preferences, milestones from
conversations. GBrain's agent already does this with full LLM understanding through
the ingest skill. The dream cycle processes every conversation overnight.

Regex mining would be a downgrade. Claude understands "we should probably go with
Postgres" as a decision. A regex looking for "let's use" would miss it.

### SKIP: Entity Detection (in core)

The SKILLPACK already instructs the agent to detect entities on every message,
create pages, and add cross-reference links. Moving this to regex-based detection
in `src/core/entity-detect.ts` would be less accurate than LLM-based detection.

### SKIP: Preference Synthetic Documents

Codex outside voice correctly identified this as "corpus pollution." GBrain's
query expansion (Haiku generates alternative phrasings) already bridges vocabulary
gaps at query time without adding LLM-generated fake chunks to the index.

### SKIP: AAAK Compression

GBrain's MCP tool pattern provides on-demand access. The agent doesn't need to
load the entire brain into context; it searches for what it needs.

### SKIP: Palace Structure (Wings/Halls/Rooms)

GBrain's type + tag + link system provides equivalent organization without
the spatial metaphor overhead.

### SKIP: Agentic Retrieval

The 3-strategy pipeline (hybrid, entity-scoped, temporal-scoped) is the most
ambitious piece. But GBrain's hybrid search + query expansion already outperforms
Mem0 (49%) and Zep (63.8%) on multi-hop queries. Build this when you have eval
data showing the current pipeline is the bottleneck.

### DEFER: Temporal Diff (`gbrain diff --since`)

Useful convenience command. "What changed since Tuesday?" can already be answered
by querying timeline entries, but a dedicated diff command makes it faster.
Low effort (one new CLI command), but not urgent.

### DEFER: Wake-up Context Endpoint

Compressed brain summary for MCP startup. Needs the brain to be populated with
real data first. Revisit after 3 months of production use.

## What we learned from the CEO + Eng + Codex review process

The full review cycle (CEO review, eng review, 2 Codex outside voices) produced
valuable architectural insights even though the features themselves aren't needed:

1. **Mining should be stateless MCP tools, not embedded in importFile().** Core
   provides primitives, skills contain intelligence. This keeps the binary thin.

2. **Triples should use page_id FK + denormalized slug** if ever built. Slug-only
   references drift on rename.

3. **Subject of a mined fact is the extracted entity, not the page.** Meeting notes
   are containers, not subjects. Facts in a meeting are about the entities discussed.

4. **ON DELETE SET NULL for knowledge graph FKs**, not CASCADE. Triples should
   survive page deletion.

5. **Synthetic docs = corpus pollution.** Query expansion solves the same vocabulary
   gap problem without weakening provenance.

6. **aliases column on pages, not a separate entity_registry table.** Reuse existing
   infrastructure, avoid reconciliation problems.

These decisions are documented in the CEO plan at
`~/.gstack/projects/garrytan-gbrain/ceo-plans/2026-04-07-mempalace-knowledge-graph.md`
and can be pulled forward if the features are ever built.

## Action items

1. **Ship search boosting** in `src/core/search/hybrid.ts`:
   - Keyword overlap: `score *= (1.0 + 0.30 * jaccard_overlap)` after RRF fusion
   - Temporal: optional `targetDate`, boost results near that date up to 40%
   - LLM rerank: optional, Haiku reorders top-10, opt-in only
   - Add `getPageDates(slugs)` batch method to engine interface

2. **Build eval set:** 50-100 queries with expected results from the real brain.
   Measure R@5 before and after search boosting.

3. **Monitor:** If retrieval quality becomes a bottleneck at scale (10K+ pages),
   revisit triples table and agentic retrieval with eval data in hand.
