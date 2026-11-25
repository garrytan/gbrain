import type { BrainEngine } from '../engine.ts';
import { readFirstIngestEvidence, type FirstIngestRecovery, type IngestStamps } from '../engine-sql/ingest-provenance.ts';
import { digest } from '../persistence/digest.ts';
import type { DriftItem } from './provenance-drift.ts';

function matches(stamps: IngestStamps, original: IngestStamps): boolean {
  return stamps.source_kind === original.source_kind && stamps.ingested_via === original.ingested_via
    && stamps.ingested_at === original.ingested_at;
}

/** Recover only an original server-stamped managed creation witnessed by its own committed receipt and first snapshot. */
export async function readFirstIngestRecovery(engine: BrainEngine, item: DriftItem): Promise<FirstIngestRecovery | null> {
  const { verdict } = item;
  if (!verdict.columnEditRequest || verdict.marker_lost || verdict.marker_missing) return null;
  const row = await readFirstIngestEvidence(engine, item);
  if (!row) return null;
  // Managed put_page uses the admitted receipt's timestamp as a JavaScript ISO string for the initial stamps.
  const original = { source_kind: row.creation_channel, ingested_via: row.creation_channel,
    ingested_at: new Date(row.creation_stamp).toISOString() };
  if (!matches(row.archived_stamps, original) || !matches(row.canonical_stamps, original)) return null;
  return { source_id: item.source_id, slug: item.slug, page_id: item.page_id, revision: item.revision,
    source_incarnation: row.incarnation, creation_request: row.creation_request, edit_request: verdict.columnEditRequest,
    before: row.database_stamps, original };
}

export const firstIngestRecoveryDigest = (plan: FirstIngestRecovery) => digest(['first-ingest-recovery-v1', plan]);
