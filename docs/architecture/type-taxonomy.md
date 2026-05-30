# Type Taxonomy (v0.41.22: gbrain-base-v2)

> The 14-canonical-type DRY/MECE taxonomy shipped in v0.41.22. Predecessor
> `gbrain-base` (24 types) stays bundled for back-compat; v0.42+ installs
> default to `gbrain-base-v2`.

## Why

A production gbrain brain (186K pages) had accreted **94 distinct
`pages.type` values** in 9 clusters of redundancy. The type system is
the foundation for schema packs, search filtering, extract behavior,
enrichment routing, and expert routing. When types are noisy, every
downstream feature degrades:

- **Search filtering is ambiguous** — `--type article` misses 2.2K
  articles typed as `media/article`, `sources/article`, etc.
- **Enrichment routing is incomplete** — `enrichable_types` could only
  list a few canonical types; 80+ legacy types meant most pages never
  got enriched.
- **Agent confusion** — when ingesting a new article, should it be
  `article`, `media/article`, `sources/article`, or `source/article`?
  Four reasonable choices, none of them right.
- **Orphan inflation** — 5,521 concept-redirect pages inflated orphan
  counts without adding knowledge value.

Issue #1479 catalogues the 9 clusters with exact counts. This doc is
the response: a coherent 14-type taxonomy with subtypes/format/origin
pushed to frontmatter, alias-table rows for redirects, real link-table
rows for edge-shaped pages.

## The 14 canonical types (+ `note` catch-all)

| Type | Primitive | What it holds | Examples |
|------|-----------|---------------|----------|
| `person` | entity | People | Founders, partners, individuals |
| `company` | entity | Companies, products, orgs (subtype-distinguished) | Companies, YC-companies, products |
| `media` | media | Articles, videos, essays, books, podcasts (subtype-distinguished) | Substack posts, YouTube videos, books |
| `tweet` | media | Twitter posts (single/bundle/stub subtype) | Single tweets, threads, bundles |
| `social-digest` | temporal | Period-grouped social summaries (daily/monthly) | X account daily digests |
| `analysis` | media | Research + competitive intel | Market analysis, pricing analysis |
| `atom` | annotation | Knowledge units (extraction/manual/lore subtype) | Extracted facts, manual notes, lore |
| `concept` | concept | Ideas + reference pages | Wiki concepts |
| `source` | media | Transcripts, references | Interview transcripts |
| `deal` | temporal | Investment deals | Term sheets, investments |
| `email` | temporal | Email threads | Email correspondence |
| `slack` | temporal | Slack messages + threads | Slack conversations |
| `writing` | media | Original writing | Drafts, essays in progress |
| `project` | concept | Initiatives, workstreams | Internal projects |
| `note` | concept | **Catch-all** for one-offs (legacy_type preserved) | Memos, anecdotes, insights, etc. |

15 types total (14 canonical + `note`). The catch-all retype rule
binds any uncovered legacy type to `note` with
`frontmatter.legacy_type = <original>` preserved for rollback.

## Subtypes (declared in frontmatter post-unify)

| Canonical | Subtype field | Values |
|-----------|---------------|--------|
| `company` | `subtype` | `company` / `product` / `org` |
| `media` | `subtype` | `video` / `article` / `essay` / `book` / `podcast` / `blog` |
| `tweet` | `subtype` | `single` / `bundle` / `stub` |
| `social-digest` | `subtype` | `daily` / `monthly` |
| `atom` | `subtype` | `extraction` / `manual` / `lore` |

`subtype_field` for retype rules is restricted to an allowlist:
`{subtype, legacy_type, origin, format, kind, period, domain}`. This
prevents third-party packs from injecting `title`, `slug`, or `type`
via mapping_rules (codex D9 security hardening).

## Migration flow

