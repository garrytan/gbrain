// v0.42 Type Unification (T10) — unify-types PROTECTED Minion handler.
//
// Lifecycle (non-interactive per Codex F14; the CLI orchestrator
// `gbrain onboard` owns the prompt):
//   1. Preflight: load target pack; refuse if no mapping_rules; pack-load
//      validation already rejected cyclic aliases + invalid subtype_field.
//   2. Stats snapshot (pre-state for celebration summary).
//   3. Acquire `gbrain-unify` db-lock (mirrors gbrain-sync pattern).
//   4. Apply in dependency order:
//        a. Explicit retype rules
//        b. Catch-all retype (D12: from_type='*unknown*' expanded per-type)
//        c. page_to_link rules
//        d. page_to_alias rules
//   5. Final sync (runSyncCore) for residual UNTYPED rows.
//   6. Active-pack flip (D13): write schema_pack config = target_pack.
//   7. Verify: re-run stats; assert distinct typed count ≤ pack.page_types.length + 5.
//   8. Celebration summary to stderr.
//   9. Audit JSONL.
//   10. Resume via per-batch op_checkpoint (deferred: v0.43+; v0.42 ships
//       the lifecycle but resume is best-effort via the primitives' own
//       idempotency — retype skips already-retyped rows; page-to-alias
//       ON CONFLICT DO NOTHING; page-to-link soft-delete idempotent).
//
// PROTECTED (joins src/core/minions/protected-names.ts). manual_only via
// src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS allowlist.

// Handlers receive `engine` via the worker registration closure (jobs.ts);
// this module exports `runUnifyTypes` as a pure function consuming
// OperationContext, and jobs.ts wires it.

import type { OperationContext } from '../operations.ts';
import { runRetypeCore, type RetypeRule, UNKNOWN_TYPE_SENTINEL, ORIGINAL_TYPE_SENTINEL } from './retype.ts';
import { runPageToLinkCore, type PageToLinkRule } from './page-to-link.ts';
import { runPageToAliasCore, type PageToAliasRule } from './page-to-alias.ts';
import { loadActivePack } from './load-active.ts';
import { runStatsCore } from './stats.ts';
import { runSyncCore } from './sync.ts';
import { tryAcquireDbLock, type DbLockHandle } from '../db-lock.ts';
import type { PackMappingRule } from './manifest-v1.ts';

export interface UnifyTypesInput {
  /** The pack name to upgrade TO (e.g. 'gbrain-base-v2'). */
  target_pack: string;
  /** Apply mutations. Default false (dry-run). */
  apply?: boolean;
  /** Source ID to scope (codex C5 write-side). Omit for whole-brain. */
  sourceId?: string;
  /** Stderr/audit progress hook. */
  onProgress?: (msg: string) => void;
}

export interface UnifyTypesResult {
  schema_version: 1;
  apply: boolean;
  target_pack: string;
  pack_identity_before: string | null;
  pack_identity_after: string | null;
  stats_before: { total_pages: number; distinct_types: number };
  stats_after: { total_pages: number; distinct_types: number };
  per_phase: {
    retype_explicit: { rules: number; would_apply: number; applied: number };
    retype_catch_all: { synthesized_rules: number; would_apply: number; applied: number };
    page_to_link: { rules: number; would_convert: number; converted: number };
    page_to_alias: { rules: number; would_alias: number; aliased: number };
    final_sync: { total_would_apply: number; total_applied: number };
  };
  active_pack_flipped: boolean;
  warnings: string[];
}

/**
 * Pure orchestrator for the unify-types handler. Engine is supplied via
 * OperationContext. Caller (jobs.ts wrapper) wires engine + onProgress.
 *
 * D13: at end of successful apply, flips `schema_pack` config to target_pack.
 * D17 (handled at submit/render layer): manual_only so autopilot never
 * auto-fires this.
 */
