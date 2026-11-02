import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';

/**
 * #7814: the v0.13.1 grandfather no longer writes `validate: false` into pages
 * (src/commands/migrations/v0_13_1.ts). A `managed_grandfather` request an
 * older binary admitted and left queued ends here without writing, so an
 * upgrade never finishes a grandfather rewrite of the user's files.
 */
export async function prepareGrandfatherMutation(_engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  throw opError('revision_conflict', 'Grandfathering is retired; the page was left unchanged.',
    `${row.slug} in ${row.source_id} was queued for the retired v0.13.1 validate: false stamp by an older gbrain; `
    + 'upgrades no longer rewrite pages (#7814), so nothing changed and nothing else is needed.');
}
