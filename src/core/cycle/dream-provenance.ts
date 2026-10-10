import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { derivedMaintenanceTransaction } from '../trust/taint.ts';
import type { TaintInput, WriteTrust } from '../trust/tier.ts';

/**
 * Dream-provenance DB stamp (#2569): marks pages a dream child wrote with
 * `dream_generated` and a stable first cycle date. Shared by synthesize and
 * patterns (#5733); a page that existed before the child's first write to it
 * is not stamped. `seat` (#4618) credits the capturing agent seat; `seat: null`
 * removes a seat the page no longer earns (a pattern whose reflections no
 * longer share one).
 *
 * #5575 I2: a ref carrying `derivation` (the tier of everything in the
 * child's prompt) is stamped at that tier, and the page the child wrote is
 * lowered to it and gets its input edges even when it is not dream-owned:
 * the child wrote it from that prompt either way.
 */
export async function stampDreamProvenance(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string; seat?: string | null; raw_trace_exempt_reason?: string; first_write_at?: Date;
    derivation?: { trust: WriteTrust; inputs: readonly TaintInput[] } }>,
  cycleDate: string,
  signal?: AbortSignal,
): Promise<void> {
  if (refs.length === 0) return;
  const { executeRawJsonb } = await import('../sql-query.ts');
  for (const { slug, source_id, raw_source, seat, raw_trace_exempt_reason, first_write_at, derivation } of refs) {
    // #4077: per-row abort check — the per-row try below is only for stamp
    // failures and must not swallow the cancellation unwind.
    throwIfAborted(signal, '[dream] synthesize provenance');
    try {
      const stamp = (tx: BrainEngine) => executeRawJsonb(
        tx,
        `UPDATE pages
            SET frontmatter = (COALESCE(frontmatter, '{}'::jsonb) - CASE WHEN $5::boolean THEN 'seat' ELSE '' END)
                              || $6::jsonb
                              || jsonb_build_object(
                                   'dream_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3),
                                   'dream_created_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3)
                                 )
          WHERE slug = $1 AND source_id = $2
            AND ($4::timestamptz IS NULL
                 OR frontmatter->>'dream_generated' = 'true'
                 OR created_at >= $4::timestamptz)`,
        // C-8: a page that existed before the child's first write to it is
        // not dream output; stamping it would hide it from extract_facts
        // and transcript discovery forever.
        [slug, source_id, cycleDate, first_write_at?.toISOString() ?? null, seat === null],
        // #1978 raw-source persistence: record the transcript path the
        // synthesis was derived from, so `gbrain doctor` (raw_provenance
        // check) can verify every generated page carries a raw trace.
        [{
          dream_generated: true,
          ...(raw_source ? { raw_source } : {}),
          ...(seat ? { seat } : {}),
          ...(raw_trace_exempt_reason ? { raw_trace_exempt: true, raw_trace_exempt_reason } : {}),
        }],
      );
      if (!derivation) await maintenanceTransaction(engine, stamp);
      else await derivedMaintenanceTransaction(engine, derivation, async tx => {
        await stamp(tx);
        const pages = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL', [slug, source_id]);
        return { result: undefined, rows: pages.map(p => ({ table: 'pages' as const, id: Number(p.id), sourceId: source_id })) };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] provenance stamp ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
}
