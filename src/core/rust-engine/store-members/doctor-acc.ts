/**
 * Doctor reads, second set (src/core/engine-sql/doctor-acc.ts): the statements the access, token, OAuth, request-log,
 * decide, chronicle, feedback, belief and volunteer checks ran through executeRaw. The request-log reads are served by
 * gbrain-store (rust/crates/gbrain-store/src/cli_reads/doctor_acc.rs). The rest answer for state the store does not
 * keep, as listAppliedPolicyRevisions does (write-misc.ts); what each answers and why: rust/docs/store/cli-reads-doctor-acc.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { AVAILABLE_CHRONICLE_LEDGER_STATS } from '../../engine-sql/doctor-acc.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { listOauthClients } from './jobs-oauth-clients.ts';
import { listOauthGrantAudit, readLiveAccessTokenRows } from './jobs-client-grants.ts';
import { listAllSources } from './sources.ts';
import { readAccessGroups, readAccessMembers } from './access-members.ts';
import { storeFastPageTextPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

// Access state: no folder rule, member or grant is read from here (isAccessStateUnreadable, listRawOnlyRules, ...).
export const isAccessStateUnreadable: Member<'isAccessStateUnreadable'> = async () => false;
export const listRawOnlyRules: Member<'listRawOnlyRules'> = async () => [];
export const listAudienceMemberIds: Member<'listAudienceMemberIds'> = async () => [];
export const listLabelledOnlyMemberIds: Member<'listLabelledOnlyMemberIds'> = async () => [];
export const listAccessMemberRows: Member<'listAccessMemberRows'> = async () => [];

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** A row as `to_jsonb` renders it: times and the like as text, a column left out of the store absent. */
const asJsonb = (row: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(row)) as Record<string, unknown>;

/** Active (not revoked) API tokens, oldest first (a tie by id), from the store's live token rows. */
export const listActiveAccessTokenRows: Member<'listActiveAccessTokenRows'> = async (brain) =>
  (await readLiveAccessTokenRows(brain)).sort((a, b) =>
    (a.created_at as Date).getTime() - (b.created_at as Date).getTime() || byteCmp(String(a.id), String(b.id)));

/** OAuth clients not deleted, by client id in byte order. */
export const listActiveOauthClientRows: Member<'listActiveOauthClientRows'> = async (brain) =>
  (await listOauthClients(brain)).filter(c => c.deleted_at == null).sort((a, b) => byteCmp(a.client_id, b.client_id)) as unknown as Array<Record<string, unknown>>;

/** Active tokens and live clients that carry an attest actor, as JSON rows (a client's secret hash left out), by kind then name. */
export const listAttestCredentialRows: Member<'listAttestCredentialRows'> = async (brain) => {
  const tokens = (await readLiveAccessTokenRows(brain)).filter(t => t.attest_actor != null)
    .map(t => ({ kind: 'token' as const, id: String(t.id), name: String(t.name), row: asJsonb(t) }));
  const clients = (await listOauthClients(brain)).filter(c => c.deleted_at == null && c.attest_actor != null).map(c => {
    const { client_secret_hash: _hash, ...row } = c as unknown as Record<string, unknown>;
    return { kind: 'client' as const, id: c.client_id, name: c.client_name ?? c.client_id, row: asJsonb(row) };
  });
  return [...tokens, ...clients].sort((a, b) => byteCmp(a.kind, b.kind) || byteCmp(a.name, b.name));
};

export const listOauthClientAuthShapes: Member<'listOauthClientAuthShapes'> = async (brain) =>
  (await listOauthClients(brain)).map(c => ({ client_id: c.client_id, method: c.token_endpoint_auth_method ?? null, hash: c.client_secret_hash ?? null }));

/** Federated read grants of live clients that name no source (an archived source is one), by client id then grant id in byte order. */
export const listDanglingFederatedReads: Member<'listDanglingFederatedReads'> = async (brain) => {
  const sources = new Set((await listAllSources(brain, { includeArchived: true })).map(s => s.id));
  return (await listOauthClients(brain)).filter(c => c.deleted_at == null)
    .flatMap(c => (c.federated_read ?? []).filter(g => !sources.has(g)).map(g => ({ client_id: c.client_id, client_name: c.client_name ?? null, grant_id: g })))
    .sort((a, b) => byteCmp(a.client_id, b.client_id) || byteCmp(a.grant_id, b.grant_id));
};

/** The caller's POSIX `[[:space:]]` as the character class JavaScript spells it (the only class the doctor's pattern uses). */
const posixSpace = (pattern: string): RegExp => new RegExp(pattern.replaceAll('[[:space:]]', '[ \\t\\n\\v\\f\\r]'));

/**
 * Live clients whose scope matches `scopeRegex` with grant revision 0 and no `register` audit row (the anonymous
 * self-registration signature), by client id in byte order. The store keeps the revision column and the audit, so the
 * signature can always be evaluated here.
 */
