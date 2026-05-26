# Schema Packs

A schema pack tells gbrain what shape your brain takes — which directories
exist, what types live in them, how the agent should infer types from
paths, and which link verbs connect what to what. The schema pack is the
**dynamic, always-consulted artifact** every skill reads when filing,
querying, or routing experts. It is the single source of truth for
"what's in your brain."

The v0.39.0.0 wave shipped a full schema-pack cathedral. This doc is the
user-facing reference; for implementation details see
`docs/designs/V038_SCHEMA_PACKS.md` (CEO plan) and the engine layer in
`src/core/schema-pack/`.

## What ships in the box

Two bundled packs:

- **`gbrain-base`** (default) — reproduces pre-v0.38 hardcoded behavior
  byte-for-byte. Existing brains see zero behavior change after upgrade.
  Covers: person, company, deal, meeting, project, place, concept, writing,
  analysis, guide, hardware, architecture, etc. (the original
  `ALL_PAGE_TYPES` list).

- **`gbrain-recommended`** — extends `gbrain-base` with the 13 additional
  directories described in `docs/GBRAIN_RECOMMENDED_SCHEMA.md`: deal,
  meeting, concept, project, source, daily, personal, civic, original,
  place, trip, conversation, writing. If you like the documented
  operational-brain pattern, activate this with:

  ```bash
  gbrain schema use gbrain-recommended
  ```

Plus user-installed packs at `~/.gbrain/schema-packs/<name>/pack.yaml`
that you author with `gbrain schema init` or `gbrain schema fork`.

## CLI surface

Five inspection verbs (shipped in v0.38):

```bash
gbrain schema active     # show resolved pack + which tier set it
gbrain schema list       # list bundled + installed packs
gbrain schema show       # pretty-print the active pack
gbrain schema validate   # validate a manifest's shape
gbrain schema use <pack> # activate a pack (writes ~/.gbrain/config.json)
```

Eight authoring + discovery verbs (shipped in v0.39):

```bash
gbrain schema detect              # propose types matching brain shape
gbrain schema suggest             # LLM-refined proposals on top of detect
gbrain schema review-candidates   # promote / rename / ignore candidates
gbrain schema review-orphans      # surface pages with no matching type
gbrain schema init <name>         # scaffold a stub pack    (experimental)
gbrain schema fork <a> <b>        # copy + rename a pack    (experimental)
gbrain schema edit <name>         # surface the pack path   (experimental)
gbrain schema diff <a> <b>        # set-diff two packs      (experimental)
gbrain schema graph               # ASCII type listing      (experimental)
gbrain schema lint                # flag duplicates + missing prefixes
gbrain schema explain <type>      # plain-English type description (experimental)
gbrain schema downgrade --to <p>  # restore previous pack (recovery)
gbrain schema usage --since 30d   # per-verb invocation counts (D14 telemetry)
```

The verbs marked `experimental` are demand-gated per D14: their usage is
tracked via T15's schema-events audit, and v0.40+ retro decides whether
to deprecate any that stay <5% usage.

## Resolution chain (7 tiers)

When the engine decides "which pack is active for this query?", it walks
this chain top-down. First match wins.

| Tier | Source | Notes |
|------|--------|-------|
| 1 | Per-call `schema_pack` opt | CLI only (`ctx.remote === false`); MCP rejected. |
| 2 | `GBRAIN_SCHEMA_PACK` env | Process-scope override. |
| 3 | Per-source DB config key `schema_pack:source:<id>` | New in v0.38. |
| 4 | Brain-wide DB config key `schema_pack` | |
| 5 | `gbrain.yml schema:` section | Repo-checked. |
| 6 | `~/.gbrain/config.json` `schema_pack` field | What `gbrain schema use` writes. |
| 7 | Default: `gbrain-base` | Always present. |

## How the agent uses the active pack

Every read + write path consults the active pack at runtime:

- **`parseMarkdown`** infers page `type` from path prefixes declared in
  the active pack (`page_types[].path_prefixes`). Without an active pack
  threaded, falls back to the legacy hardcoded `inferType()` so the
  byte-for-byte parity gate stays green.
- **`whoknows` / `find_experts`** scopes candidates to `expert_routing:
  true` types in the active pack.
- **`extract_facts`** runs only on `extractable: true` types.
- **`enrichment-service`** routes person/company enrichment based on the
  pack's primitive declarations.
- **Search hybrid cache** (`knobsHash`) folds in pack name + version
  (v0.39 T21). A cache row written under pack A is unreachable when pack
  B is active. Cross-pack contamination is structurally impossible.

## The magical moment (T2-T4 + T10)

