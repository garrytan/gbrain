/**
 * credential_projection_pending doctor check (security wave ENG-2): pages whose
 * canonical body holds a private-key marker and whose chunks are withheld from
 * every search path until the provider-free credential-safe re-chunk seals
 * them. Counts the pages the v0.60.31 migration can re-chunk, the ones it held
 * after a failed re-chunk (retried by `gbrain repair safe-chunks`) and,
 * separately, code pages without a recorded source path that wait for their
 * importer.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { credentialProjectionPending, readCredentialResealHolds } from '../../../core/page-state/credential-reseal.ts';

export async function credentialProjectionPendingCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'credential_projection_pending';
  try {
    const { rebuildable, kept } = await credentialProjectionPending(engine, sourceIds);
    // GBRA-130 A-27: pages whose re-chunk failed are held; the migration completed, so they are retried by repair safe-chunks.
    const held = await readCredentialResealHolds(engine, sourceIds);
    const details = { pages_pending: rebuildable, kept_pages: kept, ...(held.length ? { held_pages: held.length } : {}), count: 'exact', truncated: false };
    const keptNote = kept ? ` ${kept} code page(s) without a recorded source path stay withheld until re-imported (gbrain sync --source <id>).` : '';
    const heldNote = held.length ? ` ${held.length} of them failed their re-chunk and are held; retry with ${[...new Set(held.map(hold => `\`${hold.fix.argv!.join(' ')}\``))].join(', ')} `
      + '(gbrain doctor --only text_projection_readiness lists them).' : '';
    if (rebuildable === 0) return { name, status: kept ? 'warn' : 'ok', details, message: `No page waits for the credential-safe re-chunk.${keptNote}` };
    return { name, status: 'warn', details, message: `${rebuildable} page(s) holding a private key are withheld from search until re-chunked without provider calls. `
      + `Run \`gbrain apply-migrations --yes --no-autopilot-install\`, then \`gbrain embed --stale\` when ready.${heldNote}${keptNote}` };
  } catch (error) {
    return { name, status: 'warn', message: `Credential-safe re-chunk state could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
