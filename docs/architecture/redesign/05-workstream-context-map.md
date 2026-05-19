# MBrain Redesign Context Map Workstream

This document defines the Graphify-inspired derived map layer for `mbrain`. It owns deterministic structural extraction, the Note Manifest, Context Map, Context Atlas, and the orientation artifacts used to narrow and explain retrieval. It does not define review, promotion, contradiction, or candidate-governance mechanics; those belong to `06-workstream-governance-and-inbox.md`. It also does not redefine operational task-memory lifecycles owned by `04-workstream-operational-memory.md`.

## Scope

This workstream exists to make large note, code, and source corpora navigable without turning maps into canonical truth.

It owns:

- deterministic extraction from canonical sources into derived structural artifacts
- `Note Manifest` as the reproducible structural index over canonical notes and related Markdown artifacts
- `Context Map` as the scope-bounded derived graph overlay for notes, code, tasks, procedures, and evidence
- `Context Atlas` as the registry and orientation layer over multiple maps
- map-facing query behavior such as `query`, `path`, `explain`, and neighbor exploration
- generated orientation artifacts such as map reports, workspace maps, and project or corpus cards
- freshness, staleness, and refresh rules for derived map artifacts

It does not own:

- Memory Inbox lifecycle or promotion scoring beyond exposing extraction metadata that governance can consume later
- Task Thread, Working Set, Attempt, Decision, or procedure lifecycles beyond reading them as canonical inputs
- a canonical fact graph as an MVP replacement for curated Markdown

The governing constraint is simple: maps may make retrieval smarter, but they remain derived and regenerable. They help the system decide where to look; they do not become the thing the system knows.

## Deterministic Extraction Inputs

The map layer starts from canonical artifacts that already exist elsewhere in the architecture. Extraction is deterministic when the same source set, scope, and extractor version produce the same structural output.

Canonical inputs for deterministic extraction are:

| Input | Why It Matters to the Map Layer | Ownership of the Input |
|---|---|---|
| Curated Notes | Provide titles, aliases, tags, wikilinks, outbound URLs, heading structure, and source references. | Canonical knowledge in `01`. |
| Markdown Procedures | Add stable operating documents, trigger patterns, and known pitfalls to orientation. | Procedure ownership in `04`. |
| Source Records | Supply provenance handles, source identities, and raw artifacts that notes or map nodes may point back to. | Canonical provenance in `01`. |
| Task Thread and Working Set references | Allow task-scoped maps to index active files, symbols, decisions, and linked procedures without redefining operational memory behavior. | Operational memory in `04`. |
| Attempt and Decision references | Allow task maps to surface rationale, dead ends, and choice points as orienting nodes. | Operational memory in `04`. |
| Source-linked note metadata and verified code references | Provide aliases, source-linked identities, and note-to-code anchors that canonical artifacts already expose through curated notes, Source Records, and linked code references. | Canonical sources defined in `01`. |

Deterministic extraction must prefer directly readable structure over semantic guesswork. Examples include:

- Markdown path, slug, title, and frontmatter
- heading hierarchy and anchors
- wikilinks, backlinks, and outbound URLs
- explicit source references or evidence handles
- declared aliases, tags, and registry links
- pinned files, symbols, and procedures already linked from canonical records

The map layer may later host richer semantic analysis, but the baseline artifact for this workstream is structural first. If an extractor step cannot be explained as a deterministic function of canonical input plus extractor version, it should not be treated as part of the base Note Manifest pipeline.

## Note Manifest Model

The `Note Manifest` is the derived structural index built from canonical Markdown-oriented inputs. It is the most important input to later map builds because it converts notes into a reproducible, queryable structural surface before graph assembly begins.

Each manifest entry should capture at least:

| Field | Purpose |
|---|---|
| `scopeId` | Binds the entry to a concrete retrieval and build scope. |
| `path` and `slug` | Give stable identity inside the note corpus. |
| `title` | Supplies the primary human-readable label. |
| `frontmatter` | Preserves structured metadata already authored canonically. |
| `aliases` and `tags` | Support navigation, matching, and canonicalization. |
| `outgoingWikilinks` and `outgoingUrls` | Provide explicit structural edges without inference. |
| `sourceRefs` | Preserve provenance handles that later map nodes can cite. |
| `headingIndex` | Enables heading-level entry points and path explanations. |
| `contentHash` | Detects change without re-reading semantic meaning. |
| `lastIndexedAt` | Supports freshness and rebuild policy. |

