# Pack-Upgrade Mechanism (v0.41.22)

> How `gbrain-base@1.x → gbrain-base-v2@1.0.0` (and any future pack
> succession) wires through the onboard cathedral.

## The contract

A schema pack manifest can declare a `migration_from` field:

```yaml
api_version: gbrain-schema-pack-v1
name: gbrain-base-v2
version: 1.0.0
migration_from:
  pack: gbrain-base
  version: "1.x"
```

When this declaration is present + a `mapping_rules:` block is
populated, the pack registers itself as the successor to
`(parent_pack, version_range)`. Any brain whose active pack matches
that tuple lights up the `pack_upgrade_available` onboard check.

## End-to-end flow

```
┌────────────────────────────────────────────────────────────────┐
│  PACK AUTHORING                                                │
│                                                                │
│  Author declares: migration_from: {pack: P, version: R}        │
│  + mapping_rules: [retype/page_to_link/page_to_alias]          │
│  Pack ships bundled OR via ~/.gbrain/schema-packs/<name>/      │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  ONBOARD CHECK DISCOVERY                                       │
│                                                                │
│  checkPackUpgradeAvailable(engine) at src/core/onboard/        │
│  checks.ts:                                                    │
│    1. Read engine.getConfig('schema_pack') for dbConfig tier  │
│    2. loadActivePack({cfg: null, remote: false, dbConfig})    │
│    3. findPackSuccessors(active.name, active.version)         │
│         → walks BUNDLED_PACK_NAMES + ~/.gbrain/schema-packs/   │
│         → matches via _versionRangeMatches(version, range)    │
│         → returns ResolvedPack[] sorted by successor version  │
│    4. If successors.length > 0, emit OnboardCheckResult        │
│       with RemediationStep targeting `unify-types` handler    │
│       + protected: true (D17 → manual_only via render          │
│       allowlist)                                               │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  USER DECIDES                                                  │
│                                                                │
│  gbrain onboard --check shows finding                          │
│  gbrain onboard --check --explain shows per-cluster narrative  │
│  User reviews; if OK, runs:                                    │
│    gbrain jobs submit unify-types --allow-protected \          │
│      --params '{"target_pack":"gbrain-base-v2"}'               │
│  (Autopilot never auto-fires this; manual_only)                │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  HANDLER EXECUTION (src/core/schema-pack/unify-types-handler.ts) │
│                                                                │
│  1. Preflight: load target pack; assert mapping_rules present  │
│  2. Stats snapshot (pre-state for celebration)                 │
│  3. Acquire gbrain-unify db-lock (60min TTL)                   │
│  4. Apply phases (4):                                          │
│     a. Explicit retype rules (chunked UPDATE 1000/batch)       │
│        - frontmatter.legacy_type ALWAYS preserved (D8)         │
│        - frontmatter.subtype stamped when subtype set          │
│     b. Catch-all retype: synthesize per-unknown-type rule       │
│        excluding declared types + explicit targets + page_to_  │
│        link/alias sources (D12 + critical bug fix)             │
│     c. Page-to-link: parse body+frontmatter, insert link row,  │
│        soft-delete source page (per-page atomicity per F7)     │
│     d. Page-to-alias: insert slug_aliases row, soft-delete     │
│        source page (NO rewriteLinks per D15)                   │
│  5. Final sync: path-prefix typing for residual UNTYPED rows   │
│  6. ACTIVE-PACK FLIP (D13):                                    │
│     - engine.setConfig('schema_pack', target_pack)             │
│     - saveConfig({...existing, schema_pack: target_pack})      │
│  7. Verify: re-run stats; warn if ≤ declared + 5 violated      │
│  8. Celebration summary to stderr + audit JSONL                │
│  9. Release db-lock                                            │
└──────────────────────────┬─────────────────────────────────────┘
                           ↓
┌────────────────────────────────────────────────────────────────┐
│  POST-UPGRADE STATE                                            │
│                                                                │
│  • pages.type updated with canonical types                     │
│  • frontmatter.legacy_type preserved for rollback              │
│  • slug_aliases populated for old-slug → canonical lookup      │
│  • links table has new partner_of / relates_to rows            │
│  • Source pages soft-deleted (72h TTL for restore)             │
│  • Active pack flipped to target_pack                          │
│  • Next gbrain onboard --check shows ok                        │
└────────────────────────────────────────────────────────────────┘
```

## Version-range semantics

`migration_from.version` accepts three shapes:

| Form | Matches |
|------|---------|
| `1.0.0` (exact literal) | `1.0.0` only |
| `1.x` (major wildcard) | `1.0.0`, `1.5.2`, `1.99.99` |
| `1.0.x` (minor wildcard) | `1.0.0`, `1.0.5`, `1.0.99` |

`*` is accepted as an alias for `x`.

Implementation: `_versionRangeMatches(version, range)` in
`src/core/schema-pack/load-active.ts`. Pinned by
`test/schema-pack-find-pack-successors.test.ts`.

## findPackSuccessors discovery

Walks `BUNDLED_PACK_NAMES` (currently `gbrain-base`,
`gbrain-recommended`, `gbrain-creator`, `gbrain-investor`,
`gbrain-engineer`, `gbrain-everything`, `gbrain-base-v2`). For each
candidate ≠ the active pack name, loads the manifest via
`loadActivePack({ perCall: candidate })`, checks
`migration_from.pack === activeName && _versionRangeMatches(activeVer,
migration_from.version)`. Returns matching packs sorted by version
descending.

