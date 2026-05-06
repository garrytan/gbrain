# Query Skill

Answer questions using MBrain's canonical retrieval flow: probe candidates,
read bounded canonical evidence, then synthesize.

## Workflow

1. **Probe context first** with `mbrain retrieve-context "<question>"` when the
   request needs a factual answer, broad synthesis, project/system context,
   personal recall, or historical evidence.
2. **Read canonical evidence** with `mbrain read-context --selectors '<json>'`
   using the `required_reads` returned by the probe.
3. **Answer only from canonical reads** unless the user asked only whether a
   term was mentioned. Search/query chunks are candidate pointers, not answer
   evidence.
4. **Use low-level search tools when debugging retrieval**:
   - Keyword search for specific names, dates, terms.
   - Semantic query for conceptual questions.
   - Structured queries, backlinks, and context maps for relational
     orientation.
5. **Synthesize answer** with citations. Every factual claim should trace to a
   canonical selector, page slug, section id, timeline entry, or source ref.
6. **Flag gaps.** If canonical reads do not support an answer, say what MBrain
   could not confirm instead of filling the gap.

## Direct Reads

When the user gives an exact selector, known slug, section id, source ref,
task id, profile-memory id, or personal-episode id, skip fuzzy discovery and go
directly to `mbrain read-context --selectors '<json>'`.

Use `mbrain get <slug>` only as the full-page escape hatch when the caller needs
the complete Markdown page or when selector-based reading is too narrow. It is
still a canonical read, but less bounded than `read_context`.

## Technical Concept Queries

When the user asks about architecture, mechanisms, implementation details, or
cross-system technical concepts:

1. Probe MBrain first:
   - `mbrain retrieve-context "<concept or system name>"`
   - `mbrain read-context --selectors '<required_reads json>'`
2. If an exact concept/system slug is already known:
   - `mbrain read-context --selectors '[{"kind":"compiled_truth","slug":"<slug>"}]'`
3. If a concept page has `codemap`:
   - read compiled truth for orientation
   - use the listed pointers for targeted code navigation
   - verify central pointers if `verified_at` is older than 30 days
4. If a concept page exists without `codemap`:
   - use the compiled truth as starting context
   - after code exploration, write back the missing pointers
5. If no concept/system page exists:
   - explore the codebase normally
   - create a `system` page and/or concept page with `codemap` before ending the task

Context maps, backlinks, graph paths, and codemaps are orientation. They tell
the agent which canonical pages or code files are worth reading; they are not
canonical truth for factual answer claims.

## Quality Rules

- Never hallucinate. Only answer from brain content.
- Cite sources: "According to concepts/do-things-that-dont-scale..."
- Flag stale results: if a search result shows [STALE], note that the info may be outdated
- For "who" questions, use backlinks and typed links to find connections
- For "what happened" questions, use timeline entries
- For "what do we know" questions, read compiled_truth directly

## Token-Budget Awareness

Search returns **chunks**, not full pages. Chunks are useful for recall, but
they can cut through meaning. Treat them as pointers to canonical reads.

- `mbrain search` / `mbrain query` return ranked candidate chunks.
- `mbrain retrieve-context` groups candidates and returns `required_reads`.
- `mbrain read-context` loads bounded canonical evidence for those selectors.
- **"Tell me about X"** -- read compiled truth and a small evidence sample.
- **"Did anyone mention Y?"** -- probe/search metadata can answer existence
  only when you explicitly label it as mention evidence, not canonical truth.

### Source precedence

When multiple sources provide conflicting information, follow this precedence:

1. **User's direct statements in the current interaction**
2. **Exact current artifact verified in the workspace or source system**
3. **Compiled truth** (the brain's synthesized, cited understanding)
4. **Timeline or source-record evidence**
5. **Operational memory with valid applicability anchors**
6. **Derived orientation artifacts** such as context maps, backlinks, graph
   paths, and codemaps
7. **Unreviewed candidates**

For coding agents, compiled truth and codemaps are starting context, not proof
of branch-sensitive code state. Verify current files, symbols, branches, or
external source systems before making present-tense code claims.

When sources conflict, note the contradiction with both citations. Don't silently
pick one.

## Citation in Answers

When referencing brain pages in your answer, propagate inline citations:
- Cite the page: "According to [Source: people/jane-doe, compiled truth]..."
- When brain pages have inline `[Source: ...]` citations, propagate them so
  the user can trace facts to their origin
- When you synthesize across multiple pages, cite all sources

## Mention And Existence Questions

For questions like "did anyone mention Y?" or "does MBrain have anything on X?",
you may answer from `retrieve_context`, `search`, or `query` metadata if the
answer is limited to existence, mention count, slug discovery, or "no candidate
found." Disclose that the answer is based on candidate/probe metadata and read
canonical context before making factual claims about what the mention means.

## Search Quality Awareness

If search results seem off (wrong results, missing known pages, irrelevant hits):
- Run `mbrain doctor --json` to check index health
- Check embedding coverage -- partial embeddings degrade hybrid search
- Compare keyword search (`mbrain search`) vs hybrid search (`mbrain query`)
  for the same query to isolate whether the issue is embedding-related
- Report search quality issues in the maintain workflow (see maintain skill)

## Tools Used

- Probe MBrain retrieval context (retrieve_context)
- Read bounded canonical context (read_context)
- Keyword search mbrain (search)
- Hybrid search mbrain (query)
- Read a page from mbrain (get_page)
- List pages in mbrain with filters (list_pages)
- Check backlinks in mbrain (get_backlinks)
- Traverse the link graph in mbrain (traverse_graph)
- View timeline entries in mbrain (get_timeline)
