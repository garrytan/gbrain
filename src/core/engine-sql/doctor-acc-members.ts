/**
 * The member names of engine-sql/doctor-acc.ts, kept in a leaf module so src/core/statement-deadline.ts can read
 * them without loading doctor-acc.ts and its utils.ts import closure (the chunker WASM smoketest compiles that path).
 * Each member replaced a statement doctor ran through its deadline-bound executeRaw, so statement-deadline.ts keeps
 * that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_ACC_MEMBERS: readonly string[] = [
  'listAccessPolicySourceIds', 'isAccessStateUnreadable', 'listRawOnlyRules', 'listAudienceMemberIds', 'listLabelledOnlyMemberIds', 'listAccessMemberRows',
  'listAttestCredentialRows', 'listActiveAccessTokenRows', 'listActiveOauthClientRows', 'listOauthClientAuthShapes', 'listDanglingFederatedReads',
  'listOrphanWorkspaceSources', 'listPrivilegedDcrClients', 'readMcpRequestLogBytes', 'countMcpRequestLogRows', 'hasMcpLogRowsPastWindow',
  'readKnowledgeRevisionNotNull', 'readDriftSchema', 'listDriftLiveRows', 'listDriftVersionRows', 'originIndexPresent',
  'readChronicleLedgerStats', 'readChronicleDuplicateEvents', 'readFeedbackStatus', 'listCoveredSources',
  'listVolunteerChannels', 'listMalformedReaderPages', 'listUnknownReaders', 'listRecentReaderNarrowings',
  'countAccessFolderDrift',
];
