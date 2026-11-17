---
type: concept
title: Compiled Truth
tags:
  - architecture
  - brain-design
---

# Compiled Truth

The two-layer page pattern used throughout Foresights. Every page has two distinct
sections separated by a horizontal rule (`---`):

1. **Compiled truth** (above the line) — The current, canonical understanding of the
   subject. This section is rewritten and updated as new information arrives. It
   represents the latest synthesized knowledge, not a historical record.

2. **Timeline** (below the line) — An append-only log of evidence, observations, and
   events. New entries are added at the bottom. Old entries are never modified or
   deleted. Each entry is timestamped and captures what was known or observed at that
   moment.

## Why This Pattern

Traditional note-taking creates a "pile of pages" problem: information about a topic
is scattered across meeting notes, emails, and documents. Finding the current state
requires re-reading everything and mentally synthesizing.

Compiled truth solves this by maintaining a living summary that is always current.
The timeline preserves the evidence trail so you can always trace how understanding
evolved and verify claims against primary observations.

## Rules

- The compiled truth section is the single source of truth for "what do I currently
  believe about this topic."
- When new information contradicts existing compiled truth, update the compiled truth
  and add a timeline entry explaining the change.
- Timeline entries are immutable once written. They capture point-in-time observations.
- The compiled truth section should be readable on its own without needing to read the
  timeline.
- Cross-reference other entities by name (e.g., "Sarah Chen" not `[Sarah Chen](...)`)
  to enable search-based discovery.

## Relationship to RAG

Foresights uses retrieval-augmented generation (RAG) to surface relevant pages during
queries. The compiled truth pattern means retrieved pages contain pre-synthesized
knowledge rather than raw fragments. This produces higher quality answers because the
LLM receives curated context rather than scattered notes.

This is a deliberate design choice: do the synthesis work at write time (when you have
full context) rather than at read time (when the LLM must guess at connections).

---

## Timeline

### 2025-02-10 — Pattern Formalized

Adopted the compiled truth + timeline pattern after experimenting with several
knowledge management approaches. Wiki-style pages lost temporal context. Pure
journaling created information sprawl. The two-layer approach preserves both the
current understanding and the evidence trail.

### 2025-03-01 — Applied to All Page Types

Extended the pattern to all Foresights page types: people, companies, deals, meetings,
concepts, projects, and sources. Each type uses the same two-layer structure with
type-specific frontmatter fields. This consistency enables uniform search and
retrieval across all knowledge categories.
