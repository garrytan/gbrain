---
name: schema-author
description: Evolve your brain's schema pack. Add page types, propose new ones from corpus scans, backfill page.type on existing pages, audit pack health. Triggers when an agent notices untyped pages, custom domains needing typed entities (researcher, contract, deposition), or wants to see what types the pack declares.
tools:
  - gbrain schema active
  - gbrain schema list
  - gbrain schema stats
  - gbrain schema review-orphans
  - gbrain schema detect
  - gbrain schema suggest
  - gbrain schema lint
  - gbrain schema graph
  - gbrain schema explain
  - gbrain schema fork
  - gbrain schema use
  - gbrain schema add-type
  - gbrain schema remove-type
  - gbrain schema update-type
  - gbrain schema add-alias
  - gbrain schema remove-alias
  - gbrain schema add-prefix
  - gbrain schema remove-prefix
  - gbrain schema add-link-type
  - gbrain schema remove-link-type
  - gbrain schema set-extractable
  - gbrain schema set-expert-routing
  - gbrain schema sync
  - gbrain schema reload
  - mcp:get_active_schema_pack
  - mcp:list_schema_packs
  - mcp:schema_stats
  - mcp:schema_lint
  - mcp:schema_graph
  - mcp:schema_explain_type
  - mcp:schema_review_orphans
  - mcp:schema_apply_mutations
  - mcp:reload_schema_pack
triggers:
  - "add a page type"
  - "add a type to my schema"
  - "my brain has untyped pages"
  - "schema isn't matching my notes"
  - "propose new types from my corpus"
  - "backfill page types"
  - "evolve my schema"
  - "extend the schema pack"
  - "create a custom type for"
  - "researcher type"
  - "make X an expert type"
  - "schema pack add"
  - "schema mutate"
  - "schema sync"
  - "schema author"
brain_first: exempt
writes_pages: []
---

# schema-author — evolve your schema pack

## Non-goals (use these other skills instead)

This skill AUTHORS the schema pack (adds page types, link verbs, prefixes,
flags). For these adjacent jobs, route elsewhere:

- **Filing one specific page** → `skills/brain-taxonomist/SKILL.md`. Brain-
  taxonomist routes at WRITE TIME ("where does this note go?"). schema-author
  changes the rules at AUTHORING TIME ("what types and prefixes exist?").
- **Schema-check as part of EIIRP iteration** → `skills/eiirp/SKILL.md`
  already has a schema-check phase. Don't duplicate.
- **Just looking up a type's settings** → `gbrain schema explain <type>`
  directly. This skill is for CHANGING the pack, not READING from it.
- **Querying who knows about X** → `skills/expert-routing/SKILL.md` (or
  `gbrain whoknows` directly). schema-author makes a type expert-routable;
  it does not run the query.

## Convention

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) for the lookup chain (search → query → get_page → external).

> **Convention:** see [conventions/schema-evolution.md](../conventions/schema-evolution.md) for "when to add a type vs alias vs prefix" — the heuristic.

## When to invoke

Invoke when the user (or a sibling skill) says any of:
- "Add a `researcher` type to my schema"
- "I have 4000 untyped pages under `meetings/`"
- "My brain doesn't know that `journal-article` is a type"
- "Set `paper` to be extractable"
- "Propose types from what I've ingested"
- "Sync the new types to backfill existing pages"

DON'T invoke for "where does THIS note go" (use brain-taxonomist) or
"who knows about X" (use expert-routing / `gbrain whoknows`).

## Tutorial + vision

- **Why this matters:** [`docs/what-schemas-unlock.md`](../../docs/what-schemas-unlock.md) — 7 killer use cases (4000 invisible meetings made queryable, founder ops brain, research brain, legal brain, team brain, agent-as-co-curator) plus the structural argument for why types matter at query time. Read this before pitching schema authoring to a user — it's the doc that explains the difference between a pile of notes and a brain with structure.
- **5-minute walkthrough:** [`docs/schema-author-tutorial.md`](../../docs/schema-author-tutorial.md) — fork the bundled pack, add a researcher type, sync, prove the T1.5 wiring via `gbrain whoknows`. Use placeholder pages so it runs against any brain without affecting real content.

## Workflow

### Phase 1 — Brain (know which pack is active)

```
gbrain schema active --json
```

Output gives you `pack_name`, `version`, `sha8`, `page_types_count`, `source_tier`.
If `source_tier === "default"`, the user is on bundled `gbrain-base` and any
mutation will need a fork first (Phase 4).

### Phase 2 — Assess (what does the current pack cover?)

