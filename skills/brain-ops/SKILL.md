---
name: brain-ops
version: 1.2.0
upstream: brain-ops@fc834ee
description: |
  Brain knowledge base operations. The core read/write cycle: brain-first lookup,
  read-enrich-write loop, source attribution, ambient enrichment, back-linking.
  Read this before any brain interaction.
triggers:
  - any brain read/write/lookup/citation
tools:
  - recall
  - search
  - query
  - get_page
  - put_page
  - add_link
  - add_timeline_entry
  - get_backlinks
  - sync_brain
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - deals/
  - concepts/
  - meetings/
---

# Brain Operations — The Ambient Context Layer

Recall relevant context before responding. Save explicit requests with
provenance; automatic capture is off until the user opts in. Reading this skill
does not enable capture, delegation, or paid enrichment. A chat-only instruction
suppresses writes for that turn, including when standing capture is enabled.

> **Convention:** See `skills/conventions/brain-first.md` for the lookup chain and copyable retrieval filters.
> **Convention:** See `skills/conventions/quality.md` for citation and back-link rules.

## Contract

This skill guarantees:
- Brain is checked BEFORE any external API call (brain-first lookup)
- Explicit save requests and opted-in inbound signals trigger the READ → WRITE
  loop; enrichment requires its separately configured authority
- Every outbound response checks brain for relevant context
- Source attribution on every fact written (inline `[Source: ...]` citations)
- User's direct statements are highest-authority data
- Back-links maintained on every brain write (Iron Law)

**Iron Law:** every mention of a person or company with a brain page gets a
back-link FROM that entity's page TO the page mentioning them.

## Read

Before any external lookup of a person, company or topic:

1. `gbrain entity "<name>"` — one call for a known entity: description,
   aliases, open threads, recent events, edges. Near-misses return suggestions.
2. `gbrain search "name"` for exact tokens; `gbrain query "question"` for
   concepts (a nonzero `search` count is not proof of completeness).
3. `gbrain get <slug>`, `gbrain backlinks <slug>`, `gbrain timeline <slug>`.
4. `gbrain think "<question>"` only for paid multi-page synthesis ("what
   changed since Q1"); `query` is enough to find a page.

External APIs fill gaps; they never start the lookup. Answer from the brain
page when one exists, and cite it.

**Count with gbrain, not `ls`.** Corpora nest (`meetings/YYYY/MM/` beside a
flat layer), so a shallow `ls dir/*.md` undercounts. Use `gbrain sources list`,
`gbrain list --type <t>`, or `find <dir> -name '*.md' | wc -l`.

## Write (only when authorized)

Write for an explicit save request, or a message inside the user's opted-in
capture scope with no chat-only restriction. Otherwise use the information in
this conversation without persisting it; explicit remembering does not enable
ongoing capture.

1. Detect entities; read their pages first. Before creating a page, check for
   it (`gbrain entity`, then `query` with name variants) — never duplicate.
2. Write only what is new, with `[Source: User, YYYY-MM-DD]` (or the real
   source) on each fact, plus a timeline entry
   (`gbrain timeline-add <slug> <date> "<text>"`) on every entity involved.
3. Never overwrite the user's direct statements with lower-authority sources.
4. Confirm a write only after reading it back.

**Memory verbs (MEMORY_VERBS v1).** `remember(fact, provenance)` saves one formed
fact (CLI: `gbrain remember "<fact>" --entity <slug> --provenance "<who, date>"`);
`recall`, `entity`, `synthesize`, `context_pack` and `delta` read.
`forget(id)` (`gbrain forget <fact-id>`) withdraws a fact from active memory;
history, source material and backups may remain, so never promise erasure.
`put_page` / `add_link` / `add_timeline_entry` stay the page and graph path.
Contract: `docs/protocol/MEMORY_VERBS_v1.md`.

**Keyless brains:** when `extract_facts` returns `skipped: extraction_unavailable`
(or `extraction_failed` for one turn), you are the extractor: write each fact
with `remember`, setting `kind` (event | preference | commitment | belief |
fact) and the visibility the envelope's `agent_action` names (default private;
`remember` defaults to world).

**Visibility.** Every MCP caller (stdio included) and a thin CLI recall and
withdraw world-visible facts only; private recall needs the trusted local CLI.
Never widen visibility or request broader OAuth scopes to make a check pass.
An MCP connection test uses only a harmless synthetic `visibility: "world"`
fact, withdrawn afterward.

**`<REDACTED:pattern>`** in a result means the brain withheld a credential-shaped
value; the page is unchanged and `gbrain recall` on the brain host shows it.
Say which kind was withheld; never retry to recover it or guess it.

**Tight-budget page questions:**
`gbrain recall --query '<q>' --budget-tokens 75 --budget-policy query_first --json`
packs page evidence before recent facts (`skills/query/SKILL.md`). Read
`budget_packing` before calling an empty result missing memory.

### Auto-link

Trusted local writes (`gbrain put`, `gbrain capture`, `gbrain call put_page`)
auto-link inline and return `auto_links: { created, removed, errors }`. MCP
writes (stdio and HTTP) return `auto_links: { skipped: "remote" }`: body
wikilinks are saved as text and a post-commit effect queues plain `mentions`
edges to existing pages (`gbrain config set mcp.remote_auto_links off` turns it
off). Typed, frontmatter and timeline edges wait for a sweep: stdio
`gbrain serve` runs one at startup and when idle; `gbrain serve --http` does not self-sweep, so run
`gbrain sweep --once` or `gbrain extract links --source db`. Use `add_link` for
a relationship you need now, except meeting attendance, which comes from the
meeting page's attendee list. Dated events still need `gbrain timeline-add`.
`gbrain config set auto_link false` disables auto-link.

## Enrichment

External research, paid calls and delegation need their own authority: an
explicit enrichment request or the user's stored scope and spending policy. A
mentioned entity, a shared link or capture opt-in is not that authority. Never
block the response on enrichment.

## Output Format

Answer with the retrieved context and cite it. With several sources, cite
`[source-id:slug]` using the `source_id` every page payload carries (never the
source's display name); a single-source brain may write `[default:slug]` or the
bare slug. Confirm authorized writes only after readback; if no write was
requested or opted in, do not persist the conversation to produce a memory update.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- `revision_conflict`: re-read, merge your change into the new text, save with the new revision. `write_pending` (exit 10): poll `gbrain write-request <request_id>` before claiming the write landed.
- `owner_unavailable` with `detail: unbound_source` (classic Postgres brain): write the file in the source's checkout, commit, and run `gbrain sync --source <id>`; if you are remote, give the user those steps. Never claim the source or switch modes (see the [agent operator protocol](../conventions/agent-operator-protocol.md#a-write-refused-owner_unavailable-with-detail-unbound_source)).
- `permission_denied` from the secret scan or a slug fence: do not strip or rename to dodge it; tell the user what was refused and why (`docs/guides/write-refusals.md`).
- Empty `recall` / `search` with a degraded notice or `search_degraded`: say the brain is searching keywords only right now, not that nothing is saved.
- `insufficient_scope` / `scope_denied` over MCP: tell the user; never ask for a broader token to make a write pass.

## Anti-Patterns

- Answering about people or companies from general knowledge, or calling external APIs, before checking the brain
- Writing facts without `[Source: ...]`, or without the back-links and timeline entries
- Creating a duplicate page, or a page for a non-notable entity
- Writing to the brain without a save request or capture opt-in
- Promising that `forget` erases a fact everywhere
