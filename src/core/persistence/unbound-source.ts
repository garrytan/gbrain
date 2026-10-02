import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import type { SqlEngine, WriteRequest } from './model.ts';

/**
 * #5254: a Postgres page write to a filesystem source with no canonical owner.
 * Refused by default; `persistence.unbound_write=database_only` lets every
 * page mutation (#5393) write a page with no recorded canonical file to the
 * database only. Those pages
 * carry `pages.database_only_reason='unbound_source'` so writes and sync after
 * binding keep them database-only instead of materializing or overwriting them.
 */
export const UNBOUND_WRITE_KEY = 'persistence.unbound_write';
export const UNBOUND_WRITE_VALUES = ['refuse', 'database_only'] as const;
export type UnboundWritePolicy = typeof UNBOUND_WRITE_VALUES[number];
export const UNBOUND_SOURCE_DOCS = 'docs/guides/write-refusals.md#unbound-sources-on-postgres';
export const UNBOUND_PUBLICATION_MESSAGE = 'The source was bound, or the page gained a canonical file, after this database-only write was accepted.';
export const CONNECTOR_BOUND_HINT = 'Nothing was written. Read the page again and submit the write with a new request_id; the bound source publishes it to its canonical file.';
export const CONNECTOR_BOUND_MESSAGE = 'The connector source gained a canonical owner after this database-only write was accepted.';
export const UNBOUND_COLLISION_MESSAGE = 'A database-only page written while its source was unbound already uses this slug.';

export function parseUnboundWriteValue(value: string): UnboundWritePolicy {
  if ((UNBOUND_WRITE_VALUES as readonly string[]).includes(value)) return value as UnboundWritePolicy;
  throw new OperationError('invalid_params', `${UNBOUND_WRITE_KEY} must be one of: ${UNBOUND_WRITE_VALUES.join(', ')} (got '${value}').`);
}

/** A missing or unreadable value keeps the refusal. */
export async function readUnboundWritePolicy(engine: Pick<BrainEngine, 'getConfig'>): Promise<UnboundWritePolicy> {
  return await engine.getConfig(UNBOUND_WRITE_KEY) === 'database_only' ? 'database_only' : 'refuse';
}

export function unboundBindCommand(sourceId: string, path: string | null): string {
  return `run gbrain sources writer status ${sourceId} --json and note admin_state, then run gbrain sources writer claim ${sourceId} `
    + `--path ${path ?? '<checkout path on the brain host>'} --admin-intent writer_claim --expected-state <admin_state>`;
}

/**
 * `path` is filled only for trusted local callers; remote callers get a
 * placeholder instead of a host path.
 */
export function unboundSourceError(sourceId: string, path: string | null, scope: 'database_only_eligible' | 'file_backed'): OperationError {
  const bind = `bind the source on the brain host: ${unboundBindCommand(sourceId, path)} `
    + '(if an operator has locked writer administration, ask the operator to unlock it first)';
  const suggestion = scope === 'database_only_eligible'
    ? `Source '${sourceId}' has a checkout path but no canonical owner. Choose one: ${bind}; or allow database-only writes to unbound sources `
      + `with gbrain config set ${UNBOUND_WRITE_KEY} database_only. Pages written that way stay database-only and are not materialized into canonical files after binding.`
    : `Source '${sourceId}' has a checkout path but no canonical owner. To write this page, ${bind}. `
      + `${UNBOUND_WRITE_KEY}=database_only does not apply: this page came from a canonical file, and a database-only edit would be lost on the owner's next sync.`;
  const error = new OperationError('owner_unavailable', 'This source has no designated canonical owner.', suggestion, UNBOUND_SOURCE_DOCS);
  error.detail = 'unbound_source';
  return error;
}

export function unboundPublicationHint(sourceId: string): string {
  return `Source '${sourceId}' gained a canonical owner, or the page gained a canonical file, after this database-only write was accepted, so nothing was written. `
    + 'Read the page again and submit the write with a new request_id; a bound source publishes it to its canonical file.';
}

/**
 * Runs inside the publication transaction after the source row is share-locked
 * (authorizeStoredRequest), so a concurrent claim either committed before this
 * read or waits for the publication to finish.
 */
export async function assertUnboundPublication(tx: SqlEngine, row: Pick<WriteRequest, 'authority' | 'source_id' | 'operation'>, sourcePath: string | null | undefined): Promise<void> {
  // A page or memory write admitted database-only to an unbound connector source (connector_database)
  // must not publish around canonical files once the source has an owner. Connector intents
  // (submit_job) carry their own sync-authority check.
  if (row.authority.databaseOnlyReason === 'connector_database' && row.operation !== 'submit_job') {
    const bound = await tx.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1 LIMIT 1', [row.source_id]);
    if (bound.length) throw new OperationError('owner_unavailable', CONNECTOR_BOUND_MESSAGE, CONNECTOR_BOUND_HINT);
    return;
  }
  if (row.authority.databaseOnlyReason !== 'unbound_source') return;
  const bound = await tx.executeRaw('SELECT 1 FROM persistence_source_bindings WHERE source_id=$1 LIMIT 1', [row.source_id]);
  if (!bound.length && !sourcePath) return;
  const error = new OperationError('owner_unavailable', UNBOUND_PUBLICATION_MESSAGE, unboundPublicationHint(row.source_id), UNBOUND_SOURCE_DOCS);
  error.detail = 'unbound_source';
  throw error;
}

export async function classifyUnboundPage(tx: SqlEngine, row: Pick<WriteRequest, 'authority' | 'source_id' | 'slug'>): Promise<void> {
  if (row.authority.databaseOnlyReason !== 'unbound_source') return;
  await tx.executeRaw("UPDATE pages SET database_only_reason='unbound_source' WHERE source_id=$1 AND slug=$2 AND database_only_reason IS NULL",
    [row.source_id, row.slug]);
}

export async function isUnboundSourcePage(engine: SqlEngine, sourceId: string, slug: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ database_only_reason: string | null }>(
    'SELECT database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row?.database_only_reason === 'unbound_source';
}

export function unboundWriteWarning(operation: string, sourceId: string, admittedUnbound: boolean): string {
  return `${operation} wrote only to the database for source '${sourceId}': ` + (admittedUnbound
    ? `the source has no canonical owner and ${UNBOUND_WRITE_KEY}=database_only, so no markdown file was created. `
    : 'this page was written while the source had no canonical owner. ')
    + 'The page stays database-only and is not materialized into a canonical file after binding.';
}
