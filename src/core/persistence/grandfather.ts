import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { contentHash } from '../utils.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from './page-mutations.ts';
import { submissionAuthority, authorizeStoredRequest } from './authority.ts';
import { admitWrite, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { getWorktreeBinding } from './ownership.ts';
import { digest, requireUuid } from './digest.ts';
import { waitForWrite, writeResponse } from './service.ts';
import { databaseOnlyPublication, prepareFileTarget } from './page-prepare.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';

export async function grandfatherCanonicalPage(engine: BrainEngine,
  selected: { id: number; slug: string; source_id: string; source_incarnation: string },
  before: (page: typeof selected & { frontmatter: Record<string, unknown>; knowledge_revision: string; request_id: string }) => void | Promise<void>): Promise<'touched' | 'skipped'> {
  const snapshot = await engine.readPageSnapshot(selected.slug, { sourceId: selected.source_id });
  if (!snapshot || snapshot.page.id !== selected.id || snapshot.sourceIncarnation !== selected.source_incarnation ||
    Object.hasOwn(snapshot.page.frontmatter ?? {}, 'validate')) return 'skipped';
  const extension = snapshot.page.source_path ? extname(snapshot.page.source_path).toLowerCase() : '';
  if (['code', 'image'].includes(snapshot.page.type) || extension && !['.md', '.mdx'].includes(extension)) return 'skipped';
  const ctx: OperationContext = { engine, config: loadConfig() ?? { engine: engine.kind }, sourceId: selected.source_id,
    remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const authority = await submissionAuthority(ctx, 'put_page', selected.source_id, selected.source_incarnation, selected.slug);
  const callerIntent = { migration: '0.13.1', ...selected, expected_revision: snapshot.revision };
  const fingerprint = digest({ principal, ...callerIntent });
  const op = 'canonical-grandfather-0.13.1';
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING',
    [op, fingerprint, JSON.stringify([randomUUID()])]);
  const [checkpoint] = await engine.executeRaw<{ completed_keys: string[] }>('SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [op, fingerprint]);
  const requestId = requireUuid(checkpoint.completed_keys[0]);
  const prior = await getWriteRequest(engine, principal, requestId);
  if (prior) {
    await authorizeStoredRequest(engine, prior);
    assertReplayIntent(prior, intentDigest({ operation: 'put_page', sourceId: selected.source_id, slug: selected.slug, callerIntent }));
  } else await before({ ...selected, frontmatter: snapshot.page.frontmatter ?? {}, knowledge_revision: snapshot.revision, request_id: requestId });
  const binding = await getWorktreeBinding(engine, selected.source_id);
  try {
    const request = prior ?? await admitWrite(engine, { principal, operation: 'put_page', sourceId: selected.source_id,
      sourceIncarnation: selected.source_incarnation, pageId: selected.id, slug: selected.slug, requestId, authority, callerIntent,
      intent: { kind: 'managed_grandfather', expected_revision: snapshot.revision },
      worktreeId: binding?.worktree_id, topologyGeneration: binding?.topology_generation });
    writeResponse(await waitForWrite(engine, request, ctx.config));
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [op, fingerprint, JSON.stringify([requestId])]);
    return 'touched';
  } catch (error) {
    if (error instanceof OperationError && error.writeRequest && ['failed', 'conflict', 'cancelled'].includes(error.writeRequest.state)) {
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [op, fingerprint, JSON.stringify([requestId])]);
    }
    throw error;
  }
}

export async function prepareGrandfatherMutation(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  if (row.operation !== 'put_page' || row.intent?.kind !== 'managed_grandfather' || row.authority.remote !== false || row.authority.principal.kind !== 'local_cli') {
    throw new OperationError('permission_denied', 'Grandfathering requires the trusted canonical migration path.');
  }
  await authorizeStoredRequest(engine, row);
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== row.page_id) throw new OperationError('page_identity_changed', 'The grandfathered page identity changed.');
  assertPageRevision(snapshot, { expectedRevision: row.intent.expected_revision as string });
  if (Object.hasOwn(snapshot.page.frontmatter ?? {}, 'validate')) throw new OperationError('revision_conflict', 'A validation decision already exists.');
  if (snapshot.page.frontmatter != null && (typeof snapshot.page.frontmatter !== 'object' || Array.isArray(snapshot.page.frontmatter))) {
    throw new OperationError('invalid_params', 'Grandfathering requires valid object frontmatter.');
  }
  const frontmatter = { ...snapshot.page.frontmatter, validate: false };
  const hash = contentHash({ ...snapshot.page, frontmatter, tags: snapshot.tags });
  const file = await prepareFileTarget(engine, row, snapshot, serializePageToMarkdown({ ...snapshot.page, frontmatter }, snapshot.tags));
  if (file && !['.md', '.mdx'].includes(extname(file.path).toLowerCase())) {
    throw new OperationError('invalid_params', 'Non-Markdown artifacts cannot be grandfathered by rewriting their bytes.');
  }
  return { observedRevision: snapshot.revision, file, ...databaseOnlyPublication(row, file), deferEmbedding: true, apply: async tx => {
    await tx.createVersion(row.slug, { sourceId: row.source_id });
    const updated = await tx.executeRaw(`UPDATE pages SET frontmatter=jsonb_set(COALESCE(frontmatter,'{}'::jsonb),'{validate}','false'::jsonb),content_hash=$4
      WHERE id=$1 AND source_id=$2 AND knowledge_revision=$3::uuid AND NOT(COALESCE(frontmatter,'{}'::jsonb)?'validate') RETURNING id`,
    [row.page_id, row.source_id, snapshot.revision, hash]);
    if (updated.length !== 1) throw new OperationError('revision_conflict', 'The validation decision changed before publication.');
    if (snapshot.page.text_projection_revision === snapshot.revision) {
      await tx.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1 AND source_id=$2', [row.page_id, row.source_id]);
    }
    await tx.executeRaw(`INSERT INTO extract_atoms_page_state(source_incarnation,page_id,content_hash,fail_count,tombstoned,updated_at)
      SELECT source_incarnation,page_id,$4,fail_count,tombstoned,updated_at FROM extract_atoms_page_state
      WHERE source_incarnation=$1::uuid AND page_id=$2 AND content_hash=$3 ON CONFLICT DO NOTHING`,
    [row.source_incarnation, row.page_id, snapshot.page.content_hash, hash]);
    return { status: 'grandfathered', slug: row.slug, source_id: row.source_id };
  } };
}
