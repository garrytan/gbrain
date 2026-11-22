/**
 * The proactive brief's calendar, loop and page-edit reads (engine-sql/brief-reads.ts), answered from the store
 * (rust/crates/gbrain-store/src/cli_reads/brief_reads.rs).
 *
 * The page privacy maps as readBriefEntityPages's does (private-provenance.ts reflexPolicy): the meeting and alias reads
 * use the remote read floor. The timeline entry's event-page privacy maps the caller's page policy, or for `floor`
 * the no-caller page fragment (`privateTimelineEventFilterFragment`), as getTimeline does. The world facts use the
 * caller's fact policy. The eligibility maps to the store's trust floor and activation flag.
 */
import type {
  BriefEditPageRow, BriefEditReadOpts, BriefEmailAliasPageRow, BriefMeetingPageRow, BriefPageVersionRow, BriefReadEligibility,
  BriefTimelineEntryRow, BriefWorldFactRow,
} from '../../engine-sql/brief-reads.ts';
import { privateFactFilterForCaller, privatePagesFilterForCaller, remoteReadFloorSql } from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { reflexPolicy, storePageTextPolicy, storePrivacyPolicy, type StorePrivacyPolicy } from './private-provenance.ts';

function trust(eligibility: BriefReadEligibility | undefined) {
  return { minTrust: eligibility?.floor ?? null, suppressFlagged: eligibility?.suppressFlagged === true };
}

function timelinePolicy(member: string, privacy: BriefEditReadOpts['privacy']): StorePrivacyPolicy | null {
  if (privacy === 'none') return null;
  if (privacy === 'caller') return storePageTextPolicy(member, () => privatePagesFilterForCaller('p'), { callerReaders: true });
  // The SQL side gates 'floor' with remoteReadFloorSql (engine-sql/brief-reads.ts); the store judges the same text.
  if (privacy === 'floor') return storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true });
  refuseMember(member, `privacy ${String(privacy)}`);
}

const dated = <T extends Record<string, unknown>>(row: T, key: string) => ({ ...row, [key]: new Date(row[key] as string) });

export const readBriefMeetingPages: StoreMember<[sourceIds: readonly string[], startFrom: string, startTo: string, eligibility?: BriefReadEligibility], BriefMeetingPageRow[]> =
  async (brain, sourceIds, startFrom, startTo, eligibility) => {
    const policy = reflexPolicy('readBriefMeetingPages', 'floor');
    return storeCall({ member: 'readBriefMeetingPages' }, () =>
      brain.readBriefMeetingPages([...sourceIds], startFrom, startTo, policy, trust(eligibility))) as Promise<BriefMeetingPageRow[]>;
  };

export const readBriefEmailAliasPages: StoreMember<[sourceId: string, emails: readonly string[], eligibility?: BriefReadEligibility], BriefEmailAliasPageRow[]> =
  async (brain, sourceId, emails, eligibility) => {
    const policy = reflexPolicy('readBriefEmailAliasPages', 'floor');
    return storeCall({ member: 'readBriefEmailAliasPages', sourceId }, () =>
      brain.readBriefEmailAliasPages(sourceId, [...emails], policy, trust(eligibility))) as Promise<BriefEmailAliasPageRow[]>;
  };

export const readBriefWorldFacts: StoreMember<[factIds: readonly number[], eligibility?: BriefReadEligibility], BriefWorldFactRow[]> =
  async (brain, factIds, eligibility) => {
    const policy = storePrivacyPolicy('readBriefWorldFacts', true, () => privateFactFilterForCaller('facts'), { callerReaders: true }) ?? null;
    return storeCall({ member: 'readBriefWorldFacts' }, () =>
      brain.readBriefWorldFacts(factIds.map(Number), policy, trust(eligibility))) as Promise<BriefWorldFactRow[]>;
  };

export const readBriefEditPage: StoreMember<[sourceId: string, slug: string, maxBytes: number, opts: BriefEditReadOpts], BriefEditPageRow | null> =
  async (brain, sourceId, slug, maxBytes, opts) => {
    const policy = reflexPolicy('readBriefEditPage', opts.privacy);
    return storeCall({ member: 'readBriefEditPage', sourceId }, () =>
      brain.readBriefEditPage(sourceId, slug, maxBytes, policy, trust(opts.eligibility))) as Promise<BriefEditPageRow | null>;
  };

export const readBriefTimelineEntry: StoreMember<[pageId: number, since: string, opts: BriefEditReadOpts], BriefTimelineEntryRow | null> =
  async (brain, pageId, since, opts) => {
    const policy = timelinePolicy('readBriefTimelineEntry', opts.privacy);
    const row = await storeCall({ member: 'readBriefTimelineEntry' }, () =>
      brain.readBriefTimelineEntry(pageId, since, policy, trust(opts.eligibility))) as Record<string, unknown> | null;
    return row ? dated(row, 'created_at') as unknown as BriefTimelineEntryRow : null;
  };

export const readBriefPageVersions: StoreMember<[pageId: number, since: string, maxBytes: number, limit: number], BriefPageVersionRow[]> =
  async (brain, pageId, since, maxBytes, limit) => {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`readBriefPageVersions: limit must be a positive integer, got ${limit}`);
    const rows = await storeCall({ member: 'readBriefPageVersions' }, () =>
      brain.readBriefPageVersions(pageId, since, maxBytes, limit)) as Array<Record<string, unknown>>;
    return rows.map(row => dated(row, 'snapshot_at') as unknown as BriefPageVersionRow);
  };