Persona A (Notion refugee) installs gbrain, imports her exports, and the
brain looks unfamiliar — the default `gbrain-base` pack expects
`people/`, `companies/`, etc., but her files live under `Projects/`,
`Reading/`, `Daily Notes/`. The friction signal fires in two places:

1. **Import warn (T7):** the end of `gbrain import` prints
   `[schema] X of Y pages (Z%) have no type matching the active schema
   pack. Run gbrain schema detect to propose a pack matching your
   content shape.`
2. **`gbrain doctor` schema_pack_consistency check** keeps surfacing
   the warning persistently after the import session ends.

She runs the magical moment:

```bash
gbrain schema detect              # heuristic clustering on her actual shape
gbrain schema suggest             # LLM-refined proposals
gbrain schema review-candidates   # human gate on promotion
gbrain schema review-candidates --apply Projects/   # accept
```

The agent (via the new EIIRP skill) automates phases 1-3 of this for any
significant work session. The brain's schema becomes a living artifact
the agent maintains, not a hardcoded ceremony the user authors.

## Authoring your own pack

```bash
gbrain schema init my-pack            # scaffolds ~/.gbrain/schema-packs/my-pack/pack.yaml
$EDITOR ~/.gbrain/schema-packs/my-pack/pack.yaml
gbrain schema validate my-pack        # check shape
gbrain schema use my-pack             # activate
gbrain schema active                  # confirm
```

A minimal pack:

```yaml
api_version: gbrain-schema-pack-v1
name: my-pack
version: 0.0.1
gbrain_min_version: 0.39.0
extends: gbrain-base   # inherits everything from base; add overrides below
description: |
  My personal pack.

page_types:
  - name: project-x
    primitive: entity
    path_prefixes:
      - Projects/
    aliases: []
    extractable: false
    expert_routing: false

  # Add more types here. Each maps a path prefix to a primitive +
  # opt-in flags. See src/core/schema-pack/base/gbrain-recommended.yaml
  # for a worked example.

link_types: []
takes_kinds: [fact, take, bet, hunch]
borrow_from: []
frontmatter_links: []
enrichable_types: []
filing_rules: []
```

## Recovery + revert

The single-PR cathedral is hard to revert atomically. Per codex finding
#4 from plan-eng-review, T20 ships `gbrain schema downgrade` to restore
the active-pack config field:

```bash
gbrain schema downgrade --to gbrain-base
# OR auto-detect previous from ~/.gbrain/schema-pack-history.jsonl:
gbrain schema downgrade
```

**Code revert alone is NOT sufficient.** The full revert procedure:

1. `git revert <merge-commit>` — restores the code.
2. `gbrain schema downgrade --to gbrain-base` — restores config.
3. (Optional) `gbrain pages purge-deleted --older-than 0h` — drops
   v0.39-typed pages that no longer have a matching type in the active
   pack.

The cache + eval rows that pack-aware code wrote are isolated by the
`knobsHash` pack-folding (T21) — they become unreachable under the
restored pack so no eviction is needed.

## Distribution

`.gbrain-schema` tarballs ride the same v0.37 skillpack pipeline as
`.gbrain-skillpack` tarballs (T14 artifact abstraction). The
discriminator is `api_version` in the manifest:

- `gbrain-schema-pack-v1` → schemapack
- `gbrain-skillpack-v1` → skillpack

Both install via the same scaffold + copy path; install targets are
`~/.gbrain/schema-packs/<name>/` and `~/.gbrain/skillpacks/<name>/`
respectively.

Publication to the public registries (`garrytan/gbrain-schema-registry`,
`garrytan/gbrain-skillpack-registry`) follows the same publish-as-PR
workflow as v0.37 skillpack publishing.

## What's deferred to v0.40+

- **Per-source pack federation across mounts.** A query crossing multiple
  sources currently rejects with `permission_denied` when those sources
  have divergent active packs (T19 + codex finding #2). The v0.40+ work
  computes a true per-source closure via the existing
  `buildSourceClosureCte` engine surface.
- **`extends` chain semver compatibility checks** between pack versions.
- **`skillpack ↔ schemapack` cross-reference declarations** — a skillpack
  can declare "I work best with these primitives present in your pack."
- **Live schema migration helpers** — when you add a type, auto-suggest
  backfill of existing pages.
- **Authoring vs derivation thesis reframe (D14).** v0.39.0.0 ships the
  full 11-verb cathedral with 6 verbs marked experimental-tier. v0.40+
  retro reads T23 usage telemetry to decide which to deprecate.

See `TODOS.md` v0.40+ section for the full deferred list.
