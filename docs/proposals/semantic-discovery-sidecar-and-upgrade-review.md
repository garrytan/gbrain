# Semantic Discovery Sidecar + Upgrade Review

> Review handoff for Claude Code / maintainer review. This document is intentionally generic and contains no private company names, people, customer names, database URLs, or live cluster outputs.

## Goal

Design a safe, read-only sidecar that uses existing GBrain embeddings to surface semantic neighborhoods, duplicate/alias candidates, and entity/link proposals without writing directly to canonical `pages`, `links`, or `facts`.

In parallel, document the upgrade risk for an install currently at `0.42.19.0` with one local commit on top of upstream, before moving to upstream `0.42.56.0`.

## Current local state observed

```text
local version:        gbrain 0.42.19.0
local branch:         master, then handoff branch barrier/sidecar-upgrade-handoff
local ahead/behind:   ahead 1, behind 34 vs origin/master
upstream VERSION:     0.42.56.0
local-only commit:    3fa9ca40 [local] fix: halfvec-aware width check + force-exit deadline 10s→60s for high-latency DBs
```

The local-only commit touches:

```text
src/cli.ts
src/core/embedding-dim-check.ts
```

## Upgrade analysis

### Local patch 1: `src/core/embedding-dim-check.ts`

Local change:

```ts
const m = formatted.match(/halfvec\((\d+)\)/i) ?? formatted.match(/vector\((\d+)\)/i);
```

Reason: hosted Postgres + pgvector can store `content_chunks.embedding` as `halfvec(N)` for large dimensions. The upstream `readFactsEmbeddingInfo` helper already handles both `vector(N)` and `halfvec(N)`, but `readContentChunksEmbeddingDim` in upstream `origin/master` still only parses `vector(N)` at the time of this review.

Observed upstream state:

- `src/core/embedding-dim-check.ts` has `readContentChunksEmbeddingDim` still parsing only `/vector\((\d+)\)/i`.
- The facts helper later in the same file correctly checks `halfvec` first.

Recommendation: preserve or upstream this halfvec parser fix. Without it, a large-dimension hosted Postgres install can report a false schema-width/corruption warning for `content_chunks.embedding`.

### Local patch 2: `src/cli.ts`

Local change: raised a pre-handler hard deadline from 10s to 60s because high-latency hosted Postgres queries were being killed with empty output.

Upstream has superseded this with a better architecture:

- `finishCliTeardown()` in `src/core/cli-force-exit.ts`.
- Computed teardown-only deadline.
- Read-scope timeout around query/context work.
- Comments explicitly reference the old “flat-10s-banner” bug.

Recommendation: do **not** preserve the old local timer block. Prefer upstream `origin/master` for `src/cli.ts` and resolve the merge conflict by taking the upstream teardown design.

### Dry-run merge result

A temporary worktree merge of local `HEAD` into `origin/master` produced one content conflict:

```text
CONFLICT (content): Merge conflict in src/cli.ts
```

No conflict was observed in `src/core/embedding-dim-check.ts`; the local halfvec patch applies cleanly into the newer file.

Conflict meaning:

- `HEAD` side contains the old force-exit timer block with `DISCONNECT_HARD_DEADLINE_MS = 60_000`.
- `origin/master` side contains the newer `finishCliTeardown` / `READ_OP_TIMEOUT_MS` design.

Resolution rule:

1. Use upstream `origin/master` block in `src/cli.ts`.
2. Keep local halfvec support in `readContentChunksEmbeddingDim` unless upstream adds the equivalent before merge.
3. Run targeted tests around CLI teardown and embedding dimension checks.

## Latest upstream features relevant to this work

Upstream `0.42.56.0` adds Life Chronicle:

- `type:event` / `type:diary`.
- Timeline reads: `gbrain day`, `gbrain since`, `gbrain last-seen`, `gbrain on-this-day`.
- Orientation/advisor: `gbrain orient`, `gbrain advisor`.
- Bi-temporal per-entity ontology using additional `facts` columns: `dimension`, `value`, `value_hash`, `dim_status`.
- Ontology commands: `gbrain ontology`, `ontology-add`, `ontology-dimensions`, `ontology-contradictions`.
- `gbrain chronicle-backfill`.

This improves temporal and entity-state modeling, but it does **not** replace semantic clustering over embeddings.

## Sidecar architecture

### Non-goals

- Do not write directly to `people/`, `companies/`, `links`, or `facts`.
- Do not create authoritative entity pages from untrusted text.
- Do not add schema migrations in the first spike.
- Do not full-scan or export all embeddings from hosted Postgres.

### Layer 1: semantic neighbors

Read-only evidence layer: nearest-neighbor relationships between existing embedded chunks/pages.

Initial sidecar output shape:

```json
{
  "from_slug": "...",
  "to_slug": "...",
  "distance": 0.17,
  "similarity": 0.83,
  "from_type": "concept",
  "to_type": "project"
}
```