```
gbrain schema stats --json
```

Returns per-type page counts, untyped count, and `dead_prefixes` (pack-
declared prefixes with zero matching pages — probable mis-declarations).
If coverage < 90%, there's untyped content worth typing.

```
gbrain schema review-orphans --limit 50 --json
```

Untyped pages drilldown. Look for shared path prefixes (e.g. "12 of these
are under `research/papers/`") — those are candidates for a new type.

### Phase 3 — Propose (what types should the pack add?)

```
gbrain schema detect --json
```

Clusters pages by `source_path` and proposes candidate types. Heuristic
only (no LLM call).

```
gbrain schema suggest --json
```

LLM-refined candidates with confidence scores. Use the top-3 hit rate as
the signal for which to promote.

### Phase 4 — Apply (mutate the pack)

If the active pack is bundled (`gbrain-base` or `gbrain-recommended`),
fork it first:

```
gbrain schema fork gbrain-base mine
gbrain schema use mine
```

Then add the types one at a time:

```
gbrain schema add-type researcher \
  --primitive entity \
  --prefix people/researchers/ \
  --extractable \
  --expert
```

For complex multi-mutation refactors (e.g. add a type AND the link verb
that points to it), agents reaching this surface over MCP can use the
batched `schema_apply_mutations` op:

```jsonl
{"op": "add_type", "name": "researcher", "primitive": "entity", "prefix": "people/researchers/", "extractable": true, "expert_routing": true}
{"op": "add_type", "name": "paper", "primitive": "annotation", "prefix": "research/papers/", "extractable": true}
{"op": "add_link_type", "name": "authored", "inference": {"page_type": "researcher", "target_type": "paper"}}
```

Validate before sync:

```
gbrain schema lint --with-db
```

The `--with-db` flag opts into the 2 DB-aware rules
(`extractable_empty_corpus`, `mutation_count_anomaly`) that detect
mis-declared types you'd otherwise discover only at runtime.

### Phase 5 — Sync (backfill existing pages with the new types)

Dry-run first:

```
gbrain schema sync --json
```

Returns per-prefix `would_apply` counts + sample slugs. If the numbers
look right:

```
gbrain schema sync --apply
```

Chunked UPDATE in 1000-row batches; never wedges concurrent writers.
Idempotent on re-run (second `--apply` finds nothing to backfill).

### Phase 6 — Verify

```
gbrain schema stats --json
```

Coverage should be ≥95% now. Spot-check the new type:

```
gbrain whoknows "machine learning"
```

If `researcher` was declared `--expert`, results should include
researcher-typed pages. (The pack-aware wiring at the query path was
added in v0.40.6.0 — pre-v0.40.6 brains silently ignored custom
expert-routed types.)

### Phase 7 — Commit (preserve the change)

If the pack is in source control, commit:

```
cd ~/.gbrain/schema-packs/mine
git add pack.json
git commit -m "schema: add researcher + paper types + authored link"
git push
```

If the brain daemon is running (`gbrain serve --http`), other processes
pick up the change within 1 second (stat-mtime TTL gate in
loadActivePack — v0.40.6.0 closed the cross-process invalidation gap).

## Outputs

- Mutated pack file at `~/.gbrain/schema-packs/<name>/pack.{json,yaml}`.
- Audit row in `~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl` per mutation.
- `pages.type` backfilled on matching rows after `sync --apply`.
- Query paths (`whoknows`, `find_experts`) now route through the new
  expert types.

## Contract

- **Inputs:** a natural-language request that names a type / prefix / link verb / flag change, OR the result of `gbrain schema review-orphans` showing untyped pages that need a new type.
- **Outputs:** mutated pack file at `~/.gbrain/schema-packs/<name>/pack.{json,yaml}` + an audit row in `~/.gbrain/audit/schema-mutations-YYYY-Www.jsonl` + (if `sync --apply` ran) backfilled `pages.type` on matching rows.
- **Side effects:** invalidates the in-process pack cache + the query cache for the source. Other processes pick up the change within 1 second (stat-mtime TTL).
- **Idempotency:** every primitive is idempotent. `add-alias`/`add-prefix` no-op on duplicate; `sync --apply` finds nothing to update on second run.
- **Trust:** CLI = local trust (no scope check). MCP = OAuth `admin` scope (write ops). Audit log captures `actor: mcp:<clientId8>` per mutation.
- **Atomicity:** every mutation is wrapped in `withMutation`'s atomic write (`.tmp + fsync + rename`) + per-pack `O_CREAT|O_EXCL` lock. Crash mid-write leaves the original file untouched.

## Anti-Patterns

- **Don't mutate `gbrain-base` or `gbrain-recommended`.** Fork first (`gbrain schema fork gbrain-base mine`). These are bundled packs; edits would be lost on upgrade. The mutation primitives refuse with `PACK_READONLY`.
- **Don't add a type for a directory you imported once for triage.** Pack types are permanent decisions; one-time imports are not. See `skills/conventions/schema-evolution.md` for the <20-pages-don't-pack-codify heuristic.
- **Don't add `--expert` to a type with no `path_prefixes`.** The `expert_routing_without_prefix` lint warns about this — expert-routed types with no prefix never match a put_page inference, so `whoknows` silently never surfaces them.
- **Don't promote a `schema suggest` candidate without verifying the prefix matches real content.** Run `lint --with-db` before `add-type` to catch prefix collisions pre-write.
- **Don't conflate "filing one page" with "evolving the schema."** Filing routes via `brain-taxonomist`; schema-author is for authoring the type taxonomy itself. The Non-goals section above names the boundary.
- **Don't skip the dry-run before `sync --apply`.** Always run `sync` first to see `would_apply` counts + sample slugs. A pack prefix that matches 50,000 pages is recoverable but slow; verifying first is cheap.
- **Don't remove a type without checking references.** `remove-type` refuses with `STILL_REFERENCED` if another type's `aliases` / `enrichable_types` / `link_types` / `frontmatter_links` references it. Break the references first; don't add `--force`.

## Output Format

When invoked, this skill produces structured output suitable for both human + JSON consumption:

**Per-mutation result (JSON):**
```json
{"schema_version": 1, "pack": "mine", "path": "/Users/.../pack.json", "format": "json", "prev_sha8": "a1b2c3d4", "new_sha8": "e5f6g7h8"}
```

**Per-batch result (from `schema_apply_mutations` MCP op):**
```json
{"schema_version": 1, "pack": "mine", "batch_id": "batch-1716491400-abc123", "mutations_applied": 3, "results": [{...}, {...}, {...}]}
```

**Stats JSON (per-source + aggregate + dead-prefix hints):**
```json
{"schema_version": 1, "pack_identity": "mine@1.0.0+abc12345", "aggregate": {"total_pages": 4823, "typed_pages": 4710, "untyped_pages": 113, "coverage": 0.9766, "by_type": [{"type": "person", "count": 2104}, ...]}, "per_source": [...], "dead_prefixes": [{"type": "researcher", "prefix": "people/researchers/"}]}
```

**Sync dry-run JSON:**
```json
{"schema_version": 1, "apply": false, "pack_identity": "mine@1.0.0+abc12345", "per_prefix": [{"type": "meeting", "prefix": "meetings/", "would_apply": 4000, "sample_slugs": ["meetings/2026-01-01-foo", ...], "dead_prefix": false, "applied": 0}], "total_would_apply": 4000, "total_applied": 0}
```

**Human output (the agent's final summary):**
- One line per mutation: `Pack: <name> (<format>)` and `Sha8: <prev> → <new>`
- Stats: total pages, typed %, untyped count, per-type breakdown, dead-prefix list
- Sync: per-prefix `would_apply`/`applied` count + sample slugs in dry-run mode

On failure, the error envelope follows the standard `StructuredAgentError` shape from `src/core/errors.ts`: `{error, code, message, details?}`. Codes from the mutation primitives: `PACK_NOT_FOUND`, `PACK_READONLY`, `PACK_CORRUPT`, `TYPE_EXISTS`, `TYPE_NOT_FOUND`, `INVALID_PRIMITIVE`, `INVALID_RESULT`, `IO_ERROR`, `STILL_REFERENCED`, `LOCK_BUSY`.

## Failure modes

- `PACK_READONLY` → you tried to mutate `gbrain-base` or `gbrain-recommended`. Fork first.
- `INVALID_RESULT` → the mutation would create a dangling reference or
  prefix collision. The pre-write lint gate caught it. Read the error
  message; the lint rule name names the problem.
- `STILL_REFERENCED` → you tried to remove a type that another type's
  `aliases` / `enrichable_types` / `link_types` / `frontmatter_links`
  references. The error names every reference. Remove those first.
- `LOCK_BUSY` → another process is mid-mutation. Wait 30s and retry, or
  pass `--force` if you know the holder is wedged.
- `permission_denied` (MCP only) → your OAuth client doesn't have `admin`
  scope. Re-register with `gbrain auth register-client --scopes admin`.