export const listPrivilegedDcrClients: Member<'listPrivilegedDcrClients'> = async (brain, scopeRegex) => {
  const scope = posixSpace(scopeRegex);
  const found = [];
  for (const c of (await listOauthClients(brain)).sort((a, b) => byteCmp(a.client_id, b.client_id))) {
    if (c.deleted_at != null || Number(c.grant_revision ?? 0) !== 0 || !scope.test(c.scope ?? '')) continue;
    if ((await listOauthGrantAudit(brain, c.client_id)).some(a => a.action === 'register')) continue;
    found.push({ client_id: c.client_id, client_name: c.client_name ?? null, scope: c.scope ?? '' });
  }
  return found;
};

/** A source named `*suffix` with no path, no pages (deleted ones count), no facts and not archived, that no live client names (its source or a federated read). */
export const listOrphanWorkspaceSources: Member<'listOrphanWorkspaceSources'> = async (brain, suffix) => {
  const orphans: Array<{ id: string }> = [];
  const named = new Set((await listOauthClients(brain)).filter(c => c.deleted_at == null).flatMap(c => [c.source_id, ...(c.federated_read ?? [])]));
  for (const row of await storeCall({ member: 'listSourceRoutingRows' }, () => brain.listSourceRoutingRows()) as Array<{ id: string; local_path: string | null; archived: boolean }>) {
    if (!row.id.endsWith(suffix) || row.local_path !== null || row.archived || named.has(row.id)) continue;
    if (Number(await storeCall({ member: 'countSourcePages', sourceId: row.id }, () => brain.countSourcePages(row.id, true))) !== 0) continue;
    const facts = await storeCall({ member: 'getFactsHealth', sourceId: row.id }, () => brain.getFactsHealth(row.id)) as { total_active: number; total_expired: number };
    if (Number(facts.total_active) + Number(facts.total_expired) === 0) orphans.push({ id: row.id });
  }
  return orphans.sort((a, b) => byteCmp(a.id, b.id));
};

// Request log: served by the store.
export const readMcpRequestLogBytes: Member<'readMcpRequestLogBytes'> = async (brain) =>
  Number(await storeCall({ member: 'readMcpRequestLogBytes' }, () => brain.readMcpRequestLogBytes()));
export const countMcpRequestLogRows: Member<'countMcpRequestLogRows'> = async (brain, limit) =>
  Number(await storeCall({ member: 'countMcpRequestLogRows' }, () => brain.countMcpRequestLogRows(limit)));
export const hasMcpLogRowsPastWindow: Member<'hasMcpLogRowsPastWindow'> = async (brain, days, keepOperations) =>
  (await storeCall({ member: 'hasMcpLogRowsPastWindow' }, () => brain.hasMcpLogRowsPastWindow(days, [...keepOperations]))) === true;

// Schema shape: the store has the revision column set on every page, the write attribution current.
export const readKnowledgeRevisionNotNull: Member<'readKnowledgeRevisionNotNull'> = async () => true;
export const readDriftSchema: Member<'readDriftSchema'> = async () => 'current';
// The doctor asks only about pages_live_origin_key; the store has no SQL index to build, so that one reads as present.
export const originIndexPresent: Member<'originIndexPresent'> = async (_brain, name) => name === 'pages_live_origin_key';

/**
 * The live pages of a source (a batch after `at.after`, or the page at `at.slug`) and their versions, from the store
 * (cli_reads/doctor_drift.rs). `req` and `kind` come from the page's revision receipt or the version's archived actor,
 * and `remote` from the attributed journal request's authority, as the SQL's join reads them; an unattributed write
 * answers all three as null.
 */
export const listDriftLiveRows: Member<'listDriftLiveRows'> = (brain, _schema, sourceId, at) =>
  storeCall({ member: 'listDriftLiveRows' }, async () =>
    (await brain.listDriftLiveRows({ sourceId, after: at.after ?? null, slug: at.slug ?? null })) as never);
export const listDriftVersionRows: Member<'listDriftVersionRows'> = (brain, _schema, pageIds) =>
  pageIds.length === 0 ? Promise.resolve([]) : storeCall({ member: 'listDriftVersionRows' }, async () =>
    (await brain.listDriftVersionRows({ pageIds: [...pageIds] })) as never);

// Decide, proposals, chronicle, feedback and belief state: none is written on this engine.
export const readChronicleLedgerStats: Member<'readChronicleLedgerStats'> = async () => AVAILABLE_CHRONICLE_LEDGER_STATS;
export const readChronicleDuplicateEvents: Member<'readChronicleDuplicateEvents'> = async () => ({ pages: 0, surplus: 0 });
export const readFeedbackStatus: Member<'readFeedbackStatus'> = async () => ({
  events: 0, ratings_explicit: 0, ratings_cited: 0, weights_total: 0, weights_off_neutral: 0,
  last_rating_at: null, top_client_share_7d: null, lowest: [], highest: [],
});

