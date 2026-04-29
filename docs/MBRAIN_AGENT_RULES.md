<!-- mbrain-agent-rules-version: 0.5.4 -->
<!-- source: https://raw.githubusercontent.com/meghendra6/mbrain/master/docs/MBRAIN_AGENT_RULES.md -->
# MBrain Agent Rules

MBrain is the durable knowledge layer for people, companies, concepts, internal
systems, meetings, projects, and the user's original thinking. Use it to make
answers context-aware and to keep durable knowledge compounding across sessions.

For detailed patterns, call `get_skillpack` with a section name or number
(examples: `enrichment`, `meeting`, `compiled-truth`, `19`).

---

## 1. Read First When MBrain Is Relevant

Before answering, check whether the user message mentions or depends on:

- a person, company, deal, meeting, project, or organization
- a technical concept, internal system, repo, architecture, or reusable code pattern
- the user's own idea, thesis, observation, product thought, or preference
- a cross-system or historical question that external search or raw grep cannot answer

If yes, read MBrain before responding. If the task is purely code editing, git
work, file management, public library documentation, or general programming,
only use MBrain when one of the triggers above is present.

## 2. Lookup Order

Use the lightest lookup that can answer the question:

1. `mbrain search "name"` - fast keyword lookup.
2. `mbrain query "what do we know about name"` - hybrid search when embeddings help.
3. `mbrain get <slug>` - direct page read when the slug is known.

Stop once you have enough context. Use web search, external APIs, or codebase
search only for gaps MBrain cannot answer.

## 3. Write Back Durable Knowledge

Write to MBrain when the conversation reveals durable knowledge:

- new facts about an entity, project, system, or decision
- the user's original wording for an idea, framework, thesis, or product thought
- reusable technical findings, especially code paths or architecture patterns
- corrections, contradictions, or resolved open questions

Do not write transient task mechanics, private chain-of-thought, or generic facts
that do not belong in the user's knowledge graph.

Do not write merely because a session is ending or a hook asked for a memory
check. If the session was purely code editing, git operations, file management,
library documentation, or general programming with no durable knowledge, skip
the write.

## 4. Filing Rules

- Original user thinking -> `brain/originals/{slug}.md`
- World concepts -> `brain/concepts/{slug}.md`
- Product or business ideas -> `brain/ideas/{slug}.md`
- Technical systems or repos -> `brain/systems/{slug}.md`
- Project-specific docs -> `brain/projects/<project>/docs/<specific-topic>.md`

Before creating a durable page, avoid vague or numeric-only slugs such as
`readme`, `docs`, `untitled`, `90`, or `123`. Ask for clarification if the
identity is unclear.

## 5. Page Structure And Evidence

Every brain page uses two zones separated by `---`:

- Above the line: compiled truth, rewritten as the current best understanding.
- Below the line: reverse-chronological timeline, append-only evidence.

Every factual claim written to MBrain needs source attribution:
`[Source: User, direct message, YYYY-MM-DD HH:MM TZ]`

If sources conflict, record the contradiction instead of silently choosing one.
The user's direct statements outrank other sources.

## 6. Backlinks And Sync

Every entity mention must be bidirectionally linked. When page A mentions page B,
page B's timeline should link back to page A with context:
`- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- context`

After creating or updating any brain page, sync immediately:

Call `sync_brain` with `no_pull: true` and `no_embed: true`.

Embeddings can refresh later in batch.
