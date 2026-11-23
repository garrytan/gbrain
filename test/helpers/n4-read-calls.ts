/** One call per N4 read member on the Postgres engine (the reads that replaced executeRaw statements in the import, extract, company-brain and job-description paths). */
import type { BrainEngine } from '../../src/core/engine.ts';

export const N4_CALLS: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  listSourceRecords: (e) => e.listSourceRecords(),
  readSourceIncarnation: (e) => e.readSourceIncarnation('default'),
  hasCompanyBrainReceipt: (e) => e.hasCompanyBrainReceipt('default'),
  readDatabaseClock: (e) => e.readDatabaseClock(),
  listLinkPageMetadata: (e) => e.listLinkPageMetadata('default'),
  listStoredTimelineRows: (e) => e.listStoredTimelineRows('default', 'people/a'),
  filterPagesAtRevision: (e) => e.filterPagesAtRevision([{ source_id: 'default', slug: 'people/a', revision: '1' }]),
  nextLivePageAfter: (e) => e.nextLivePageAfter(0),
  readMentionLastPass: (e) => e.readMentionLastPass('default'),
  findExactBasenameCandidates: (e) => e.findExactBasenameCandidates('default', ['people/a']),
  readJobInsight: (e) => e.readJobInsight({ jobIds: [1], waitingIds: [1], waitingQueues: ['default'], parentIds: [1], lockIds: ['x'], holderQueue: 'default', owner: 'c' }),
};
