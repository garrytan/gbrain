
import type { LegacyUnscopedRead } from './brands.ts';

/** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
export async function isFactPurged(exec: LegacyUnscopedRead, sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean> {
  const rows = await exec.executeRaw(`SELECT 1 FROM fact_purges WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)
    AND (subject = '*' OR subject = $4::text) LIMIT 1`, [sourceId, visibility, claim, entitySlug]);
  return rows.length > 0;
}
