/**
 * Connector fact retirement (GST-3256): a connector that wrote facts rows onto an entity page through remember (its
 * provenance in the row's source column, e.g. apple-contacts:<source id>) takes back only those rows when the data
 * behind them goes: the facts rows are expired and their ## Facts fence rows struck (prepareFenceRowRetirement), in one
 * coordinated publication on every brain (managed or not; git first where the page has a canonical file).
 *
 * It is not a withdrawal: no fact_withdrawals tombstone is written, so the same claim is stored normally when the
 * connector writes it again (a restored contact, a regained match, a group rejoined). It reaches only rows whose source
 * is exactly the request's fact_source: a claim with the same text saved by anyone else is never touched. The page's
 * trust tier is kept (a fence edit, trust/page-write.ts). Local trusted callers only.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { prepareFenceRowRetirement } from '../facts/fence-fact-append.ts';
import { withPageTierKept } from '../trust/fence-append.ts';
import { digest } from './digest.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import type { PageSnapshot } from '../page-state/types.ts';

export const CONNECTOR_FACT_RETIREMENT_OPERATION = 'retire_connector_facts';

export interface ConnectorFactRetirementIntent extends Record<string, unknown> {
  kind: typeof CONNECTOR_FACT_RETIREMENT_OPERATION;
  /** The exact facts.source value the connector wrote; only rows carrying it are retired. */
  fact_source: string;
  fact_ids: number[];
  /** Recorded on each struck fence row. */
  note: string;
}

interface OwnedRow { id: number; row_num: number | null; source_markdown_slug: string | null; source: string | null; expired_at: string | null }

async function ownedRows(db: BrainEngine, row: WriteRequest, intent: ConnectorFactRetirementIntent, lock = false): Promise<OwnedRow[]> {
  const rows = await db.executeRaw<OwnedRow>('SELECT id,row_num,source_markdown_slug,source,expired_at FROM facts WHERE source_id=$1 AND id=ANY($2::int[]) AND source=$3 AND source_markdown_slug=$4 AND expired_at IS NULL ORDER BY id'
    + (lock ? ' FOR UPDATE' : ''), [row.source_id, intent.fact_ids, intent.fact_source, row.slug]);
  return rows.map(r => ({ ...r, id: Number(r.id), row_num: r.row_num === null ? null : Number(r.row_num) }));
}

function refusal(row: WriteRequest, message: string, what: string) {
  return opError('revision_conflict', message,
    what + ' Request ' + row.request_id + ' on ' + row.slug + ' in source ' + row.source_id + ' retired nothing; the connector plans it again on its next run.',
    { fix: readFix('Reads the request\'s receipt, read-only.', { argv: ['gbrain', 'write-request', '--', row.request_id] }) });
}