```
gbrain onboard --check                         # surfaces pack_upgrade_available
        ↓
gbrain onboard --check --explain               # per-cluster narrative dry-run
        ↓
gbrain jobs submit unify-types \               # PROTECTED + manual_only
  --allow-protected \
  --params '{"target_pack":"gbrain-base-v2"}'
        ↓
Handler runs 4 phases:
  ┌─────────────────────────────────────┐
  │ Phase 1: Preflight + lock           │ → gbrain-unify db-lock (60min TTL)
  ├─────────────────────────────────────┤
  │ Phase 2: Retype explicit rules      │ → chunked UPDATE 1000/batch
  ├─────────────────────────────────────┤
  │ Phase 3: Retype catch-all sentinel  │ → 'note' with legacy_type
  ├─────────────────────────────────────┤
  │ Phase 4: Page-to-link conversions   │ → insert links + soft-delete
  ├─────────────────────────────────────┤
  │ Phase 5: Page-to-alias conversions  │ → insert slug_aliases + soft-delete
  ├─────────────────────────────────────┤
  │ Phase 6: Final sync (residual)      │ → path-prefix typing
  ├─────────────────────────────────────┤
  │ Phase 7: Flip active pack (D13)     │ → engine.setConfig + saveConfig
  ├─────────────────────────────────────┤
  │ Phase 8: Verify + celebrate         │ → assert ≤16 types; stderr summary
  └─────────────────────────────────────┘
        ↓
gbrain onboard --check                         # pack_upgrade_available cleared
                                               # type_proliferation cleared
```

## Rollback paths

Every primitive ships with a documented rollback:

| Operation | Rollback |
|-----------|----------|
| Retype | `frontmatter.legacy_type = <original>` preserved on every page (D8). One SQL UPDATE restores types: `UPDATE pages SET type = frontmatter->>'legacy_type' WHERE frontmatter ? 'legacy_type'`. |
| Page-to-link | Source page soft-deleted with 72h TTL. `gbrain pages restore <slug>` within 72h. Link row stays harmless if source restored. |
| Page-to-alias | Source page soft-deleted with 72h TTL. `gbrain pages restore <slug>` within 72h. Alias row stays harmless (or `DELETE FROM slug_aliases WHERE alias_slug = <slug>` to clean up). |
| Active-pack flip | `gbrain schema use gbrain-base` reverses the flip. |

## What if my brain doesn't fit?

The catch-all retype rule (`from_type: '*unknown*'`) handles long-tail
types automatically — any page whose type isn't covered by an explicit
rule AND isn't a page_to_link / page_to_alias source gets retyped to
`note` with `legacy_type` preserved. Guarantees ≤16 distinct types
post-unify on ANY brain.

For brains with substantial custom types that deserve their own canonical
(e.g. `researcher` for an academic brain), the right move is:

1. Fork gbrain-base-v2: `gbrain schema fork gbrain-base-v2 my-pack`
2. Edit your fork to add page_types + mapping_rules covering your
   custom domain.
3. Target your fork: `gbrain jobs submit unify-types --allow-protected
   --params '{"target_pack":"my-pack"}'`

Your fork can also declare `migration_from: {pack: gbrain-base-v2,
version: "1.x"}` to register itself as a successor — future agents
discovering your pack via `pack_upgrade_available` will offer the
migration.

## Wikilink resolution post-unify

The slug_aliases table IS the resolver (D15: codex outside voice —
don't rewrite body-text wikilinks; the alias table is the right
primitive). Wikilinks like `[[old-redirect-slug]]` keep working post-
unify because:

1. The wikilink resolver short-circuits through
   `engine.resolveSlugWithAlias(slug, sourceId)` BEFORE the existing
   fuzzy/prefix cascade.
2. The lookup queries `slug_aliases` for any matching alias_slug in
   the provided source(s).
3. If found, returns the canonical_slug. The renderer then resolves
   the wikilink to the canonical page.

Multi-source ambiguity (same alias_slug in two registered sources)
emits a once-per-process `multi_match` stderr warning and returns the
first match by source array order. Federated reads pass the full
allowed-source array.

## Search ranking signal: alias_resolved_boost

Post-unify, search results whose slug is a canonical_slug in
slug_aliases get a 1.05x score multiplier via the
`applyAliasResolvedBoost` post-fusion stage. Semantic intent: "user
explicitly disambiguated this as canonical, so it should outrank fuzzy
matches that hit aliases by accident."

`SearchResult.alias_resolved_boost` is stamped on touched results for
`--explain` formatter visibility. KNOBS_HASH_VERSION bumped 5→6 to
invalidate pre-v0.42 cache rows that don't reflect the new stage.

## Reference

- Issue: https://github.com/garrytan/gbrain/issues/1479
- Pack file: `src/core/schema-pack/base/gbrain-base-v2.yaml`
- Pack-upgrade mechanism: `docs/architecture/pack-upgrade-mechanism.md`
- Migration handler: `src/core/schema-pack/unify-types-handler.ts`
- Onboard checks: `src/core/onboard/checks.ts`
- Skill: `skills/schema-unify/SKILL.md`
- Plan + decisions: `~/.claude/plans/system-instruction-you-are-working-transient-elephant.md`
