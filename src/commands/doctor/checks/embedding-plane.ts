/**
 * GBRA-248 W0b: `embedding_plane_disagreement` warns when the config file
 * disables embeddings (`embedding_disabled: true`) while the database holds
 * vectors and does not disable them: the state a keyless re-init from a cold
 * home left before init kept the database's identity
 * (commands/init-embedding-plane.ts). Read-only; the fix is the
 * init --force enable for the database's own model and width.
 */
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { loadConfigFileOnly, type GBrainConfig } from '../../../core/config.ts';
import { enableArgv } from '../../../core/readiness.ts';
import { readPrimaryEmbeddingStores, readStoredEmbeddingIdentity } from '../../../core/stored-embedding-identity.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/troubleshooting.md#embedding-plane-disagreement';

export async function embeddingPlaneDisagreementCheck(engine: BrainEngine, file: GBrainConfig | null = loadConfigFileOnly()): Promise<Check> {
  try {
    if (file?.embedding_disabled !== true) return { name: 'embedding_plane_disagreement', status: 'ok', message: 'The config file does not disable embeddings.', details: { file_disabled: false, docs: DOCS } };
    if (await engine.getConfig('embedding_disabled') === 'true') return { name: 'embedding_plane_disagreement', status: 'ok', message: 'The config file and the database both disable embeddings (keyless by choice).', details: { file_disabled: true, database_disabled: true, docs: DOCS } };
    const stores: string[] = [];
    for (const table of await readPrimaryEmbeddingStores(engine)) {
      const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table} WHERE embedding IS NOT NULL) AS present`);
      if (row?.present) stores.push(table);
    }
    if (!stores.length) return { name: 'embedding_plane_disagreement', status: 'ok', message: 'The config file disables embeddings and the database holds no vectors.', details: { file_disabled: true, database_disabled: false, vector_tables: [], docs: DOCS } };
    const stored = await readStoredEmbeddingIdentity(engine);
    const details = { file_disabled: true, database_disabled: false, vector_tables: stores, model: stored?.model ?? null, dimensions: stored?.dimensions ?? null, docs: DOCS };
    const message = `embedding_plane_disagreement: the config file disables embeddings, but the database does not and holds vectors (${stores.join(', ')}) from ${stored?.model ?? 'an unrecorded model'}${stored ? ` (${stored.dimensions}d)` : ''}. `
      + 'A re-init without a provider key in reach (a new GBRAIN_HOME, a restarted container) wrote the flag, so new pages get no vectors and search is keyword-only. ';
    if (!stored?.model) return { name: 'embedding_plane_disagreement', status: 'warn', details,
      message: `${message}Run gbrain migrate embeddings --status to read the stored identity before turning embeddings back on.`,
      fix: { argv: ['gbrain', 'migrate', 'embeddings', '--status', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify('embedding_plane_disagreement'), docs: DOCS,
        why: 'Read-only: shows the vectors\' recorded model and width, which the enable command must match.' } };
    const argv = enableArgv(file, stored.model, stored.dimensions);
    return { name: 'embedding_plane_disagreement', status: 'warn', details,
      message: `${message}With the provider key set, \`${argv.join(' ')}\` turns them back on for the same model and width; pages and vectors are kept.`,
      fix: { argv, consent: ['credentials', 'paid'], actor: 'user', requires_exclusive: true, verify: doctorVerify('embedding_plane_disagreement'), docs: DOCS,
        why: `Re-enables ${stored.model} (${stored.dimensions}d), the model the stored vectors already use, and clears embedding_disabled; pages written meanwhile are embedded by gbrain embed --stale.`,
        user_message: `Embeddings were switched off on this brain by a re-setup that could not find your provider key, although it already has vectors from ${stored.model}. With that key set, I can turn them back on (same model; embedding new pages costs a little). OK?` } };
  } catch (error) {
    return checkError('embedding_plane_disagreement', 'compare the file and database embedding settings', error, { details: { health: 'unknown', docs: DOCS } });
  }
}

async function runEmbeddingPlaneDisagreement(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await embeddingPlaneDisagreementCheck(connectedEngine(ctx)));
  return checks;
}

export const embeddingPlaneDisagreementEntry: DoctorEntry = {
  name: 'embedding_plane_disagreement',
  emits: ['embedding_plane_disagreement'],
  run: runEmbeddingPlaneDisagreement,
};