Manifest rules:

1. The manifest is derived and fully regenerable from canonical inputs.
2. Structural extraction is preferred over semantic interpretation.
3. Content hashes are used for change detection, not truth claims.
4. The manifest must preserve enough structure that map builds can explain why a note or heading appeared in a subgraph.
5. Manifest generation should be scope-aware from the start instead of assuming one giant global corpus.

The Note Manifest does not decide whether an inferred relationship should be promoted or rejected. It simply preserves the structural inputs needed for map assembly and later review.

## Context Map Model

The `Context Map` is the scope-bounded derived graph overlay built from the Note Manifest and other approved structural inputs. It is how `mbrain` adopts Graphify-style orientation without turning a graph into canonical memory.

A Context Map should carry top-level metadata such as:

| Field | Purpose |
|---|---|
| `id` and `scopeId` | Identify the map and the scope it belongs to. |
| `kind` | Distinguishes workspace, project, repo, corpus, topic, task, or personal maps. |
| `title` | Gives a human-readable orientation label. |
| `sourceSetHash` | Captures which canonical inputs the map was built from. |
| `extractorVersion` | Makes rebuilds and staleness explainable. |
| `buildMode` | Distinguishes structural, semantic, or deeper analysis builds. |
| `status` | Tracks whether the artifact is building, ready, stale, or failed. |
| `reportPath` and `graphJsonPath` | Point to derived orientation outputs. |
| `nodeCount`, `edgeCount`, `communityCount` | Support introspection and evaluation. |
| `generatedAt` and `staleReason` | Expose freshness and degradation cause. |

Map content should be organized around derived nodes and edges:

| Element | Allowed Role |
|---|---|
| Node | Represents notes, headings, concepts, papers, code files, code symbols, tasks, attempts, decisions, procedures, sources, or rationale anchors. |
| Edge | Represents a structural or explanatory relationship between nodes. |
| Extraction metadata | Captures whether the node or edge was extracted, inferred, or ambiguous within the derived map build. |
| Confidence metadata | Helps map queries rank and explain structural certainty without declaring canonical truth. |
| Source location metadata | Points back to the canonical artifact or source location that justified the node or edge. |

Map-model rules:

1. Scope is mandatory. `mbrain` does not build one giant graph for everything.
2. Structural edges are preferred in the early design because they are easier to verify and rebuild.
3. Map nodes and edges may expose extraction kind and confidence, but those signals remain advisory until the governance layer reviews any durable claim.
4. Task-scoped maps may include task, attempt, decision, and procedure nodes when those objects are already canonical inputs, but this document does not redefine how those objects are created or updated.
5. A Context Map can be deleted and rebuilt without loss of canonical truth.

The Context Map is therefore an orientation object, not a fact store.

## Context Atlas Model

The `Context Atlas` is the registry and coordination layer over multiple Context Maps. It exists because useful orientation usually spans more than one map, but retrieval still needs a compact way to discover which maps matter.

The atlas should index:

- a small global workspace map
- project maps
- repo maps
- topic or corpus maps
- task maps
- personal maps, if they exist and later scope checks allow them

An atlas entry should include:

| Field | Purpose |
|---|---|
| `mapId` | Links the atlas entry to a concrete Context Map. |
| `scopeId` and `kind` | Explain when the map is eligible for use. |
| `title` | Gives a concise orientation label. |
| `summaryCardPath` | Points to a compact project, corpus, or map report artifact. |
| `freshness` | Indicates whether the atlas entry should be trusted for routing. |
| `entrypoints` | Names the most useful bridge nodes, major communities, or anchor notes. |
| `budgetHint` | Suggests how much of the map is safe to load into an answer-time prompt. |

Atlas rules:

1. The global workspace map must stay intentionally small and orienting rather than encyclopedic.
2. Project and corpus cards should be compact enough to explain purpose, key entry points, active tasks, and known pitfalls without dumping raw inventories.
3. The atlas is for routing and overview, not for storing canonical summaries that should live in notes.
4. Personal atlas entries may exist, but they are only visible when the scope rules in `07-workstream-profile-memory-and-scope.md` allow them.

## Map Query Behaviors

Map behavior should follow the routing rules from `02-memory-loop-and-protocols.md`: broad synthesis may use maps for orientation, exact lookup should prefer direct canonical sources, and task resume should remain anchored in operational memory before any map expansion.

The map layer should support four primary behaviors:

