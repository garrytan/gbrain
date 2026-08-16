/**
 * Schema-pack doctor checks — verbatim peel from src/commands/doctor.ts
 * (containment sprint). No behavior change; doctor.ts re-exports
 * multiSourceDriftAdvice and doctorReportRemote consumes the three checks.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { Check } from '../doctor.ts';

// =================================================================
// v0.39 T7 + T9 — schema-pack doctor checks
// =================================================================
// Three checks per v0.38 CEO plan that never shipped at v0.38 time:
//   schema_pack_active       — does the active pack resolve cleanly?
//   schema_pack_consistency  — what % of pages match the active pack?
//   schema_pack_source_drift — do per-source packs disagree?
// All three are warn-only; never fail-block.

export async function checkSchemaPackActive(engine: BrainEngine): Promise<Check> {
  try {
    const { loadActivePack } = await import('../../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../../core/config.ts');
    const pack = await loadActivePack({ cfg: loadConfig(), remote: false });
    return {
      name: 'schema_pack_active',
      status: 'ok',
      message: `Active pack: ${pack.manifest.name} v${pack.manifest.version} (${pack.manifest.page_types.length} types, ${pack.manifest.link_types?.length ?? 0} link verbs)`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_active',
      status: 'warn',
      message: `Active pack failed to resolve: ${(e as Error).message}. Run \`gbrain schema active\` to debug.`,
    };
  }
}

export async function checkSchemaPackConsistency(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ src: string; total: string | number; untyped: string | number }>(
      `SELECT
         source_id AS src,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped
       FROM pages
       WHERE deleted_at IS NULL
       GROUP BY source_id
       ORDER BY source_id`,
    );
    if (rows.length === 0) {
      return { name: 'schema_pack_consistency', status: 'ok', message: 'No pages in any source — schema consistency N/A.' };
    }
    let worstPct = 0;
    let worstSrc = '';
    let worstUntyped = 0;
    let worstTotal = 0;
    for (const r of rows) {
      const total = Number(r.total);
      const untyped = Number(r.untyped);
      if (total === 0) continue;
      const pct = untyped / total;
      if (pct > worstPct) {
        worstPct = pct;
        worstSrc = r.src;
        worstUntyped = untyped;
        worstTotal = total;
      }
    }
    if (worstPct === 0) {
      return { name: 'schema_pack_consistency', status: 'ok', message: 'All pages match the active schema pack across every source.' };
    }
    const pctStr = (worstPct * 100).toFixed(1);
    if (worstPct >= 0.1) {
      return {
        name: 'schema_pack_consistency',
        status: 'warn',
        message: `Source \`${worstSrc}\`: ${worstUntyped} of ${worstTotal} pages (${pctStr}%) have no type matching the active pack. Run \`gbrain schema detect --source ${worstSrc}\` to propose a pack matching your content shape.`,
      };
    }
    return {
      name: 'schema_pack_consistency',
      status: 'ok',
      message: `${pctStr}% untyped at worst (source \`${worstSrc}\`) — under the 10% warn threshold.`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_consistency',
      status: 'ok',
      message: `Skipped: ${(e as Error).message}`,
    };
  }
}

export async function checkSchemaPackSourceDrift(engine: BrainEngine): Promise<Check> {
  try {
    // Compare per-source schema_pack overrides (tier 3 DB config) to detect
    // multi-source brains where different sources point at conflicting packs.
    const rows = await engine.executeRaw<{ key: string; value: string }>(
      `SELECT key, value FROM config WHERE key LIKE 'schema_pack.source.%'`,
    );
    if (rows.length === 0) {
      return { name: 'schema_pack_source_drift', status: 'ok', message: 'No per-source pack overrides — drift N/A.' };
    }
    const distinctPacks = new Set(rows.map((r) => r.value).filter(Boolean));
    if (distinctPacks.size <= 1) {
      return { name: 'schema_pack_source_drift', status: 'ok', message: `${rows.length} per-source overrides; all point at the same pack.` };
    }
    return {
      name: 'schema_pack_source_drift',
      status: 'warn',
      message: `Per-source pack divergence detected: ${distinctPacks.size} distinct packs across ${rows.length} sources. Run \`gbrain sources list\` then \`gbrain schema active --source <id>\` per source to audit.`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_source_drift',
      status: 'ok',
      message: `Skipped: ${(e as Error).message}`,
    };
  }
}

/**
 * #1123 — multi_source_drift remediation advice. Exported so the regression
 * test can pin that it only references CLI surfaces that actually exist
 * (the pre-fix text pointed at 'gbrain sources rehome', which was never
 * built, and at 'gbrain delete <slug>' without explaining that delete
 * targets the ACTIVE source — following it literally on a multi-source
 * brain deletes the correctly-routed row).
 */
export function multiSourceDriftAdvice(count: number, sampleStr: string): string {
  return (
    `${count} page slug(s) appear at 'default' but NOT at the intended source ` +
    `(e.g., ${sampleStr}). Two possible causes: (1) pre-v0.30.3 putPage misroutes; ` +
    `(2) the intended source never completed initial sync and the default page is unrelated. ` +
    `Verify with 'gbrain sources status', then re-sync with ` +
    `'gbrain sync --source <id> --full' (reconciles drift without deleting data). ` +
    `If a misrouted default-source row remains after re-sync, remove it with ` +
    `'GBRAIN_SOURCE=default gbrain delete <slug>' — delete targets the active source, ` +
    `so pin it to 'default' explicitly.`
  );
}
