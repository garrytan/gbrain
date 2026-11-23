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

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

// Access state: no folder rule, member, token, OAuth client or grant exists on this engine.
export const isAccessStateUnreadable: Member<'isAccessStateUnreadable'> = async () => false;
export const listRawOnlyRules: Member<'listRawOnlyRules'> = async () => [];
export const listAudienceMemberIds: Member<'listAudienceMemberIds'> = async () => [];
export const listLabelledOnlyMemberIds: Member<'listLabelledOnlyMemberIds'> = async () => [];
export const listAccessMemberRows: Member<'listAccessMemberRows'> = async () => [];
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