Production/core candidate table later, if validated:

```sql
semantic_neighbors (
  id uuid primary key,
  source_id text not null,
  from_chunk_id bigint not null,
  to_chunk_id bigint not null,
  from_slug text not null,
  to_slug text not null,
  distance double precision not null,
  similarity double precision not null,
  embedding_model text,
  created_at timestamptz not null default now()
)
```

### Layer 2: semantic clusters

Derived communities over `semantic_neighbors`.

Initial sidecar method: connected components over kNN edges with a conservative cosine-distance threshold.

Future methods:

- Leiden/Louvain over weighted graph.
- HDBSCAN/DBSCAN if embeddings are exported into a local analytical job.
- Per-type thresholds to avoid giant mixed clusters.

Candidate table later:

```sql
semantic_clusters (
  id uuid primary key,
  source_id text not null,
  label text,
  method text not null,
  threshold double precision not null,
  member_count int not null,
  dominant_types jsonb not null,
  representative_slugs jsonb not null,
  confidence double precision,
  created_at timestamptz not null default now()
)
```

### Layer 3: entity candidates

Review queue. This is the safe boundary.

Candidate actions:

```text
create_new_entity
merge_with_existing
add_alias
add_link
ignore
needs_human_review
```

Candidate table later:

```sql
entity_candidates (
  id uuid primary key,
  source_id text not null,
  candidate_name text,
  candidate_type text,
  evidence_slugs jsonb not null,
  evidence_chunks jsonb not null,
  nearest_existing_entity_slug text,
  proposed_action text not null,
  confidence double precision not null,
  status text not null default 'pending_review',
  created_at timestamptz not null default now()
)
```

## Proposed CLI surface

For sidecar first:

```bash
GBRAIN_SPIKE_SOURCE=<source-id> \
GBRAIN_SPIKE_LIMIT=300 \
GBRAIN_SPIKE_K=10 \
GBRAIN_SPIKE_MAX_DISTANCE=0.18 \
python3 scripts/spike-semantic-clusters.py
```

If promoted into GBrain core later:

```bash
gbrain semantic-neighbors build --source <source-id> --threshold 0.18 --k 10 --dry-run
gbrain semantic-clusters build --source <source-id> --method connected-components --dry-run
gbrain entities discover --source <source-id> --from-clusters --dry-run
gbrain entities approve <candidate-id> --apply
```

## Initial spike result summary

A private operator run against a hosted Postgres brain found that existing embeddings are usable for semantic neighborhoods immediately.

Observed tuning lesson:

- `max_distance=0.28` produced a giant component.
- `max_distance=0.18` produced smaller, reviewable clusters.

Do not hard-code this threshold globally; make it configurable and eventually type-aware.

## Upgrade procedure proposed for the operator install

Do not run `gbrain upgrade --check` as the diagnostic path; it has side effects on git state.

Recommended controlled process:

```bash
cd ~/gbrain

git status --short --branch
git fetch origin master

git switch -c upgrade/rebase-0.42.56-test
# Either merge or rebase; merge is easier for preserving local provenance:
git merge origin/master
# Resolve src/cli.ts by taking upstream teardown block.
# Preserve halfvec parsing in src/core/embedding-dim-check.ts.

bun install
bun test test/embedding-dim-check.test.ts test/cli-force-exit.test.ts test/cli-exit-seam.test.ts
bun run typecheck

gbrain --version
gbrain apply-migrations --status
# Only after review approval:
gbrain apply-migrations --yes
gbrain post-upgrade
```

If the operator wants to keep the current production CLI untouched while testing, use a separate worktree/clone and avoid relinking the live binary until tests pass.

## Review questions for Claude Code

1. Is `readContentChunksEmbeddingDim` still missing halfvec support upstream, or is there a newer equivalent elsewhere?
2. Should the halfvec fix be upstreamed as a small PR independent of the sidecar?
3. Is `src/cli.ts` conflict resolved correctly by dropping the local timer and taking upstream `finishCliTeardown`?
4. Should semantic discovery live as:
   - a sidecar script only,
   - a bundled experimental command,
   - or core GBrain schema/CLI?
5. What safeguards should block entity-candidate promotion into canonical graph rows?
6. Should Life Chronicle ontology dimensions be one of the signals used in entity candidate scoring?

## Definition of Done for sidecar MVP

- [ ] Runs read-only against hosted Postgres.
- [ ] Does not fetch all embeddings into process memory by default.
- [ ] Outputs Markdown + JSON report.
- [ ] Identifies semantic clusters, likely duplicates, aliases, and suggested links.
- [ ] Includes evidence slugs/chunks for every proposal.
- [ ] Has thresholds configurable by environment/CLI flags.
- [ ] Has no private data in committed fixtures/tests.
- [ ] Has explicit `pending_review` semantics; no auto-apply.
