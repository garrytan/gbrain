---
name: schema-unify
description: Migrate a brain from gbrain-base (or any pack) to gbrain-base-v2's 14-canonical-type taxonomy via gbrain onboard --check + the unify-types Minion handler. Collapses 94 noisy types to 15 canonical with subtypes, alias rows, and link rows. Triggers when an agent notices pack_upgrade_available, type_proliferation, or asks "what is the canonical taxonomy / how do I clean up my page types".
brain_first: exempt
tools:
  - gbrain onboard --check
  - gbrain onboard --check --explain
  - gbrain onboard --check --json
  - gbrain jobs submit unify-types
  - gbrain jobs follow
  - gbrain schema active
  - gbrain schema use
  - gbrain schema stats
  - gbrain pages restore
  - mcp:run_onboard
triggers:
  - "unify my types"
  - "migrate to gbrain-base-v2"
  - "94 types to 14"
  - "apply canonical taxonomy"
  - "clean up my page types"
  - "pack upgrade"
  - "shrink type proliferation"
  - "what does the canonical taxonomy look like"
  - "consolidate page types"
  - "retype pages to canonical"
---

# Schema Unification (gbrain-base → gbrain-base-v2)

v0.41.22 ships **gbrain-base-v2** — a 15-type DRY/MECE taxonomy (14 canonical + `note` catch-all) — as the install default for new brains. Existing brains on `gbrain-base` can opt in via the `pack_upgrade_available` onboard finding + the `unify-types` PROTECTED Minion handler.

This skill is the playbook for that migration.

## brain_first: exempt

This skill is ABOUT the brain's shape — it can't depend on the brain it's reshaping. No `gbrain search` lookup first; jump straight to onboard.

## When this skill fires

- Agent runs `gbrain onboard --check` and sees `pack_upgrade_available` or `type_proliferation` warnings
- User asks "what is the canonical taxonomy / how do I clean up my page types / migrate to v2"
- A `dangling_aliases` finding surfaces (post-unify GC)
- An agent ingesting from a custom pack wants to consult the v2 taxonomy as a reference

## Mental model (one paragraph)

A production gbrain brain accreted **94 distinct `pages.type` values** over years of ingestion: tweet / tweet-thread / tweet-bundle / tweet-single / media/x-tweet/bundle / tweet-stub all coexisting; 5.5K concept-redirect pages; atom-partner-link pages that should be links; civic / framework / insight / memo / anecdote one-offs. The cure: collapse to **15 canonical types** (person, company, media, tweet, social-digest, analysis, atom, concept, source, deal, email, slack, writing, project, note) with subtypes/format/origin pushed to frontmatter, alias-rows for redirects, real link-rows for edge-shaped pages, and a catch-all that bins long-tail unknowns to `note` with `frontmatter.legacy_type = <original>` for rollback.

## Workflow

### Phase 1: Discovery

Confirm the brain is actually on `gbrain-base` (not already on v2).

```bash
gbrain schema active --json | jq -r '.identity'
```

Expected: `gbrain-base@1.0.0+<sha>`. If you see `gbrain-base-v2@...`, the brain is already on v2 — skip the migration.

Then run onboard to see what would change:

```bash
gbrain onboard --check
```

Look for the `pack_upgrade_available` finding. If it's `ok`, there's no successor declared for the active pack — done.

### Phase 2: Preview

Run the per-cluster narrative:

```bash
gbrain onboard --check --explain
```

This invokes the `unify-types` handler in dry-run mode and prints:
- How many pages would retype per cluster (tweets, articles, companies, etc.)
- How many concept-redirect pages would become alias rows
- How many edge-shaped pages would convert to real links
- The synthesized catch-all rules for unknown types

Review the output. If the proposed changes look wrong, **don't** proceed — file an issue or write a custom pack with adjusted mapping_rules.

### Phase 3: Apply

The handler is PROTECTED (manual_only per D17) — autopilot will never auto-fire it. Submit explicitly:

```bash
gbrain jobs submit unify-types \
  --allow-protected \
  --params '{"target_pack":"gbrain-base-v2"}'
```

Watch progress per phase:

```bash
gbrain jobs follow <job_id>
```

On a 186K-page brain expect ~10 minutes. The handler runs:
1. Preflight (validate target pack has `mapping_rules:`)
2. Stats snapshot (pre-state for celebration summary)
3. Acquire `gbrain-unify` db-lock (60min TTL)
4. Apply phases:
   - Explicit retype rules (tweets, articles, companies, etc.)
   - Catch-all retype (unknown types → note with legacy_type)
   - Page-to-link rules (atom-partner-link, symlink)
   - Page-to-alias rules (concept-redirect)
5. Final sync (untyped rows by path-prefix)
6. **Flip active pack** to gbrain-base-v2 (D13)
7. Verify + celebration summary

### Phase 4: Verify

```bash
gbrain onboard --check
gbrain schema stats
```

Expected:
- `pack_upgrade_available` → `ok` (active pack is now v2)
- `type_proliferation` → `ok` (≤16 distinct typed values)
- `dangling_aliases` → `ok` (slug_aliases all point at active canonicals)
- `gbrain schema stats` shows ≤16 distinct types

### Phase 5: Post-migration

Anything that used `--type article` keeps working post-unify if your CLI calls go through the `expandTypeFilter` helper (it expands `article` to `media+subtype=article` automatically). Direct SQL against `pages.type` needs updating to the canonical types.

Search queries get a small ranking signal: pages reached via `slug_aliases` (canonicals of one or more aliases) get a 1.05x boost. Visible via `gbrain search --explain`.

## Rollback

