/**
 * GST-1158 E1: the scope read. An attested call (access/actor.ts) to an operation in SCOPE_READ_OPS that names
 * `source_id` or `source_ids` runs under SCOPE_READ_ACCESS: no member identity, actor or audience, so no member page
 * and no restricted page is read, and privacy is never relaxed. The record only takes identity away, so a scope read
 * only ever hides. A credential whose attest right says `attest_read = 'person'` (F3) narrows to the named sources but
 * reads as the person. `__all__` and `all_sources` are refused under scope, so a scope read always names its sources.
 * Everything lives in the database, so a repo-less brain gets it unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { opError, type OperationError } from '../ops/contract.ts';
import { ALL_SOURCES } from '../source-id.ts';
import type { CallerAccess } from '../search/private-visibility.ts';

/** GST-1094: the caller record of a scope read. It is read as the scope, never as the person. Folder coverage (pending prefixes, an unreadable rulebook) is read per call, so it stays fail-closed. */
export const SCOPE_READ_ACCESS: Partial<CallerAccess> = {
  identity: [], audienceIdentities: [], audience: null, actor: null, satisfiedRuleIds: [], privateReadableSources: [],
  hidePrivate: true, applyRemoteReadPolicy: false, restricted: true, remotePolicy: { privacyRelaxed: false, restricted: true },
};

/** GST-1158 E1: the reads an attested call that names sources runs as the scope. context_pack stays out until it is confined to the named sources, so it is refused when it names sources on a scope credential. */
export const SCOPE_READ_OPS: ReadonlySet<string> = new Set([
  'memory_recall', 'get_page', 'entity', 'whois', 'get_backlinks', 'get_timeline', 'find_experts', 'volunteer_context', 'query',
]);

export type ReadMode = 'scope' | 'person';
const readModeStore = new AsyncLocalStorage<ReadMode>();

/** How the current attested call reads its named sources; undefined when dispatch decided nothing (no attested call naming sources, or another door). */
export function currentReadMode(): ReadMode | undefined {
  return readModeStore.getStore();
}

export function withReadMode<T>(mode: ReadMode | null, fn: () => T): T {
  return mode ? readModeStore.run(mode, fn) : fn();
}

function namesSources(params: Record<string, unknown> | undefined): boolean {
  const id = params?.source_id;
  const ids = params?.source_ids;
  return params?.all_sources === true || (id !== undefined && id !== null && id !== '')
    || (Array.isArray(ids) ? ids.length > 0 : typeof ids === 'string' ? ids.trim() !== '' : ids !== undefined && ids !== null);
}

/**
 * The read mode of one attested call: 'scope' or 'person' when the operation is in SCOPE_READ_OPS and the call names
 * sources, else null. A scope read that asks for every source (`__all__`, `all_sources`) is refused with invalid_params.
 */
export function attestedReadMode(op: string, params: Record<string, unknown> | undefined, attestRead: ReadMode | null | undefined): ReadMode | null {
  if (op === 'context_pack' && attestRead !== 'person' && (namesSources(params) || (Array.isArray(params?.entity_refs) && params.entity_refs.length > 0))) throw contextPackScopeRefused();
  if (!SCOPE_READ_OPS.has(op) || !namesSources(params)) return null;
  if (attestRead === 'person') return 'person';
  const ids = params?.source_ids;
  if (params?.source_id === ALL_SOURCES || params?.all_sources === true || (Array.isArray(ids) && ids.includes(ALL_SOURCES))) throw scopeAllSourcesRefused(op);
  return 'scope';
}

function contextPackScopeRefused(): OperationError {
  return opError('invalid_params', 'context_pack: a call that names sources would read them as the person, and this credential reads named sources as their audience, so it is refused. Nothing was read.',
    'Leave source_id, source_ids, all_sources and entity_refs out to read as the person, or call query, get_page or entity with source_id for the scope.',
    { why: 'context_pack is not yet confined to the named sources, so it cannot run as a scope read.' });
}

function scopeAllSourcesRefused(op: string): OperationError {
  return opError('invalid_params', `${op}: a call that names sources reads them as their audience, so '${ALL_SOURCES}' and all_sources are refused. Nothing was read.`,
    'Name the sources to read in source_id or source_ids, or leave them out to read as the person.',
    { why: 'A scope read must name exactly the sources it reads, so it never widens past the scope the turn serves.' });
}
