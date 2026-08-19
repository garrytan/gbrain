import { basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { executeRawJsonb } from '../sql-query.ts';

export interface DreamPageRef {
  slug: string;
  source_id: string;
  raw_source?: string;
}

/**
 * Persist stable cycle provenance plus evidence-backed `created` metadata.
 * Existing creation metadata and the first dream cycle both win over reruns.
 */
export async function stampDreamProvenance(
  engine: BrainEngine,
  refs: DreamPageRef[],
  cycleDate: string,
): Promise<void> {
  for (const { slug, source_id, raw_source } of refs) {
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
                              || CASE WHEN $4::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('created', COALESCE(NULLIF(frontmatter->>'created', ''), $4::text)) END
          WHERE slug = $1 AND source_id = $2`,
        [slug, source_id, cycleDate, dreamChildCreatedDate(slug, raw_source, cycleDate) ?? null],
        [{ dream_generated: true, dream_cycle_date: cycleDate, ...(raw_source ? { raw_source } : {}) }],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] provenance stamp ${slug}@${source_id} failed: ${msg}\n`);
    }
  }
}

/**
 * Resolve honest `created` metadata for a dream child page.
 *
 * A date-prefixed raw-source basename is first-party evidence and wins. A
 * dated slug is only a fallback when it differs from the cycle date: the
 * synthesis prompt injects the cycle date into names for undated sources, so
 * an equal date is ambiguous and must not be promoted to provenance.
 */
export function dreamChildCreatedDate(
  slug: string,
  rawSource: string | undefined,
  cycleDate: string,
): string | undefined {
  const sourceDate = rawSource ? datePrefixedBasename(rawSource) : undefined;
  if (sourceDate) return sourceDate;
  const slugDate = datePrefixedSlugSegment(slug);
  return slugDate && slugDate !== cycleDate ? slugDate : undefined;
}

function datePrefixedBasename(path: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\D|$)/.exec(basename(path));
  return match ? validIsoDate(match[1]) : undefined;
}

function datePrefixedSlugSegment(slug: string): string | undefined {
  const match = /(?:^|\/)(\d{4}-\d{2}-\d{2})(?:-|\/|$)/.exec(slug);
  return match ? validIsoDate(match[1]) : undefined;
}

function validIsoDate(value: string): string | undefined {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? value
    : undefined;
}
