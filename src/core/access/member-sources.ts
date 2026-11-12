/**
 * GBRA-284 (GST-359 G1 wave 2): personal sources. `access_member_sources` (v299) binds a source (a person's DM or
 * member source) to the member it belongs to; a source with at least one binding is personal. Sources are not keyed to
 * members otherwise, so without this an attest client granted every person's DM source would let every attested person
 * read every other person's DM source.
 *
 * The read rule (`attestedReadScope`, applied once in MCP dispatch for every attested call) only hides inside the
 * credential's grant: it drops every personal source not bound to the attested member, and under a scope read
 * (`SCOPE_READ_ACCESS`) every personal source, the speaker's own included. It never adds a source, so a narrowed read
 * refuses a hidden source exactly like an out-of-grant one (resolveRequestedScope's permission_denied). Unattested
 * callers and member-bound credentials are unchanged (a member-bound credential could take the same rule later).
 * Everything lives in the database, so a repo-less brain gets it unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type AuthInfo, type ExplicitReadBinding } from '../ops/contract.ts';
import { isValidSourceId, NO_SOURCES } from '../source-id.ts';
import { isMissingSchemaObject } from '../utils.ts';
import { existingMember } from './members.ts';

export interface MemberSource { member_id: string; source_id: string; created_at: string | null }

function toBinding(row: Record<string, unknown>): MemberSource {
  return { member_id: String(row.member_id), source_id: String(row.source_id), created_at: row.created_at ? new Date(row.created_at as string).toISOString() : null };
}

async function liveSource(engine: BrainEngine, raw: unknown): Promise<string> {
  if (!isValidSourceId(raw)) {
    throw opError('invalid_params', `"${String(raw ?? '')}" is not a valid source id.`, 'Pass a source id from gbrain sources list.');
  }
  const [row] = await engine.executeRaw<{ ok: number }>('SELECT 1 AS ok FROM sources WHERE id = $1 AND archived IS NOT TRUE', [raw]);
  if (!row) throw opError('unknown_source', `No live source "${raw}" exists on this brain.`, 'Pick an id from gbrain sources list.');
  return raw;
}

/** Binds a source to a member (a narrowing: attested callers for anyone else stop reading it); dryRun previews. */
export async function bindMemberSource(engine: BrainEngine, rawMember: unknown, rawSource: unknown, opts: { dryRun?: boolean } = {}): Promise<{ binding: MemberSource; applied: boolean; changed: boolean; owners: string[] }> {
  const member = await existingMember(engine, rawMember, 'bound to a source');
  if (member.status === 'removed') {
    throw opError('access_member_invalid', `Member "${member.id}" was removed.`, 'Removed ids are never reused; bind the source to a live member.', { reason: 'removed' });
  }
  const source = await liveSource(engine, rawSource);
  const owners = await sourceOwners(engine, source);
  const changed = !owners.includes(member.id);
  if (changed && !opts.dryRun) {
    await engine.executeRaw('INSERT INTO access_member_sources (member_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [member.id, source]);
  }
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 AND source_id = $2', [member.id, source]);
  return { binding: row ? toBinding(row) : { member_id: member.id, source_id: source, created_at: null }, applied: changed && !opts.dryRun, changed,
    owners: changed ? [...owners, member.id].sort() : owners };
}

/**
 * Unbinds a source from a member. When it was the source's last binding the source stops being personal, so every
 * attested person through a credential that grants it reads it again (a widening): preview unless apply is set.
 */
export async function unbindMemberSource(engine: BrainEngine, rawMember: unknown, rawSource: unknown, opts: { apply?: boolean } = {}): Promise<{ binding: MemberSource; applied: boolean; owners: string[]; still_personal: boolean }> {
  const member = await existingMember(engine, rawMember, 'unbound from a source');
  if (!isValidSourceId(rawSource)) throw opError('invalid_params', `"${String(rawSource ?? '')}" is not a valid source id.`, 'Pass a source id from gbrain access member source list.');
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 AND source_id = $2', [member.id, rawSource]);
  if (!row) {
    throw opError('invalid_params', `Source "${rawSource}" is not bound to member "${member.id}".`, `List the bindings with gbrain access member source list ${member.id}.`, { reason: 'unknown_binding' });
  }
  if (opts.apply) await engine.executeRaw('DELETE FROM access_member_sources WHERE member_id = $1 AND source_id = $2', [member.id, rawSource]);
  const owners = (await sourceOwners(engine, rawSource)).filter(o => o !== member.id);
  return { binding: toBinding(row), applied: opts.apply === true, owners, still_personal: owners.length > 0 };
}

export async function listMemberSources(engine: BrainEngine, opts: { member?: string } = {}): Promise<MemberSource[]> {
  const member = opts.member === undefined ? undefined : (await existingMember(engine, opts.member, 'listed')).id;
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT member_id, source_id, created_at FROM access_member_sources${member ? ' WHERE member_id = $1' : ''} ORDER BY member_id, source_id`, member ? [member] : []);
  return rows.map(toBinding);
}

async function sourceOwners(engine: BrainEngine, source: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ member_id: string }>('SELECT member_id FROM access_member_sources WHERE source_id = $1 ORDER BY member_id', [source]);
  return rows.map(r => r.member_id);
}

/**
 * The personal sources among `sources` an attested call for `member` must not read: every personal source not bound to
 * that member, or every personal source under a scope read. A schema before v299 has no personal source.
 */
export async function hiddenPersonalSources(engine: Pick<BrainEngine, 'executeRaw'>, sources: readonly string[], member: string, scopeRead: boolean): Promise<Set<string>> {
  const ids = [...new Set(sources)];
  if (!ids.length) return new Set();
  let rows: { source_id: string; member_id: string }[];
  try {
    rows = await engine.executeRaw<{ source_id: string; member_id: string }>('SELECT source_id, member_id FROM access_member_sources WHERE source_id = ANY($1::text[])', [ids]);
  } catch (e) {
    if (!isMissingSchemaObject(e, 'table', 'access_member_sources')) throw e;
    return new Set();
  }
  const own = new Set(scopeRead ? [] : rows.filter(r => r.member_id === member).map(r => r.source_id));
  return new Set(rows.map(r => r.source_id).filter(s => !own.has(s)));
}

export interface ReadScopeOpts { auth?: AuthInfo; sourceId?: string; localFederatedSourceIds?: string[]; explicitReadBinding?: ExplicitReadBinding }

/**
 * The read scope of one attested call: the credential's granted read sources (its federated grant, else the
 * transport's federated set for an unqualified read, else its scalar source) minus the hidden personal sources, as an
 * explicit grant so every resolver (sourceScopeOpts, resolveRequestedScope, federatedSearchScope) reads the same set.
 * A hidden scalar source (the call's sourceId, which writes and scalar reads use directly) moves to the first kept
 * source, or to NO_SOURCES, which refuses. Unchanged (the same object) when nothing is hidden. A grant left empty reads
 * nothing (NO_SOURCES never names a source).
 */
export async function attestedReadScope<T extends ReadScopeOpts>(engine: Pick<BrainEngine, 'executeRaw'>, opts: T, member: string, scopeRead: boolean): Promise<T> {
  const auth = opts.auth;
  if (!auth || auth.sourceId === NO_SOURCES) return opts;
  const federated = opts.localFederatedSourceIds;
  const scalar = opts.sourceId ?? 'default';
  const grant = auth.allowedSources?.length ? auth.allowedSources : federated && federated.length > 1 ? federated : [scalar];
  const scalars = [scalar, ...(auth.sourceId ? [auth.sourceId] : [])];
  const hidden = await hiddenPersonalSources(engine, [...grant, ...scalars, ...(federated ?? []), ...(opts.explicitReadBinding?.sourceIds ?? [])], member, scopeRead);
  if (!hidden.size) return opts;
  const keep = (ids: string[]) => ids.filter(s => !hidden.has(s));
  const allowed = keep(grant);
  const moved = allowed[0] ?? NO_SOURCES;
  return {
    ...opts,
    ...(hidden.has(scalar) ? { sourceId: moved } : {}),
    auth: { ...auth, allowedSources: allowed.length ? allowed : [NO_SOURCES], ...(auth.sourceId && hidden.has(auth.sourceId) ? { sourceId: moved } : {}) },
    ...(federated ? { localFederatedSourceIds: keep(federated) } : {}),
    ...(opts.explicitReadBinding ? { explicitReadBinding: { ...opts.explicitReadBinding, sourceIds: keep(opts.explicitReadBinding.sourceIds) } } : {}),
  };
}
