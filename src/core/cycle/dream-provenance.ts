import type { BrainEngine } from '../engine.ts';
import { throwIfAborted } from '../abort-check.ts';

/**
 * Dream-provenance DB stamp (#2569): marks pages a dream child wrote with
 * `dream_generated` and a stable first cycle date. Shared by synthesize and
 * patterns (#5733); a page that existed before the child's first write to it
 * is not stamped.
 */
export async function stampDreamProvenance(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string; first_write_at?: Date }>,
  cycleDate: string,
  signal?: AbortSignal,
): Promise<void> {
  if (refs.length === 0) return;
  const { executeRawJsonb } = await import('../sql-query.ts');
  for (const { slug, source_id, raw_source, first_write_at } of refs) {
    // #4077: per-row abort check — the per-row try below is only for stamp
    // failures and must not swallow the cancellation unwind.
    throwIfAborted(signal, '[dream] synthesize provenance');
    try {
      await executeRawJsonb(
        engine,
        `UPDATE pages
            SET frontmatter = COALESCE(frontmatter, '{}'::jsonb)
                              || $5::jsonb
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
        [slug, source_id, cycleDate, first_write_at?.toISOString() ?? null],
        // #1978 raw-source persistence: record the transcript path the
        // synthesis was derived from, so `gbrain doctor` (raw_provenance
        // check) can verify every generated page carries a raw trace.
        [{
          dream_generated: true,
          ...(raw_source ? { raw_source } : {}),
        }],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] provenance stamp ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
}