v0.41.22 covers bundled packs only. v0.43+ TODO: enumerate user-installed
packs at `~/.gbrain/schema-packs/*/pack.yaml` (defer to v0.43 since the
filesystem-scan cost needs the cache invalidation strategy from
`registry.ts`).

## The manual_only apply policy

The shipped onboard contract has 3 apply_policy values:

| Policy | Meaning |
|--------|---------|
| `auto_apply` | Autopilot runs unattended |
| `prompt_required` | Autopilot in `--auto-with-prompt` mode prompts user |
| `manual_only` | Autopilot NEVER auto-fires; user must explicitly submit |

`pack_upgrade_available` emits a `RemediationStep` with `protected:
true` + `job: 'unify-types'`. `toOnboardRecommendation` in
`src/core/onboard/render.ts` maps this to `manual_only` via the
`MANUAL_ONLY_PROTECTED_JOBS` allowlist (which also contains
`extract-takes-from-pages` per v0.41.18 A12+A24).

Rationale: pack upgrades change the brain's taxonomy. Taxonomy is a
user judgment call — not autopilot's call. Even with `--auto-with-
prompt`, prompting the user to confirm a pack upgrade mid-tick is the
wrong UX (the user came to fix orphans, not to be interrupted with
"hey want to migrate your taxonomy?"). Explicit submission is the
right boundary.

## Authoring a successor pack

Minimal example for an academic-research brain that adds a
`researcher` canonical:

```yaml
api_version: gbrain-schema-pack-v1
name: gbrain-academic-v1
version: 1.0.0
description: Academic research brain — adds researcher canonical
gbrain_min_version: 0.42.0
extends: null

migration_from:
  pack: gbrain-base-v2
  version: "1.x"

page_types:
  # Inherit gbrain-base-v2's 15 types here (or use extends to merge
  # automatically once v0.43+ extends-chain composition lands)
  - { name: person, primitive: entity, path_prefixes: [people/], expert_routing: true }
  - { name: company, primitive: entity, path_prefixes: [companies/], expert_routing: true }
  # ... all 13 other v2 canonicals ...
  - { name: note, primitive: concept, path_prefixes: [notes/], extractable: true }
  # Academic addition:
  - name: researcher
    primitive: entity
    path_prefixes: [researchers/]
    aliases: [academic, professor, scholar]
    extractable: false
    expert_routing: true

mapping_rules:
  # All v2 mapping rules (copy from v2 yaml)
  # ... ~40 rules ...
  # Custom: relocate v2-tagged academics to researcher
  - { kind: retype, from_type: person, to_type: researcher, path_filter: 'researchers/%' }
  # Catch-all
  - kind: retype
    from_type: "*unknown*"
    to_type: note
    subtype_field: legacy_type
    subtype: "*original_type*"
```

Drop at `~/.gbrain/schema-packs/gbrain-academic-v1/pack.yaml`.
Discoverable via `gbrain schema list`. Activatable via
`gbrain schema use gbrain-academic-v1`. Once active, the
`pack_upgrade_available` check fires for any brain on
`gbrain-base-v2@1.x` and surfaces a `unify-types` RemediationStep
targeting your pack.

## Lock + concurrency

`gbrain-unify` is a dedicated `gbrain_cycle_locks` row name (60min
TTL). The handler acquires it before any apply phase + releases in
`finally`. Two simultaneous `gbrain jobs submit unify-types`
invocations: second one fails fast at lock acquisition with a clear
error. Same pattern as `gbrain-sync` (v0.22.13 PR #490).

## Audit trail

Every unify run writes to `~/.gbrain/audit/schema-unify-YYYY-Www.jsonl`
(ISO-week rotation, mirrors existing audit channels). Records: pack
identities (before + after), per-phase counts (would_apply + applied),
warnings, completion timestamp. Privacy: page slugs are NOT logged in
bulk (only the per-rule sample_slugs[≤10]); for forensic debugging
add `GBRAIN_AUDIT_FULL=1` (v0.43+ TODO; not yet wired).

## What's NOT yet supported

- Subprocess sandbox for the publish-gate (v0.43+ TODO)
- Per-source pack-upgrade (the handler accepts `sourceId` but
  `findPackSuccessors` doesn't yet pass it through)
- Cross-brain federated mounts that disagree on canonical packs
- Automatic rollback (today: manual SQL or `gbrain pages restore`)
- LLM-assisted mapping_rules codegen from production data (`gbrain
  schema detect-mappings`; deferred to v0.43+)

## Reference

- Pack file: `src/core/schema-pack/base/gbrain-base-v2.yaml`
- Manifest extension: `src/core/schema-pack/manifest-v1.ts`
- Successor walker: `src/core/schema-pack/load-active.ts:findPackSuccessors`
- Onboard check: `src/core/onboard/checks.ts:checkPackUpgradeAvailable`
- Render allowlist: `src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS`
- Handler: `src/core/schema-pack/unify-types-handler.ts`
- Migration: `src/core/migrate.ts:105` (slug_aliases table)
- Type taxonomy doc: `docs/architecture/type-taxonomy.md`
- Skill: `skills/schema-unify/SKILL.md`
