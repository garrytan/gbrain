/**
 * Doctor reads, second set (src/core/engine-sql/doctor-acc.ts): the statements the access, token, OAuth, request-log,
 * decide, chronicle, feedback, belief and volunteer checks ran through executeRaw. The request-log reads are served by
 * gbrain-store (rust/crates/gbrain-store/src/cli_reads/doctor_acc.rs). The rest answer for state the store does not
 * keep, as listAppliedPolicyRevisions does (write-misc.ts); what each answers and why: rust/docs/store/cli-reads-doctor-acc.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { AVAILABLE_CHRONICLE_LEDGER_STATS } from '../../engine-sql/doctor-acc.ts';
import { storeCall, type StoreMember } from './common.ts';
import { withDates } from '../store-codec.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

// Access state the rows below answer for (the member reads above read the store's member records).
export const isAccessStateUnreadable: Member<'isAccessStateUnreadable'> = async () => false;
/** The store's rules (access_rules.rs) that keep only raw pages (`covers_derived` false), by (source, rule id) in byte order. */
export const listRawOnlyRules: Member<'listRawOnlyRules'> = async (brain) => {
  const sources = (await storeCall({ member: 'listRawOnlyRules' }, () => brain.listSourceRoutingRows())) as Array<{ id: string }>;
  const out: Array<{ source_id: string; rule_id: string; prefix: string }> = [];
  for (const { id } of sources) {
    const rules = (await storeCall({ member: 'listRawOnlyRules', sourceId: id }, () => brain.listAccessRules(id))) as Array<{ rule_id: string; prefix: string; covers_derived: boolean }>;
    for (const r of rules) if (!r.covers_derived) out.push({ source_id: id, rule_id: r.rule_id, prefix: r.prefix });
  }
  const key = (r: { source_id: string; rule_id: string }) => [r.source_id, r.rule_id] as const;
  return out.sort((a, b) => { const [x, y] = [key(a), key(b)]; return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0; });
};
/** The store keeps access members (access_members.rs): the enabled, unremoved members of one kind or with one grant, by id in byte order. */
async function liveMemberIds(brain: Parameters<StoreMember<[], string[]>>[0], member: string, keep: (row: { kind: string; labelled_only: boolean }) => boolean): Promise<string[]> {
  const rows = (await storeCall({ member }, () => brain.readAccessMembers({}))) as
    Array<{ id: string; kind: string; labelled_only: boolean; disabled_at: unknown; tombstoned_at: unknown }>;
  return rows.filter(r => r.disabled_at == null && r.tombstoned_at == null && keep(r)).map(r => r.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
export const listAudienceMemberIds: Member<'listAudienceMemberIds'> = async (brain) => liveMemberIds(brain, 'listAudienceMemberIds', r => r.kind === 'audience');
export const listLabelledOnlyMemberIds: Member<'listLabelledOnlyMemberIds'> = async (brain) => liveMemberIds(brain, 'listLabelledOnlyMemberIds', r => r.labelled_only === true);
/** The store's member records (access_members.rs) with their groups, by id; removed members only when asked. */
export const listAccessMemberRows: Member<'listAccessMemberRows'> = async (brain, includeRemoved) =>
  ((await storeCall({ member: 'listAccessMemberRows' }, () => brain.readAccessMembers({ includeRemoved }))) as Array<Record<string, unknown>>)
    .map(row => withDates(row, ['disabled_at', 'tombstoned_at', 'created_at']));
export const listAttestCredentialRows: Member<'listAttestCredentialRows'> = async () => [];
export const listActiveAccessTokenRows: Member<'listActiveAccessTokenRows'> = async () => [];
export const listActiveOauthClientRows: Member<'listActiveOauthClientRows'> = async () => [];
export const listOauthClientAuthShapes: Member<'listOauthClientAuthShapes'> = async () => [];
export const listDanglingFederatedReads: Member<'listDanglingFederatedReads'> = async () => [];
export const listPrivilegedDcrClients: Member<'listPrivilegedDcrClients'> = async () => [];

/** A source named `*suffix` with no path, no pages (deleted ones count), no facts and not archived; no client names one. */
export const listOrphanWorkspaceSources: Member<'listOrphanWorkspaceSources'> = async (brain, suffix) => {
  const orphans: Array<{ id: string }> = [];
  for (const row of await storeCall({ member: 'listSourceRoutingRows' }, () => brain.listSourceRoutingRows()) as Array<{ id: string; local_path: string | null; archived: boolean }>) {
    if (!row.id.endsWith(suffix) || row.local_path !== null || row.archived) continue;
    if (Number(await storeCall({ member: 'countSourcePages', sourceId: row.id }, () => brain.countSourcePages(row.id, true))) !== 0) continue;
    const facts = await storeCall({ member: 'getFactsHealth', sourceId: row.id }, () => brain.getFactsHealth(row.id)) as { total_active: number; total_expired: number };
    if (Number(facts.total_active) + Number(facts.total_expired) === 0) orphans.push({ id: row.id });
  }
  return orphans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

// Decide, proposals, chronicle, feedback, belief and volunteer state: none is written on this engine.
export const readChronicleLedgerStats: Member<'readChronicleLedgerStats'> = async () => AVAILABLE_CHRONICLE_LEDGER_STATS;
export const readChronicleDuplicateEvents: Member<'readChronicleDuplicateEvents'> = async () => ({ pages: 0, surplus: 0 });
export const readFeedbackStatus: Member<'readFeedbackStatus'> = async () => ({
  events: 0, ratings_explicit: 0, ratings_cited: 0, weights_total: 0, weights_off_neutral: 0,
  last_rating_at: null, top_client_share_7d: null, lowest: [], highest: [],
});
export const listVolunteerChannels: Member<'listVolunteerChannels'> = async () => [];