/** The volunteer events of the last 7 days per channel, kept by the store (rust/docs/store/volunteer-events.md); `last_fired` comes back as a `Date`. */
export const listVolunteerChannels: Member<'listVolunteerChannels'> = async (brain, sourceIds) =>
  (await storeCall({ member: 'listVolunteerChannels' }, () => brain.listVolunteerChannels(sourceIds === null ? null : [...sourceIds])) as Array<{ channel: string; n: number; last_fired: string | null }>)
    .map(row => withDates(row, ['last_fired']));

// ---- the pages that name readers (the member-access checks), from the store's page records -------------------------

/** One live page that names readers, as the store lists it (cli_reads/doctor_acc.rs `list_reader_pages`). */
interface ReaderPage {
  id: number; source_id: string; slug: string; readers: string[]; updated_at: string; updated_us: number; writer: string | null;
  prior_names_readers: boolean | null;
}

const readerPages = (brain: Parameters<Member<'listMalformedReaderPages'>>[0], member: string, withinDays: number | null): Promise<ReaderPage[]> =>
  storeCall({ member }, () => brain.listReaderPages(withinDays)) as Promise<ReaderPage[]>;

/** Live pages whose `readable_by` normalizes to nobody, by source then slug (the first `limit`), each with the total. */
export const listMalformedReaderPages: Member<'listMalformedReaderPages'> = async (brain, limit) => {
  const malformed = (await readerPages(brain, 'listMalformedReaderPages', null)).filter(p => p.readers.length === 1 && p.readers[0] === '!nobody');
  return malformed.slice(0, limit).map(p => ({ source_id: p.source_id, slug: p.slug, total: malformed.length }));
};

/**
 * Readers named by pages that match no live member (`unknown`, or `retired` for a removed one) or no group (`unknown`, or
 * `empty_group` for one with no member), with the pages naming each and the first of them, by kind then reader in byte order.
 * A disabled member is a live one. Members and groups come from the store's access members.
 */
export const listUnknownReaders: Member<'listUnknownReaders'> = async (brain, limit) => {
  const pages = await readerPages(brain, 'listUnknownReaders', null);
  const members = new Map((await readAccessMembers(brain, { includeRemoved: true })).map(m => [m.id, m]));
  const groups = new Map((await readAccessGroups(brain, null)).map(g => [g.id, g.members.length]));
  const classify = (reader: string): 'unknown' | 'retired' | 'empty_group' | null => {
    if (reader.startsWith('member:')) {
      const member = members.get(reader.slice('member:'.length));
      return member === undefined ? 'unknown' : member.tombstoned_at != null ? 'retired' : null;
    }
    const size = groups.get(reader.slice('group:'.length));
    return size === undefined ? 'unknown' : size === 0 ? 'empty_group' : null;
  };
  const found = new Map<string, { reader: string; kind: 'unknown' | 'retired' | 'empty_group'; pages: number; sample: { source_id: string; slug: string } }>();
  for (const page of pages) {
    for (const reader of page.readers) {
      if (reader === '!nobody') continue;
      const kind = classify(reader);
      if (kind === null) continue;
      const row = found.get(reader);
      if (row) row.pages += 1;
      else found.set(reader, { reader, kind, pages: 1, sample: { source_id: page.source_id, slug: page.slug } });
    }
  }
  return [...found.values()].sort((a, b) => byteCmp(a.kind, b.kind) || byteCmp(a.reader, b.reader)).slice(0, limit);
};

/** Live pages written in the last `days` days that name readers where the newest earlier version named none, newest first (a tie by page id). */
export const listRecentReaderNarrowings: Member<'listRecentReaderNarrowings'> = async (brain, days, limit) => {
  const narrowed = (await readerPages(brain, 'listRecentReaderNarrowings', days)).filter(p => p.prior_names_readers === false)
    .sort((a, b) => b.updated_us - a.updated_us || a.id - b.id);
  return narrowed.slice(0, limit).map(p => ({ source_id: p.source_id, slug: p.slug, readers: p.readers, writer: p.writer, updated_at: p.updated_at, total: narrowed.length }));
};

/**
 * The chat census, from the store's page records. With `hidePrivate` the store reads the caller's fast page policy, and
 * only for the text it knows (storeFastPageTextPolicy); any other caller refuses.
 */
export const listChatChannelCensus: Member<'listChatChannelCensus'> = async (brain, sourceIds, chatTypes, dmTypes, hidePrivate) => {
  const policy = hidePrivate ? storeFastPageTextPolicy('listChatChannelCensus') : null;
  return await storeCall({ member: 'listChatChannelCensus' }, () =>
    brain.listChatChannelCensus([...sourceIds], [...chatTypes], [...dmTypes], policy)) as Array<{ source_id: string; chat_pages: number; channels: number }>;
};
