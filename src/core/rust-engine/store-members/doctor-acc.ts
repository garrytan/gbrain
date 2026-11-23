/**
 * Doctor reads, second set (src/core/engine-sql/doctor-acc.ts): the statements the access, token, OAuth, request-log,
 * decide, chronicle, feedback, belief and volunteer checks ran through executeRaw. The request-log reads are served by
 * gbrain-store (rust/crates/gbrain-store/src/cli_reads/doctor_acc.rs). The rest answer for state the store does not
 * keep, as listAppliedPolicyRevisions does (write-misc.ts); what each answers and why: rust/docs/store/cli-reads-doctor-acc.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { AVAILABLE_CHRONICLE_LEDGER_STATS } from '../../engine-sql/doctor-acc.ts';
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

// Decide, proposals and belief state: none is written on this engine. The chronicle ledger, retrieval feedback and the
// volunteer log are read from the store below.
/**
 * The automatic ledger rows' rollup, from the store's ledger records (chronicle_ledger.rs), shaped as
 * engine-sql/doctor-acc.ts readChronicleLedgerStats shapes its four statements: reasons tallied in their row order
 * (count, then byte of reason), the five busiest principals by calls, then byte of principal.
 */
export const readChronicleLedgerStats: Member<'readChronicleLedgerStats'> = async (brain) => {
  type Sections = {
    counts: { pending: number; extracted: number; failed: number; skipped: number; known_usd: number | null; unpriced: number; incomplete: number };
    reasons: Array<{ state: string; reason: string; n: number }>;
    calls: number;
    principals: Array<{ principal: string; calls: number }>;
  };
  const { counts, reasons, calls, principals } = await storeCall({ member: 'readChronicleLedgerStats' }, () => brain.readChronicleLedger()) as Sections;
  const tally = (rows: Sections['reasons']) => rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.reason] = (acc[r.reason] ?? 0) + Number(r.n);
    return acc;
  }, {});
  return {
    ...AVAILABLE_CHRONICLE_LEDGER_STATS,
    pending: Number(counts.pending),
    autoCalls24h: Number(calls),
    principals24h: principals.map(p => ({ principal: p.principal, calls: Number(p.calls) })),
    last7d: { extracted: Number(counts.extracted), failed: Number(counts.failed), skipped: Number(counts.skipped),
      reasons: tally(reasons), failedReasons: tally(reasons.filter(r => r.state === 'failed')) },
    spend7d: { knownUsd: Number(counts.known_usd ?? 0), unpricedCalls: Number(counts.unpriced), incompleteRecords: Number(counts.incomplete) },
  };
};
export const readChronicleDuplicateEvents: Member<'readChronicleDuplicateEvents'> = async () => ({ pages: 0, surplus: 0 });
/** The feedback counts and the ten lowest and highest page weights, from the store's feedback records (retrieval_feedback.rs). */
export const readFeedbackStatus: Member<'readFeedbackStatus'> = async (brain) => {
  type Status = {
    counts: { events: number; ratings_explicit: number; ratings_cited: number; weights_total: number; weights_off_neutral: number; last_rating_at: string | null; top_client_share_7d: number | null };
    lowest: Array<{ source_id: string; slug: string; weight: number; low_ratings: number }>;
    highest: Array<{ source_id: string; slug: string; weight: number }>;
  };
  const { counts, lowest, highest } = await storeCall({ member: 'readFeedbackStatus' }, () => brain.readFeedbackStatus()) as Status;
  return {
    events: Number(counts.events), ratings_explicit: Number(counts.ratings_explicit), ratings_cited: Number(counts.ratings_cited),
    weights_total: Number(counts.weights_total), weights_off_neutral: Number(counts.weights_off_neutral),
    last_rating_at: counts.last_rating_at ? new Date(counts.last_rating_at) : null,
    top_client_share_7d: counts.top_client_share_7d == null ? null : Number(counts.top_client_share_7d),
    lowest: lowest.map(r => ({ source_id: r.source_id, slug: r.slug, weight: Number(r.weight), low_ratings: Number(r.low_ratings) })),
    highest: highest.map(r => ({ source_id: r.source_id, slug: r.slug, weight: Number(r.weight) })),
  };
};
/** The volunteered-page log per channel over the last 7 days, from the store's event records (volunteer_events.rs). */
export const listVolunteerChannels: Member<'listVolunteerChannels'> = async (brain, sourceIds) => {
  const rows = await storeCall({ member: 'listVolunteerChannels' }, () => brain.listVolunteerChannels(sourceIds ? [...sourceIds] : null)) as Array<{ channel: string; n: number; last_fired: string | null }>;
  return rows.map(r => ({ channel: r.channel, n: r.n, last_fired: r.last_fired === null ? null : new Date(r.last_fired) }));
};
