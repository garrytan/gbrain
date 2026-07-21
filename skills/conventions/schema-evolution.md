# Convention: schema evolution — when to add a type vs alias vs prefix

Cross-cutting convention for any skill that proposes a change to the
active schema pack. Read first before invoking `schema-author`. The
goal: keep the pack small enough that an agent can hold the whole type
graph in its head, but expressive enough that custom domains
(research, legal, founder ops) get first-class types.

## Decision tree

```
You see a cluster of pages that share a domain meaning.
         │
         ▼
How many pages in the cluster?
         │
   ┌─────┴───────┬──────────────┐
   ▼             ▼              ▼
 <20          20-100         100+
   │             │              │
   ▼             ▼              ▼
One-off.      Big enough.    First-class.
Don't pack-   Add an alias   Add a new
codify.       to an existing page_type with
              type OR a      its own prefix,
Use the       narrow prefix  primitive, and
nearest       branch.        flags.
existing
type +
frontmatter
tag.
```

### Concrete examples

**One-off (don't add to pack):**
> "I have 3 pages under `2026-projects/skunkworks-spec/`. Should I add
> a `skunkworks` type?"

No. Three pages doesn't justify a permanent pack entry. Type these as
the nearest existing match (`concept` or `note`) and use a frontmatter
`project:` tag. If the cluster grows to 20+, revisit.

**20-100 pages — alias OR narrow prefix:**
> "I have 50 pages under `people/researchers/` that overlap with my
> `person` type. Should I add a `researcher` type?"

Two valid options:
1. **Alias on `person`** — `add-alias person researcher`. Closure
   queries for `researcher` will surface `person` rows too.
2. **New type sharing the `entity` primitive** — `add-type researcher
   --primitive entity --prefix people/researchers/`. Distinct type, can
   be marked `--extractable` or `--expert` independently.

Pick alias when researchers are people first, researchers second
(they share enrichment rules, expert-routing semantics, link verbs).
Pick new type when researcher-specific behavior diverges (different
extractable rules, different link verbs, different rubric).

**100+ pages — first-class type:**
> "I have 4000 pages under `meetings/`. I want them typed as `meeting`,
> not the legacy default `note`."

Add the type:
```
gbrain schema add-type meeting \
  --primitive temporal \
  --prefix meetings/ \
  --extractable
gbrain schema sync --apply
```

The `sync --apply` backfills all 4000 pages. From here forward,
imports under `meetings/` infer `meeting` type via the pack.

## Don'ts

- **Don't add a type for a directory you imported once for triage.**
  Pack types are permanent decisions; one-time imports are not.
- **Don't add a type just to silence `dead_prefixes` in `schema stats`.**
  A dead prefix is a *signal* that the prefix is mis-declared or the
  corpus moved. Remove the prefix or migrate the content, don't add an
  empty type.
- **Don't promote a candidate from `schema suggest` without verifying
  the path prefix matches real content.** The suggester is heuristic;
  it can propose types that overlap existing ones. Run `lint --with-db`
  before `add-type` to catch prefix collisions pre-write.
- **Don't add `--expert` to a type that has no `path_prefixes`.** The
  `expert_routing_without_prefix` lint rule warns about this exact
  shape: an expert-routed type with no prefix never matches a put_page
  inference, so `whoknows` silently never surfaces it.
- **Don't mutate `gbrain-base` or `gbrain-recommended`.** Fork first.

## When to remove a type

Removing a type is RARE. Only do it when:
1. The type was added in error (typo, premature abstraction).
2. The corpus the type was meant for has been migrated to a different
   type.
3. The type is dangling (no `path_prefixes` actually match pages, no
   queries reference it, no other type's aliases/link_types reference it).

`remove-type` is guarded by the `STILL_REFERENCED` check (codex C14): if
ANY other type's aliases / enrichable_types / link_types / frontmatter_links
references the target, the remove fails loud with the reference list.
Break those references first.

## When to commit the pack

If your pack lives in source control (`~/.gbrain/schema-packs/<name>/`
is a git repo), commit after every batch of mutations. The
`mutation_count_anomaly` lint rule warns at >50 mutations in 7 days —
that's the hint to start committing rather than relying on disk-only
state.

## When to upgrade your pack (v0.42+)

A pack can declare `migration_from: {pack: <name>, version: <semver-range>}`
to register itself as the successor to another pack. When a brain's
active pack matches the declared `from`, the `pack_upgrade_available`
onboard check surfaces the successor + a `manual_only` RemediationStep
pointing at the `unify-types` PROTECTED Minion handler.

v0.41.22 ships **gbrain-base-v2** as the declared successor to
gbrain-base@1.x — collapses 94 noisy types to 15 canonical via
declarative mapping_rules. Run via `gbrain onboard --check --explain`
(preview) → `gbrain jobs submit unify-types --allow-protected --params
'{"target_pack":"gbrain-base-v2"}'` (apply). See
`skills/schema-unify/SKILL.md` for the full playbook.

Authoring a successor pack: declare
`migration_from: {pack: <parent>, version: "1.x"}` in the manifest
plus `mapping_rules:` (discriminated union over retype / page_to_link /
page_to_alias kinds). Catch-all sentinel `from_type: '*unknown*'` MUST
appear last. Subtype_field is restricted to ALLOWED_SUBTYPE_FIELDS
(`subtype, legacy_type, origin, format, kind, period, domain`) per
codex D9 — third-party packs cannot inject `title` / `slug` / `type`.

When NOT to upgrade:
- Custom types not covered by the successor's mapping_rules → fork the
  successor first (`gbrain schema fork gbrain-base-v2 my-pack`), edit
  rules, then target your fork.
- Mid-ingest or autopilot maintenance → wait. Unify holds the
  `gbrain-unify` db-lock for ~10 min on big brains.
- Federated brain with sources you don't want to touch → scope per
  source via `--params sourceId`.
