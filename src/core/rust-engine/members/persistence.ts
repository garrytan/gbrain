/** The persistence journal members. Part of the member-to-family map composed in ../members.ts. */
import type { BrainEngine } from '../../engine.ts';
import type { MemberClass } from '../members.ts';

export const PERSISTENCE_MEMBERS = {
  readWriterSlugFence: 'persistence_journal',
  // The remote links effect and its batch re-arm (engine-sql/remote-links.ts).
  setEffectTransactionLimits: 'persistence_journal',
  readOwnedLinks: 'persistence_journal',
  deleteOwnedLinks: 'persistence_journal',
  readLinkTargetPages: 'persistence_journal',
  readWriteRequest: 'persistence_journal',
  readWriteRequestById: 'persistence_journal',
  readOAuthClientWriteGrant: 'persistence_journal',
  readAccessTokenWriteGrant: 'persistence_journal',
  shareLockWriteCredential: 'persistence_journal',
  readCounterRows: 'persistence_journal',
  lockPersistenceCounters: 'persistence_journal',
  insertWriteRequest: 'persistence_journal',
  stampWriteClaim: 'persistence_journal',
  lockWriteRequest: 'persistence_journal',
  completeWriteRow: 'persistence_journal',
  lockWriteRequestsById: 'persistence_journal',
  compactTerminalIntent: 'persistence_journal',
  insertPublicationEffects: 'persistence_journal',
  readSourceMembership: 'persistence_journal',
  renewWriteClaim: 'persistence_journal',
  readRequestEffects: 'persistence_journal',
  renewEffectClaim: 'persistence_journal',
  completeEffectRow: 'persistence_journal',
  failEffectRow: 'persistence_journal',
  lockEffectGuard: 'persistence_journal',
  readSegmentedGateEvidence: 'persistence_journal',
} as const satisfies Partial<Record<keyof BrainEngine, MemberClass>>;