| Behavior | Expected Output | Boundary |
|---|---|---|
| `query` | A focused subgraph or ranked cluster of relevant nodes and edges under a budget. | Should narrow search space, not answer as truth by itself. |
| `path` | A path explanation between two nodes or concepts, including why the bridge is interesting. | Must point back to canonical artifacts or source locations. |
| `explain` | A local neighborhood explanation for a node, including communities, bridge nodes, and relevant entry points. | Must disclose extraction kind and confidence where relevant. |
| `neighbors` or local expansion | A bounded set of adjacent nodes and relation labels for exploration. | Must stay bounded and scope-aware. |

Behavioral rules:

1. Output should include node labels, relation types, and source handles where available.
2. Map output should disclose when it is surfacing structural extraction versus an inferred bridge.
3. Query budgets matter. The map layer should return focused orientation rather than dumping whole graphs into prompts.
4. Broad questions may use map reports or atlas cards before focused map operations.
5. Exact lookup should skip map reports when a direct canonical artifact is already known.
6. Task resume may consult task-relevant map output only after Task Thread and Working Set context is loaded.
7. Personal maps are only queryable when the active scope gate has already allowed personal retrieval.

The success condition for map behavior is not "graph output exists." It is "retrieval becomes more targeted and explainable while canonical truth remains upstream."

## Map Report and Orientation Artifacts

The map layer should produce compact, human-readable orientation artifacts in addition to machine-facing graph structures.

Primary artifacts are:

| Artifact | Purpose |
|---|---|
| Workspace Map | Small top-level orientation over important brain roots, active projects, current task scopes, and boundary markers. |
| Project or Corpus Card | Mid-sized summary for a project, repo, or corpus, including architecture or purpose, entry points, build or test commands, active task links, and known pitfalls. |
| Context Map Report | Broad-question orientation artifact describing major communities, bridge nodes, surprising connections, and recommended next reads. |
| Focused Subgraph | Answer-time bounded graph context used by map query, path, or explain operations. |

Artifact rules:

1. Workspace artifacts should stay intentionally concise and avoid full file or note dumps.
2. Project and corpus cards should bridge the gap between raw system pages and giant graph outputs.
3. Context Map Reports are for synthesis and orientation; they should be skipped for exact lookup when direct sources are better.
4. Reports should highlight communities, bridge nodes, important entry points, stale warnings, and open gaps worth investigating.
5. Reports may suggest candidate questions or note-update opportunities, but they do not own the candidate review lifecycle.

These artifacts should make the system legible to both humans and agents. They are successful when they shorten the distance from a broad question to the right canonical artifacts.

## Staleness and Refresh Rules

Because maps are derived, freshness is managed through rebuild policy rather than by manual truth repair.

A Context Map becomes stale when one or more of the following changes materially:

- a note content hash changes
- note links or heading structure change
- a task thread changes significantly enough to alter a task-scoped map
- a procedure document changes
- a codemap pointer, code file anchor, or relevant branch or commit reference changes
- the source set changes
- the extractor version changes

Refresh rules:

1. Markdown or link-only changes should trigger structural map refresh immediately or on the next sync boundary.
2. Code-only changes should refresh code-aware extraction when configured; otherwise the code-related map should be marked stale rather than silently trusted.
3. Task-event changes may trigger partial refresh for task maps instead of full rebuild.
4. Semantic or heavier analysis may be staged for background refresh while keeping the structural map available.
5. When freshness cannot be re-established quickly, the system should degrade by warning and falling back to canonical notes plus focused source reads.

Freshness metadata must stay explicit:

- `sourceSetHash`
- `extractorVersion`
- `generatedAt`
- `staleReason`
- last successful report generation time

Staleness is a retrieval-quality problem, not a truth corruption problem. The correct failure mode is loss of map utility, not loss of canonical knowledge.

## Personal Corpus Lane Metadata Contract

`gbrain` sources are an important reference for separating corpora. `mbrain`
uses the idea as personal corpus lane metadata, not as a second scope system.

A corpus lane is not a scope. Corpus lanes are source and artifact metadata inside an already resolved scopeId.

Corpus lanes never replace Source Records, imported-artifact boundaries, retrieval traces, or Scope Gate decisions.

Lane metadata may identify:

- imported note corpus
- active worktree corpus
- transcript corpus
- raw import or source-evidence corpus
- derived context-map or atlas corpus

Lane rules:

1. The Scope Gate resolves work, personal, mixed, or unknown before any lane
   resolver runs.
2. A lane may narrow source-set hashes, derived refresh sets, citations, and
   import provenance.
