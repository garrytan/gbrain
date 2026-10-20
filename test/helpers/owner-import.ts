/**
 * Seeds a managed file import through the owner's own steps (admit, claim, prepare, publish, project), the way
 * managed-streamed-import.test.ts drives the owner, for tests whose subject is a page over the single-string ceiling
 * rather than the import's reply. The 30 s reply wait of importManagedFile does not apply: on a loaded host a 25 MiB
 * page's projection can outlast it, and the reply is then rightly write_pending. Stop the source's consumer first,
 * so the claim is this request's.
 */
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { buildSegmentedProjection } from '../../src/core/page-body/projection.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { prepareManagedImportMutation, type ManagedImportIntent } from '../../src/core/persistence/import-prepare.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';

/** Imports `file`, already at `sourcePath` in the source's canonical root, by reference; resolves once the page is sealed. */
export async function ownerImportFile(engine: BrainEngine, sourceId: string, file: string, sourcePath: string): Promise<void> {
  const binding = (await getWorktreeBinding(engine, sourceId))!;
  const slug = sourcePath.replace(/\.md$/, '');
  const bytes = readFileSync(file);
  const hash = sha256(bytes);
  const authority = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext, 'put_page', sourceId, binding.source_incarnation, slug);
  const intent: ManagedImportIntent = { kind: 'managed_file_import', slug, sourcePath, path: sourcePath, inputPath: file, inputHash: hash, targetHash: hash,
    body_ref: { kind: 'input_file', input_path: file, sha256: hash, bytes: bytes.length }, ownerEpoch: String(binding.owner_epoch), noEmbed: true };
  await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: binding.source_incarnation,
    slug, pageId: null, requestId: crypto.randomUUID(), callerIntent: intent, intent, authority, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = await claimNextWrite(engine, localHostId());
  if (row?.slug !== slug) throw new Error(`The owner claimed ${row?.slug ?? 'nothing'} instead of ${slug}.`);
  const done = await publishMutation(engine, row, await prepareManagedImportMutation(engine, row, { engine: engine.kind }), localHostId());
  if (done.state !== 'committed') throw new Error(`The import of ${sourcePath} ended ${done.state}: ${done.error_code ?? done.blocked_reason} ${done.error_message ?? ''}`);
  const projection = await buildSegmentedProjection(engine, { sourceId, slug });
  if (!projection.sealed) throw new Error(`The projection of ${slug} did not seal: ${JSON.stringify(projection)}`);
}