export async function runUnifyTypes(
  ctx: OperationContext,
  input: UnifyTypesInput,
): Promise<UnifyTypesResult> {
  const apply = input.apply === true;
  const sourceId = input.sourceId;
  const onProgress = input.onProgress ?? (() => {});
  const warnings: string[] = [];

  onProgress(`[unify-types] starting (apply=${apply}, target_pack=${input.target_pack})`);

  // 1. Preflight — load target pack
  const targetPack = await loadActivePack({
    cfg: null,
    remote: false,
    perCall: input.target_pack,
  });
  if (!targetPack.manifest.mapping_rules || targetPack.manifest.mapping_rules.length === 0) {
    throw new Error(
      `[unify-types] target pack '${input.target_pack}' has no mapping_rules; ` +
      `nothing to unify. Did you mean a different pack?`,
    );
  }

  // 2. Stats snapshot
  const statsBeforeRaw = await runStatsCore(ctx, { sourceId });
  const stats_before = {
    total_pages: statsBeforeRaw.aggregate.total_pages,
    distinct_types: statsBeforeRaw.aggregate.by_type.length,
  };
  onProgress(
    `[unify-types] pre-state: ${stats_before.total_pages} pages, ` +
    `${stats_before.distinct_types} distinct types`,
  );

  // Pack identity capture
  const activePackBefore = await loadActivePack({ cfg: null, remote: false });
  const pack_identity_before = activePackBefore.identity;

  // 3. Acquire db-lock
  let lockHandle: DbLockHandle | null = null;
  if (apply) {
    lockHandle = await tryAcquireDbLock(ctx.engine, 'gbrain-unify', 60);
    if (lockHandle === null) {
      throw new Error(
        `[unify-types] could not acquire gbrain-unify db-lock (held by another process). ` +
        `Wait for the other unify run to complete (lock TTL: 60min).`,
      );
    }
    onProgress(`[unify-types] gbrain-unify lock acquired`);
  }

  try {
    // Partition mapping_rules by kind
    const explicitRetypeRules: RetypeRule[] = [];
    let catchAllRule: { to_type: string; subtype?: string; subtype_field?: string } | null = null;
    const pageToLinkRules: PageToLinkRule[] = [];
    const pageToAliasRules: PageToAliasRule[] = [];
    for (const rule of targetPack.manifest.mapping_rules as PackMappingRule[]) {
      if (rule.kind === 'retype') {
        if (rule.from_type === UNKNOWN_TYPE_SENTINEL) {
          if (catchAllRule) {
            warnings.push(`Multiple catch-all retype rules declared; last one wins.`);
          }
          catchAllRule = {
            to_type: rule.to_type,
            subtype: rule.subtype,
            subtype_field: rule.subtype_field,
          };
        } else {
          explicitRetypeRules.push({
            from_type: rule.from_type,
            to_type: rule.to_type,
            subtype: rule.subtype,
            subtype_field: rule.subtype_field,
            path_filter: rule.path_filter,
          });
        }
      } else if (rule.kind === 'page_to_link') {
        pageToLinkRules.push({
          from_type: rule.from_type,
          link_type: rule.link_type,
          source_slug_from: rule.source_slug_from,
          target_slug_from: rule.target_slug_from,
          inverse: rule.inverse,
          preserve_notes: rule.preserve_notes,
        });
      } else if (rule.kind === 'page_to_alias') {
        pageToAliasRules.push({
          from_type: rule.from_type,
          canonical_from: rule.canonical_from,
          alias_slug_from: rule.alias_slug_from,
          notes_from: rule.notes_from,
        });
      }
    }

    // 4a. Explicit retype rules
    onProgress(`[unify-types] phase: retype-explicit (${explicitRetypeRules.length} rules)`);
    const retypeExplicit = explicitRetypeRules.length === 0
      ? { total_would_apply: 0, total_applied: 0 }
      : await runRetypeCore(ctx, { rules: explicitRetypeRules, apply, sourceId });

    // 4b. Catch-all expansion: query for distinct types NOT in pack page_types
    //     AND NOT the target of any explicit retype rule AND NOT a page_to_link
    //     or page_to_alias from_type (those are handled by their own phases).
    //     Synthesize a rule per unknown type that retypes to catchAllRule.to_type
    //     with subtype = original_type (via the ORIGINAL_TYPE_SENTINEL substitution).
    let retypeCatchAll = { synthesized_rules: 0, total_would_apply: 0, total_applied: 0 };
    if (catchAllRule) {
      const declaredTypes = new Set(targetPack.manifest.page_types.map((pt) => pt.name));
      const explicitTargets = new Set(
        explicitRetypeRules.map((r) => r.from_type),
      );
      // Also exclude page_to_link + page_to_alias source types — those pages
      // are claimed by their dedicated phases (4c + 4d). Without this, the
      // catch-all retypes them to `note` BEFORE the alias/link phases can
      // process them, breaking the migration.
      const pageToLinkTargets = new Set(pageToLinkRules.map((r) => r.from_type));
      const pageToAliasTargets = new Set(pageToAliasRules.map((r) => r.from_type));
      // Find distinct types in the brain not covered by any other phase.
      const where = sourceId
        ? `WHERE deleted_at IS NULL AND type IS NOT NULL AND source_id = $1`
        : `WHERE deleted_at IS NULL AND type IS NOT NULL`;
      const params = sourceId ? [sourceId] : [];
      const rows = await ctx.engine.executeRaw<{ type: string }>(
        `SELECT DISTINCT type FROM pages ${where} ORDER BY type`,
        params,
      );
      const unknownTypes = rows
        .map((r) => r.type)
        .filter((t) => !declaredTypes.has(t)
          && !explicitTargets.has(t)
          && !pageToLinkTargets.has(t)
          && !pageToAliasTargets.has(t));
      onProgress(
        `[unify-types] phase: retype-catch-all (${unknownTypes.length} synthesized rules)`,
      );
      if (unknownTypes.length > 0) {
        const synthesized: RetypeRule[] = unknownTypes.map((ut) => ({
          from_type: ut,
          to_type: catchAllRule!.to_type,
          subtype_field: (catchAllRule!.subtype_field ?? 'legacy_type') as RetypeRule['subtype_field'],
          subtype: catchAllRule!.subtype === ORIGINAL_TYPE_SENTINEL
            ? ut
            : catchAllRule!.subtype,
        }));
        const result = await runRetypeCore(ctx, { rules: synthesized, apply, sourceId });
        retypeCatchAll = {
          synthesized_rules: synthesized.length,
          total_would_apply: result.total_would_apply,
          total_applied: result.total_applied,
        };
      }
    }

    // 4c. page_to_link rules
    onProgress(`[unify-types] phase: page-to-link (${pageToLinkRules.length} rules)`);
    const pageToLink = pageToLinkRules.length === 0
      ? { total_would_convert: 0, total_converted: 0 }
      : await runPageToLinkCore(ctx, { rules: pageToLinkRules, apply, sourceId });

    // 4d. page_to_alias rules
    onProgress(`[unify-types] phase: page-to-alias (${pageToAliasRules.length} rules)`);
    const pageToAlias = pageToAliasRules.length === 0
      ? { total_would_alias: 0, total_aliased: 0 }
      : await runPageToAliasCore(ctx, { rules: pageToAliasRules, apply, sourceId });

    // 5. Final sync — typing residual UNTYPED rows by path prefix.
    onProgress(`[unify-types] phase: final-sync (path-prefix typing for untyped rows)`);
    const finalSync = await runSyncCore(ctx, { apply, sourceId });

    // 6. Active-pack flip (D13). Apply path only; dry-run leaves config alone.
    let active_pack_flipped = false;
    let pack_identity_after = pack_identity_before;
    if (apply) {
      // Write to BOTH:
      //   - DB config (engine.setConfig) — covers federated/multi-source brains
      //     where future loadActivePack calls thread dbConfig from `config` table.
      //   - File-plane config (saveConfig) — covers loadActivePack({ cfg, ... })
      //     callers that read from ~/.gbrain/config.json (homeConfig tier).
      // Without the file-plane write the local CLI loadActivePack callers
      // wouldn't see the flip and pack_upgrade_available would keep firing.
      await ctx.engine.setConfig('schema_pack', input.target_pack);
      try {
        const { loadConfigFileOnly, saveConfig } = await import('../config.ts');
        const existing = loadConfigFileOnly() ?? ({} as Record<string, unknown>);
        saveConfig({ ...existing, schema_pack: input.target_pack } as never);
      } catch (e) {
        warnings.push(
          `Active-pack flip wrote to DB but file-plane saveConfig failed: ` +
          `${(e as Error).message}. Run \`gbrain schema use ${input.target_pack}\` ` +
          `manually to ensure local CLI sees the flip.`,
        );
      }
      active_pack_flipped = true;
      const activeAfter = await loadActivePack({
        cfg: { schema_pack: input.target_pack } as never,
        remote: false,
      });
      pack_identity_after = activeAfter.identity;
      onProgress(`[unify-types] active pack flipped: ${pack_identity_before} → ${pack_identity_after}`);
    }

    // 7. Verify
    const statsAfterRaw = await runStatsCore(ctx, { sourceId });
    const stats_after = {
      total_pages: statsAfterRaw.aggregate.total_pages,
      distinct_types: statsAfterRaw.aggregate.by_type.length,
    };
    const expected = targetPack.manifest.page_types.length + 5; // safety margin
    if (apply && stats_after.distinct_types > expected) {
      warnings.push(
        `Post-unify distinct types (${stats_after.distinct_types}) exceeds pack declared ` +
        `(${targetPack.manifest.page_types.length}) + safety margin (5). ` +
        `Some types may not be covered by the catch-all rule; review with ` +
        `\`gbrain schema stats\`.`,
      );
    }

    // 8. Celebration summary
    if (apply) {
      const summaryLines = [
        '',
        '═══════════════════════════════════════════════════════════',
        `  ${input.target_pack} migration complete`,
        '═══════════════════════════════════════════════════════════',
        `  Before: ${stats_before.distinct_types} distinct page types`,
        `  After:  ${stats_after.distinct_types} distinct types`,
        ``,
        `  Retyped (explicit):  ${retypeExplicit.total_applied} pages`,
        `  Retyped (catch-all): ${retypeCatchAll.total_applied} pages (${retypeCatchAll.synthesized_rules} unknown types)`,
        `  Page→link:           ${pageToLink.total_converted} converted`,
        `  Page→alias:          ${pageToAlias.total_aliased} aliased`,
        `  Final sync:          ${finalSync.total_applied} residual untyped typed`,
        `  Active pack:         ${pack_identity_after}`,
        '═══════════════════════════════════════════════════════════',
        '',
      ];
      for (const line of summaryLines) onProgress(line);
    }

    return {
      schema_version: 1,
      apply,
      target_pack: input.target_pack,
      pack_identity_before,
      pack_identity_after,
      stats_before,
      stats_after,
      per_phase: {
        retype_explicit: {
          rules: explicitRetypeRules.length,
          would_apply: retypeExplicit.total_would_apply,
          applied: retypeExplicit.total_applied,
        },
        retype_catch_all: {
          synthesized_rules: retypeCatchAll.synthesized_rules,
          would_apply: retypeCatchAll.total_would_apply,
          applied: retypeCatchAll.total_applied,
        },
        page_to_link: {
          rules: pageToLinkRules.length,
          would_convert: pageToLink.total_would_convert,
          converted: pageToLink.total_converted,
        },
        page_to_alias: {
          rules: pageToAliasRules.length,
          would_alias: pageToAlias.total_would_alias,
          aliased: pageToAlias.total_aliased,
        },
        final_sync: {
          total_would_apply: finalSync.total_would_apply,
          total_applied: finalSync.total_applied,
        },
      },
      active_pack_flipped,
      warnings,
    };
  } finally {
    if (lockHandle !== null) {
      try {
        await lockHandle.release();
        onProgress(`[unify-types] gbrain-unify lock released`);
      } catch (e) {
        onProgress(
          `[unify-types] WARNING: lock release failed (${(e as Error).message}); ` +
          `will release automatically via TTL.`,
        );
      }
    }
  }
}