3. A lane may not grant read or write authority.
4. A lane may not copy work-only data into personal memory or personal data into
   work memory.
5. Context maps may record lane metadata on nodes and source-set hashes only as
   derived orientation.
6. Lane-aware retrieval must still map evidence back to Source Records and
   import origins before making factual claims.

## GA-P3 Corpus Lane Runtime Contract

Corpus lanes are post-scope metadata only. They decorate existing imports,
selectors, reads, citations, and retrieval traces after the Scope Gate has
allowed the request.

Runtime rules:

1. Corpus lanes do not create scopes, authority labels, storage roots, or schema
   tables.
2. Import projections preserve page frontmatter lane refs on manifest and
   section `source_refs`.
3. `retrieve_context` and `read_context` may return `corpus_lane` metadata and
   lane source refs only alongside canonical selectors and source evidence.
4. `selector_id` and `retrievalSelectorId` stay stable; selector ids do not
   include lane ids.
5. Retrieval traces may include `corpus_lane:*`, `source_record:*`, and
   `import_origin:*` refs as provenance, plus verification entries that mark
   the lane as post-scope metadata.

## Code Lane Derived Artifact Contract

`reference/gbrain` proves that code-aware retrieval needs more than symbol
names. `mbrain` may add a Context Map code lane only when the derived layer can
track indexing prerequisites, backfill, invalidation, and bounded expansion.

Required code-lane metadata:

| Field | Purpose |
|---|---|
| `source_ref` | Canonical evidence or workspace source for the indexed code. |
| `repo_path` | Workspace root used for live verification. |
| `content_hash` | Detects stale extracted symbols. |
| `extractor_version` | Forces reindex when chunking or symbol extraction changes. |
| `symbol_id` | Stable derived identifier for a symbol node. |
| `edge_kind` | Distinguishes call, reference, import, declaration, or containment edges. |
| `verification_hint` | Records what live check is needed before a current code claim is repeated. |

Code-lane rules:

1. Symbol nodes and edges are derived orientation, not current code truth.
2. Current code claims still require live path, symbol, branch, and test
   verification.
3. Graph expansion is opt-in until evaluation proves it improves code retrieval.
4. High-fan-out symbols need explicit caps and bounded output.
5. Every extractor or chunker version change needs a reindex and invalidation plan before the new graph can influence retrieval.
6. Code-lane retrieval must keep `rg`, exact file reads, and direct workspace
   verification available as higher-authority current evidence.

## GA-P5 Code Lane Runtime Contract

GA-P5 makes the code lane executable as a Context Map entry while preserving the
same authority boundary. Code-lane runtime entries are derived orientation, not current code truth.

Runtime requirements:

1. Each code-lane entry records `authority: "derived_orientation"` and must not
   grant answer authority, write authority, or candidate-promotion authority.
2. Chunk-grain metadata is required before graph-walk retrieval can become default.
3. Symbol graph expansion is opt-in, depth-limited, fanout-capped, and bounded.
4. Extractor/chunker version changes must invalidate or rebuild derived code-lane artifacts.
5. Current code claims require live file, symbol, branch, and content-hash verification.
6. `definition_lookup`, `references_lookup`, `callers_lookup`, `callees_lookup`,
   and `nearby_context` may orient the agent, but the agent must still verify
   current code with direct workspace reads or `reverify_code_claims`.

## Tests and Evaluation

This workstream needs both correctness tests and utility evaluation.

Required test areas:

- deterministic extraction reproducibility for identical source sets and extractor versions
- manifest coverage tests for titles, aliases, tags, wikilinks, headings, and source references
- scope-bounded map build tests to confirm one scope cannot silently absorb another
- node and edge provenance tests so map outputs can point back to canonical artifacts
- atlas registry tests for workspace, project, corpus, task, and personal map discoverability
- query, path, explain, and neighbor tests for bounded output and stable explainability
- stale detection and refresh tests for note, task, procedure, code, and extractor-version changes
- fallback behavior tests confirming the system degrades to canonical notes and focused source reads when maps are stale or missing

Required evaluation questions:

- Does the map layer reduce the amount of raw search needed for broad synthesis?
- Do map reports help agents identify the right notes, procedures, or source records faster?
- Are map outputs staying compact enough to be useful at answer time?
- Is stale-map detection preventing false confidence in changed code or changed note structure?

The subsystem is successful only if it improves orientation and navigation while preserving the hard rule that canonical Markdown and other canonical sources remain the authority.