Every retyped page preserves `frontmatter.legacy_type = <original>` per D8. Restore types via:

```sql
UPDATE pages SET type = frontmatter->>'legacy_type'
WHERE source_id = 'default' AND frontmatter->>'legacy_type' IS NOT NULL;
```

Page-to-alias and page-to-link source pages soft-delete with 72h TTL. Restore within that window:

```bash
gbrain pages restore <slug>
```

Revert the active pack flip:

```bash
gbrain schema use gbrain-base
```

## Anti-patterns

- **Don't run unify-types under autopilot.** It's manual_only by design. Autopilot remediation should never silently change your taxonomy.
- **Don't expect mapping_rules to cover every legacy type explicitly.** Use the catch-all (`*unknown*`) for the long tail. Pages get retyped to `note` with `legacy_type` preserved.
- **Don't rewrite body-text wikilinks.** D15: the slug_aliases table IS the resolver. `[[old-redirect-slug]]` keeps working via `engine.resolveSlugWithAlias` short-circuit.
- **Don't bypass the dry-run.** Always run `--explain` before applying. The trust delta is real.
- **Don't run two unify jobs concurrently.** The `gbrain-unify` db-lock serializes them; the second submission rejects with "already in progress."

## Decision tree

```
Active pack already gbrain-base-v2?
  → Skip migration.

Custom pack with own mapping_rules?
  → Run --check --explain to see if your pack declares migration_from
    for the active pack. If yes, target_pack = your pack name.

Brain has many custom types not covered by gbrain-base-v2 mapping_rules?
  → The catch-all retype binds them to `note` with legacy_type preserved.
    Review by inspecting frontmatter.legacy_type after the migration.

Federated brain (multiple sources)?
  → Add --params source_id to scope the migration per-source. Each
    source can be migrated independently.

Worried about a specific cluster's mapping?
  → Fork gbrain-base-v2 (`gbrain schema fork gbrain-base-v2 my-pack`),
    edit mapping_rules in your fork, then target the fork.
```

## Contract

Inputs:
- A brain on `gbrain-base` (or any pack with `migration_from: gbrain-base-v2`).
- Write access to submit a PROTECTED Minion handler (`--allow-protected`).
- ~10 min wallclock on a 186K-page brain.

Outputs:
- Pages retyped to canonical types with `frontmatter.legacy_type` preserved (per-page rollback signal).
- `slug_aliases` rows for concept-redirect pages (alias table IS the resolver — no link rewrite).
- Real `links` rows for edge-shaped pages (`atom-partner-link`, `symlink`, etc.).
- Active pack flipped to `gbrain-base-v2` atomically at end of successful run.

Side effects:
- Source pages soft-deleted with 72h restore TTL (`gbrain pages restore <slug>`).
- One-time cache invalidation on KNOBS_HASH_VERSION bump (5→6); self-healing in `cache.ttl_seconds`.
- Query-time `--type X` alias-expands via `expandTypeFilter` (D14 back-compat).

Failure modes:
- Concurrent submission rejected by the `gbrain-unify` db-lock; second call exits gracefully.
- Catch-all retype excludes `page_to_link` + `page_to_alias` source types (caught in E2E pre-merge).
- Phase failures abort the run before `active_pack_flipped`; partial state restorable via op_checkpoint resume.

## Anti-Patterns

DON'T:
- Submit `unify-types` directly via the MCP `submit_job` op without `--allow-protected`. PROTECTED handlers require trusted local callers; remote MCP rejection is the intentional trust boundary.
- Edit `mapping_rules` in `gbrain-base-v2.yaml` to skip clusters you don't trust. Fork the pack instead (`gbrain schema fork`) so the source-of-truth migration stays consistent across brains.
- Run `unify-types` from inside an autopilot tick. The check is `manual_only` per D17 — autopilot deliberately never auto-fires it because pack upgrades are one-time consenting taxonomy decisions.
- Hard-delete soft-deleted source pages before the 72h restore window. Use `gbrain pages restore <slug>` first if rollback is needed.
- Assume `frontmatter.legacy_type` survives every roundtrip. The marker is canonical for the immediate post-migration window; downstream re-imports may overwrite it.

## Output Format

Per phase, the handler emits to stderr:
```
[unify-types] phase=retype-explicit applied=N skipped=M  cost=USD  ttl=Ns
[unify-types] phase=retype-catch-all applied=N
[unify-types] phase=page-to-link converted=N pages soft-deleted
[unify-types] phase=page-to-alias aliased=N pages soft-deleted
[unify-types] phase=sync residual=N
[unify-types] active_pack flipped from gbrain-base to gbrain-base-v2
```

Final celebration summary to stderr:
```
═══════════════════════════════════════════════════════════
  gbrain-base-v2 migration complete
═══════════════════════════════════════════════════════════
  Before: 94 distinct page types
  After:  15 canonical types
  Retyped:      25,632 pages
  Aliased:       5,521 redirects → slug_aliases table
  Linkified:        65 ghost pages → real link rows
  Soft-deleted:  5,586 pages (restorable for 72h)
═══════════════════════════════════════════════════════════
```

JSON output (`gbrain jobs follow <id> --json`) returns the structured `UnifyTypesResult` shape with `per_phase`, `pack_identity_after`, `active_pack_flipped`.

## Reference

- Plan + decisions: `~/.claude/plans/system-instruction-you-are-working-transient-elephant.md`
- Architecture: `docs/architecture/type-taxonomy.md`
- Pack-upgrade mechanism: `docs/architecture/pack-upgrade-mechanism.md`
- Issue: https://github.com/garrytan/gbrain/issues/1479
