# Schema Packs

A schema pack tells gbrain what shape your brain takes — which directories
exist, what types live in them, how the agent should infer types from
paths, and which link verbs connect what to what. The schema pack is the
**dynamic, always-consulted artifact** every skill reads when filing,
querying, or routing experts. It is the single source of truth for
"what's in your brain."

This doc is the user-facing reference; for implementation details see
`docs/designs/V038_SCHEMA_PACKS.md` (the design doc) and the engine
layer in `src/core/schema-pack/`.

## What ships in the box

Seven bundled packs (`src/core/schema-pack/base/`):

- **`gbrain-base-v2`** — the 15-type canonical taxonomy. Fresh installs
  (`gbrain init`) activate this by default. See
  [`type-taxonomy.md`](./type-taxonomy.md) for the full type list and the
  upgrade path from `gbrain-base`.

- **`gbrain-base`** — the built-in taxonomy, byte-for-byte identical to the
  hardcoded type inference (person, company, deal, meeting, project, place,
  concept, writing, analysis, guide, hardware, architecture, etc. — the
  `ALL_PAGE_TYPES` list). The resolution-chain fallback (tier 7) for brains
  with no pack configured anywhere.

- **`gbrain-recommended`** — extends `gbrain-base` with the 13 additional
  directories described in `docs/GBRAIN_RECOMMENDED_SCHEMA.md`: deal,
  meeting, concept, project, source, daily, personal, civic, original,
  place, trip, conversation, writing. If you like the documented
  operational-brain pattern, activate this with:

  ```bash
  gbrain schema use gbrain-recommended
  ```

- **`gbrain-creator`**, **`gbrain-investor`**, **`gbrain-engineer`**,
  **`gbrain-everything`** — the lens packs, which add cycle phases and
  calibration domains on top of the base taxonomy. See
  [`lens-packs.md`](./lens-packs.md).

Plus user-installed packs at `~/.gbrain/schema-packs/<name>/pack.yaml`
that you author with `gbrain schema init` or `gbrain schema fork`.

## CLI surface

Inspection verbs:

```bash
gbrain schema active     # show resolved pack + which tier set it
gbrain schema list       # list bundled + installed packs
gbrain schema show       # pretty-print the active pack
gbrain schema validate   # validate a manifest's shape
gbrain schema use <pack> # activate a pack (writes ~/.gbrain/config.json)
```

`gbrain config set schema_pack <pack>` sets the brain-wide database override,
which takes precedence over the file setting written by `gbrain schema use`.
Use `gbrain config unset schema_pack` to remove that database override, then
`gbrain schema active` to confirm the resolved pack and its selection tier.
`gbrain config get schema_pack` and `gbrain config show` report the same
resolved pack and name its tier.