/** Coordinator preparer for operation retire_connector_facts. */
export async function prepareConnectorFactRetirement(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const intent = row.intent as ConnectorFactRetirementIntent | null;
  if (row.authority.remote || intent?.kind !== CONNECTOR_FACT_RETIREMENT_OPERATION || typeof intent.fact_source !== 'string' || !intent.fact_source
    || !Array.isArray(intent.fact_ids) || !intent.fact_ids.every(Number.isSafeInteger)) {
    throw opError('invalid_params', 'Unsupported connector fact retirement intent.', 'Request ' + row.request_id + ' does not carry a connector fact retirement a local caller made; nothing was published.');
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  const observedRevision = snapshot?.revision ?? null;
  const live = await ownedRows(engine, row, intent);
  if (!live.length) return { observedRevision, noop: true, apply: async () => ({ facts_retired: 0 }) };
  const rowNums = live.flatMap(r => r.row_num === null ? [] : [r.row_num]);
  const page = rowNums.length ? await prepareFenceRowRetirement(engine, row, config, row.slug, { rowNum: rowNums, note: intent.note, validUntil: new Date() }) : null;
  const key = JSON.stringify(live);
  const validate = async (tx: BrainEngine) => {
    if (JSON.stringify(await ownedRows(tx, row, intent, true)) !== key) throw refusal(row, 'The connector\'s facts changed during preparation.', 'A fact this request retires changed while it was prepared.');
    await page?.validate?.(tx);
  };
  const apply = async (tx: BrainEngine, preimage?: PageSnapshot | null): Promise<Record<string, unknown>> => {
    const expired = await tx.executeRaw(`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now())
      WHERE source_id=$1 AND id=ANY($2::int[]) AND source=$3 AND expired_at IS NULL RETURNING id`, [row.source_id, live.map(r => r.id), intent.fact_source]);
    if (expired.length !== live.length) throw refusal(row, 'The connector\'s facts changed during publication.', 'A fact this request retires changed during publication, so the transaction rolled back.');
    const published = page ? await withPageTierKept(tx, { sourceId: row.source_id, slug: row.slug }, () => page.mutation.apply(tx, preimage ?? null)) : {};
    return { ...published, facts_retired: live.length, fence_struck: page !== null, fact_ids: live.map(r => r.id) };
  };
  return page ? { ...page.mutation, observedRevision: page.observedRevision, validate, apply } : { observedRevision, validate, apply };
}

/**
 * Admit and wait for one page's connector fact retirement (a trusted local caller). Returns the receipt's outcome;
 * throws the refusal (owner_unavailable when the page's checkout has no canonical owner yet).
 */
export async function retireConnectorFacts(engine: BrainEngine, sourceId: string, slug: string,
  retire: { factSource: string; factIds: number[]; note: string }): Promise<Record<string, unknown>> {
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('./page-mutations.ts');
  const { submissionAuthority } = await import('./authority.ts');
  const { admitWrite, getWriteRequest } = await import('./journal.ts');
  const { assertPersistenceAccepting, waitForWrite, writeResponse } = await import('./service.ts');
  const { resolveFactWriteTarget } = await import('./fact-write-target.ts');
  const config = { engine: engine.kind } as GBrainConfig;
  const ctx = { engine, sourceId, remote: false as const, config, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  assertPersistenceAccepting(engine);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) throw opError('source_changed', 'The person page\'s source is not active.', 'Source ' + sourceId + ' is archived or not registered, so nothing was retired on ' + slug + '.');
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  const target = await resolveFactWriteTarget(engine, sourceId, source, { fileBacked: Boolean(snapshot?.page.source_path), remote: false });
  if (target.kind === 'unbound') throw opError('owner_unavailable', 'The page\'s checkout has no canonical owner yet.', 'Source ' + sourceId + ' writes through to a checkout with no canonical owner, so nothing was retired on ' + slug + '; the connector tries again on its next run.');
  const authority = await submissionAuthority(ctx, CONNECTOR_FACT_RETIREMENT_OPERATION, sourceId, source.incarnation, slug);
  if (target.databaseOnlyReason) authority.databaseOnlyReason = target.databaseOnlyReason;
  const ids = [...retire.factIds].sort((a, b) => a - b);
  const intent: ConnectorFactRetirementIntent = { kind: CONNECTOR_FACT_RETIREMENT_OPERATION, fact_source: retire.factSource, fact_ids: ids, note: retire.note };
  const key = digest({ sourceId, slug, factSource: retire.factSource, ids, revision: snapshot?.revision ?? null });
  const requestId = key.slice(0, 8) + '-' + key.slice(8, 12) + '-4' + key.slice(13, 16) + '-a' + key.slice(17, 20) + '-' + key.slice(20, 32);
  const row = await getWriteRequest(engine, principal, requestId) ?? await admitWrite(engine, {
    principal, operation: CONNECTOR_FACT_RETIREMENT_OPERATION, sourceId, sourceIncarnation: source.incarnation, slug, pageId: snapshot?.page.id ?? null,
    requestId, callerIntent: intent, intent, authority,
    worktreeId: target.binding?.worktree_id ?? null, topologyGeneration: target.binding?.topology_generation ?? null,
  });
  const finished = await waitForWrite(engine, row, config, 60_000);
  writeResponse(finished);
  return (finished.outcome ?? {}) as Record<string, unknown>;
}
