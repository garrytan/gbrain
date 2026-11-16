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
import type { BrainEngine } from '../engine.ts';
import { schemaVersionNow, type CallerAccess } from '../search/private-visibility.ts';
import { folderAccessFor } from './caller.ts';

/** GST-1094: the caller record of a scope read. It is read as the scope, never as the person. Folder coverage (pending prefixes, an unreadable rulebook) is read per call, so it stays fail-closed. */
export const SCOPE_READ_ACCESS: Partial<CallerAccess> = {
  identity: [], audienceIdentities: [], audience: null, actor: null, satisfiedRuleIds: [], privateReadableSources: [],
  hidePrivate: true, applyRemoteReadPolicy: false, restricted: true, remotePolicy: { privacyRelaxed: false, restricted: true },
};

/** A scope read's record for one call: SCOPE_READ_ACCESS with this call's folder coverage and the brain's schema version (GST-2687). */
export async function scopeReadAccess(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Partial<CallerAccess>> {
  const { folderCoverage } = await folderAccessFor(engine, []);
  return { ...SCOPE_READ_ACCESS, folderCoverage, remotePolicy: { privacyRelaxed: false, restricted: true, ...await schemaVersionNow(engine) } };
}

/** GST-1158 E1: the reads an attested call that names sources runs as the scope. GST-2407: context_pack reads only the source it names (assertPackConfined). */
export const SCOPE_READ_OPS: ReadonlySet<string> = new Set([
  'memory_recall', 'get_page', 'entity', 'whois', 'get_backlinks', 'get_timeline', 'find_experts', 'volunteer_context', 'query', 'context_pack',
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
  const refs = op === 'context_pack' && Array.isArray(params?.entity_refs) && params.entity_refs.length > 0;
  if (!SCOPE_READ_OPS.has(op) || !(namesSources(params) || refs)) return null;
  if (attestRead === 'person') return 'person';
  const ids = params?.source_ids;
  if (params?.source_id === ALL_SOURCES || params?.all_sources === true || (Array.isArray(ids) && ids.includes(ALL_SOURCES))) throw scopeAllSourcesRefused(op);
  if (op === 'context_pack') assertPackConfined(params!);
  return 'scope';
}

/**
 * GST-2407: a context_pack scope read reads one source, the source_id it names: its entities, every entity_refs entry,
 * the core block, the pull brief and hot facts (ops/facts.ts reads the scope's source as home). session_id is refused,
 * since a session's thread rows belong to the person. Each refusal comes before any read.
 */
function assertPackConfined(params: Record<string, unknown>): void {
  const source = params.source_id;
  const refused = (problem: string, fix: string) => opError('invalid_params', `context_pack: ${problem}, and this credential reads named sources as their audience, so it is refused. Nothing was read.`, fix,
    { why: 'A scope read must name exactly the one source it reads, so the pack never reads past the scope the turn serves.' });
  if (typeof source !== 'string' || !source) throw refused('a scope read of the pack names exactly one source in source_id, and this call names none', 'Pass source_id with the one source to read (the source every entity_refs entry names), or leave source_ids and entity_refs out to read as the person.');
  if ((params.entity_refs as unknown[] | undefined)?.some(ref => (ref as { source_id?: unknown } | null)?.source_id !== source)) {
    throw refused(`an entity_refs entry names a source other than source_id '${source}'`, 'Name only entities in the source_id the call reads, each with that source_id.');
  }
  if (params.session_id !== undefined && params.session_id !== null && params.session_id !== '') throw refused('a scope read cannot read a session\'s thread rows (session_id)', 'Leave session_id out of a call that names source_id.');
}

/**
 * GBRA-108 design 1: a scope read takes the member's identity away, and with it the labelled-only grant, so it would
 * open every unlabelled page of the named sources. An attested read for a labelled-only member that names sources is
 * refused instead, before anything is read.
 */
export function scopeReadLabelledOnlyRefused(op: string): OperationError {
  return opError('permission_denied', `${op}: this person is labelled-only, so a read that names sources cannot run as their audience. Nothing was read.`,
    'Leave source_id and source_ids out to read as the person, which shows only the pages labelled for them.',
    { why: 'A scope read drops the member identity, and the labelled-only grant with it, so it would show pages nobody labelled for this person.' });
}

function scopeAllSourcesRefused(op: string): OperationError {
  return opError('invalid_params', `${op}: a call that names sources reads them as their audience, so '${ALL_SOURCES}' and all_sources are refused. Nothing was read.`,
    'Name the sources to read in source_id or source_ids, or leave them out to read as the person.',
    { why: 'A scope read must name exactly the sources it reads, so it never widens past the scope the turn serves.' });
}