Authoring + discovery verbs:

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
gbrain schema lint [--with-db]    # duplicates + missing prefixes; --with-db adds data-plane rules
gbrain schema explain <type>      # plain-English type description (experimental)
gbrain schema downgrade --to <p>  # restore previous pack (recovery)
gbrain schema usage --since 30d   # per-verb invocation counts (telemetry)
```

The verbs marked `experimental` are demand-gated: usage is tracked via the
schema-events audit (`gbrain schema usage`), which informs whether
rarely-used verbs get deprecated.

With `--with-db`, `schema lint` also runs two data-plane rules over the
stored corpus: `stored_type_is_alias` (a page's explicit type is an alias —
the canonical type and its filing directory are named) and
`stored_type_undeclared` (the type isn't in the active pack at all). The
rule layer accepts a per-source scope (`LintOpts.sourceId` — multi-source
brains can resolve different packs per source), though the CLI currently
runs a global scan. The same classification warns once per type per run at
sync/import so alias types stop filing into unexpected directories
silently; silence the ingest warnings with
`gbrain config set schema.type_warnings false` (the `--with-db` lint rules
are unaffected).

## Undeclared page types

A page type is **undeclared** when the active pack neither declares it as a
page type nor lists it as an alias. gbrain stores such a type as written and
reports it everywhere it measures conformance, all with the same
classification as `schema lint --with-db`'s `stored_type_undeclared`:

- `put_page` (MCP, `gbrain put`, `gbrain call put_page`) commits the page and
  returns `type_warning` with `code: page_type_undeclared`, the cause, the fix
  and this anchor. It warns rather than rejects; `capture` still rejects an
  undeclared explicit type, and dream subagent writes still normalize it to
  `note` with `legacy_type`.
- `gbrain lint <dir>` flags it as `type-undeclared` on the `type:` line.
- `gbrain schema review-orphans` / MCP `schema_review_orphans` list untyped
  AND undeclared-type pages (`reason`, `undeclared_types`, a true
  `orphan_count`); `schema_stats` reports `undeclared_pages` and counts them
  against `coverage`.
- doctor `schema_pack_consistency` (the MCP `run_doctor` report) warns on any
  undeclared type, per source against that source's pack.

Fix one by declaring it (`gbrain schema add-type <type> --primitive <p>
--prefix <dir/>`) or by rewriting the pages with a declared type. On a managed
brain the `unify-types` job cannot apply yet, so rewrite the page with
`put_page` (read it with `get_page include_content:true`, change `type:`, put it
back). gbrain's own outputs use declared types: `gbrain report` and the dream
drift report write `type: note` with a `report_type`, and the meeting
transcript sidecar is `type: source` under `sources/meetings/`.

## Resolution chain (7 tiers)

When the engine decides "which pack is active for this query?", it walks
this chain top-down. First match wins.

| Tier | Source | Notes |
|------|--------|-------|
| 1 | Per-call `schema_pack` opt | CLI only (`ctx.remote === false`); MCP rejected. |
| 2 | `GBRAIN_SCHEMA_PACK` env | Process-scope override. |
| 3 | Per-source DB config key `schema_pack:source:<id>` | |
| 4 | Brain-wide DB config key `schema_pack` | |
| 5 | `gbrain.yml schema:` section | Repo-checked. |
| 6 | `~/.gbrain/config.json` `schema_pack` field | What `gbrain schema use` (and `gbrain init`, which sets `gbrain-base-v2`) writes. |
| 7 | Default: `gbrain-base` | Always present. |

Tier 7 is `gbrain-base`, not `gbrain-base-v2`. Only a brain whose
`gbrain init` never wrote `schema_pack` reaches tier 7, and its pages carry the
legacy 24-type taxonomy. Pointing the fallback at v2 would change type
inference, alias closure and enrichment for those brains without running v2's
`migration_from` retype rules, which `gbrain schema upgrade` applies as a
reviewed step. Relation direction and meeting attendance are decided in the
extractor, so both packs store the same edges; see
[Relation direction](#relation-direction).

## Relation direction

A pack's `frontmatter_links` entry names a field and a verb, not a
direction. The direction comes from the verb's declared counterpart in
`FRONTMATTER_LINK_MAP` (`src/core/link-extraction.ts`) for the same page
type: company `investors`, `key_people` and `partner`, deal `investors` and
`lead`, and meeting `attendees` are incoming (the person, fund or company is
the subject, so `investors: [people/bob-example]` on a company stores Bob ->
company). A verb with no declared counterpart, such as company-brain's
`owned_by`, is outgoing (page -> target).

On a meeting page, a pack's `attended` rule bound only to the page type (and
optionally a `person` target), as `gbrain-base` and `company-brain` ship, is
the in-code meeting prior. Meeting links then follow canonical attendance:
only an explicit attendee list makes a person an attendee, stored person ->
meeting (see [attendance evidence](../guides/attendance-evidence.md)). A pack
that gives `attended` a phrase `regex` decides attendance itself and keeps its
outgoing semantics. A brain whose links were extracted before v0.60.30.0
re-derives them with `gbrain extract links --source db --include-frontmatter`.

A link type's `inference.regex` runs before the in-code link matchers, so a
pack regex decides the verb for a markdown link when it matches. A rule marked
`ner_only: true` runs only for NER body mentions (`gbrain extract ner`). The
bundled `gbrain-base` and `gbrain-base-v2` packs mark their `founded`,
`works_at`, `invested_in` and `advises` sketch regexes this way, so a bare
"started" or "joined" near a markdown link does not label it `founded` or
`works_at`; the tuned in-code matchers decide those links. A brain whose links
were extracted before v0.60.36.0 re-derives them with
`gbrain extract links --source db`.

## How the agent uses the active pack

Every read + write path consults the active pack at runtime:

- **`parseMarkdown`** infers page `type` from path prefixes declared in
  the active pack (`page_types[].path_prefixes`). Without an active pack
  threaded, falls back to the hardcoded `inferType()`; a parity test pins the
  two byte-for-byte.
- **`whoknows` / `find_experts`** scopes candidates to `expert_routing:
  true` types in the active pack.
- **`extract_facts`** runs only on `extractable: true` types.
- **`enrichment-service`** routes person/company enrichment based on the
  pack's primitive declarations.
- **Search hybrid cache** (`knobsHash`) folds in pack name + version.
  A cache row written under pack A is unreachable when pack
  B is active. Cross-pack contamination is structurally impossible.

## The magical moment

Persona A (Notion refugee) installs gbrain, imports her exports, and the
brain looks unfamiliar — the default `gbrain-base` pack expects
`people/`, `companies/`, etc., but her files live under `Projects/`,
`Reading/`, `Daily Notes/`. The friction signal fires in two places:

1. **Import warn:** the end of `gbrain import` prints
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

The agent (via the EIIRP skill, `skills/eiirp/SKILL.md`) automates phases 1-3 of this for any
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
extends: gbrain-base   # inherits base's TYPES (see Merge contract below); add overrides
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

## Merge contract (`extends` + `borrow_from`)

This section is the single home for the merge rules (other docs link here).
`resolvePack` composes a pack against its `extends` chain (and any
`borrow_from` targets) into the `resolved.manifest` every consumer reads.
The rules:

- **`link_types[].temporal`** (`state` | `event`, optional) declares whether a relation can end or happened on a date; graph reads then treat it as a temporal typed edge ([temporal edges](../guides/temporal-edges.md)).
- **Six fields inherit, child-wins:** `page_types`, `link_types`,
  `frontmatter_links`, `enrichable_types`, `filing_rules`, and `takes_kinds`.
  A child value with the same key (type name, link name, etc.) overrides the
  parent's; keys the child doesn't declare come through from the parent.
- **`page_types` ordering:** overrides of a base type keep the base's declared
  position (base's `inferType` prefix priority is authoritative); a genuinely
  new type — from the child, a `borrow_from`, or a middle pack in the chain —
  is prepended nearest-first, so a more-derived type's `path_prefix` wins
  regardless of how deep the chain is.
- **`takes_kinds` is UNION, not replace** — it carries a Zod default, so an
  omitted field is indistinguishable from an explicit one. A child can ADD
  kinds but **cannot narrow** `takes_kinds` below base ∪ parent. If you need a
  smaller set, don't `extends` a pack that declares the larger one.
- **`phases` and `calibration_domains` are NOT inherited** (child-only). They
  gate real cycle execution, so each pack must declare its own participation
  explicitly — inheriting them would silently make a child run phases it never
  requested. This is why `gbrain-everything` re-declares all its phases and
  calibration domains by hand. See `lens-packs.md` for the worked example.
- **`borrow_from` is selective + non-transitive + fail-closed:** it pulls only
  the named `types`/`link_types` from the target's OWN declarations (omitting a
  category borrows none of it); a missing target throws `UnknownPackError`.

## Recovery + revert

A pack activation is config, not code, so reverting code alone doesn't
undo it. `gbrain schema downgrade` restores the active-pack config field:

```bash
gbrain schema downgrade --to gbrain-base
# OR auto-detect previous from ~/.gbrain/schema-pack-history.jsonl:
gbrain schema downgrade
```

**Code revert alone is NOT sufficient.** The full revert procedure:

1. `git revert <merge-commit>` — restores the code.
2. `gbrain schema downgrade --to gbrain-base` — restores config.
3. (Optional) `gbrain pages purge-deleted --older-than 0h` — hard-deletes
   soft-deleted pages that no longer have a matching type in the active
   pack.

The cache + eval rows that pack-aware code wrote are isolated by the
`knobsHash` pack-folding — they become unreachable under the
restored pack so no eviction is needed.

## Distribution

`.gbrain-schema` tarballs ride the same distribution pipeline as
`.gbrain-skillpack` tarballs. The discriminator is `api_version` in the
manifest:

- `gbrain-schema-pack-v1` → schemapack
- `gbrain-skillpack-v1` → skillpack

Both install via the same scaffold + copy path; install targets are
`~/.gbrain/schema-packs/<name>/` and `~/.gbrain/skillpacks/<name>/`
respectively.

Publication to the public registries (`garrytan/gbrain-schema-registry`,
`garrytan/gbrain-skillpack-registry`) follows the same publish-as-PR
workflow as skillpack publishing.

## Known limits / deferred work

- **Per-source pack federation across mounts.** A query crossing multiple
  sources rejects with `permission_denied` when those sources have
  divergent active packs (`src/core/schema-pack/op-trust-gate.ts`). A true
  per-source closure via the existing `buildSourceClosureCte` engine
  surface remains future work.
- **Pack version upgrades** (e.g. `gbrain-base` → `gbrain-base-v2`) are
  handled by the successor-detection + unify-types mechanism — see
  [`pack-upgrade-mechanism.md`](./pack-upgrade-mechanism.md).

The live deferred list is in `TODOS.md`.
