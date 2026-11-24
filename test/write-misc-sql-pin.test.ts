/**
 * The write-side reads of src/core/engine-sql/write-misc.ts send Postgres the statement text and binds the call
 * sites sent through `executeRaw` before they were members. A drift here changes a query plan or a result on Postgres
 * alone, which PGLite parity cannot see.
 *
 * Protects: each member sends its statement's table, clauses and order as the old raw statement had them, with the
 * same binds in the same positions. Fails when a member renames a table, drops a filter, reorders a clause or binds a
 * value differently. No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text.replace(/\s+/g, ' ').trim(), params: s.params };
  };
  return { engine, last };
}

const SRC = 'src-a';
const HOST = '5f1c1d0e-8f64-4d6c-9d52-3f2d1c0b9a11';
const REQ = '0b6f2c3e-1d4a-4e5b-8c7d-9e0f1a2b3c4d';

type Pin = { name: string; call: (e: PostgresEngine) => Promise<unknown>; text: string[]; params: unknown[] };

const PINS: Pin[] = [
  { name: 'readSourceState', call: e => e.readSourceState(SRC), text: ['SELECT incarnation,archived,local_path,config FROM sources WHERE id=$1'], params: [SRC] },
  { name: 'readSourceState (share lock)', call: e => e.readSourceState(SRC, { lock: 'share' }), text: ['FROM sources WHERE id=$1 FOR SHARE'], params: [SRC] },
  { name: 'readAdmissionSource', call: e => e.readAdmissionSource(SRC), text: ['s.config->>\'kind\' AS kind', 'guest_sources', 'FROM sources s'], params: [SRC] },
  { name: 'sharedSkillPackTablePresent', call: e => e.sharedSkillPackTablePresent(), text: ["SELECT to_regclass('shared_skill_packs') IS NOT NULL AS present"], params: [] },
  { name: 'hasNotifierCoverage', call: e => e.hasNotifierCoverage(), text: ['SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered'], params: [] },
  { name: 'readOpCheckpointKeys', call: e => e.readOpCheckpointKeys('sync', 'fp-1'), text: ['FROM op_checkpoint_paths WHERE op = $1 AND fingerprint = $2 UNION ALL', "jsonb_typeof(completed_keys) = 'array'", "jsonb_typeof(completed_keys) <> 'array'"], params: ['sync', 'fp-1'] },
  { name: 'readHealthMemoClock', call: e => e.readHealthMemoClock(), text: ['FROM persistence_brain WHERE singleton = 1', 'last_value FROM page_generation_clock_seq'], params: [] },
  { name: 'listSynopsisSourceIds', call: e => e.listSynopsisSourceIds(), text: ["SELECT id FROM sources WHERE contextual_retrieval_mode = 'per_chunk_synopsis' AND NOT archived ORDER BY id"], params: [] },
  { name: 'listSharedSkillPackRoots', call: e => e.listSharedSkillPackRoots(HOST), text: ['FROM shared_skill_packs p JOIN sources s ON s.id=p.source_id AND s.incarnation=p.source_incarnation', 'h.host_id=$1::uuid'], params: [HOST] },
  { name: 'getWorktreeBinding', call: e => e.getWorktreeBinding(SRC, HOST), text: ['FROM persistence_source_bindings s JOIN persistence_worktrees w ON w.id=s.worktree_id', 'h.host_id=$2::uuid WHERE s.source_id=$1'], params: [SRC, HOST] },
  { name: 'hasExtractedEvents', call: e => e.hasExtractedEvents(SRC, 7), text: ["SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND state='extracted' AND cardinality(event_hashes) > 0 LIMIT 1"], params: [SRC, 7] },
  { name: 'listActiveAccessMembers', call: e => e.listActiveAccessMembers(), text: ['SELECT id FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id'], params: [] },
  { name: 'hasLabelledOnlyMember', call: e => e.hasLabelledOnlyMember(), text: ['SELECT 1 FROM access_members WHERE labelled_only LIMIT 1'], params: [] },
  { name: 'listAccessTokens', call: e => e.listAccessTokens(), text: ['SELECT * FROM access_tokens ORDER BY created_at DESC'], params: [] },
  { name: 'attachSourcePath', call: e => e.attachSourcePath(SRC, '/work/a', { name: 'Name A', federated: true }), text: ['UPDATE sources SET local_path = $2, name = COALESCE($3, name)', "jsonb_build_object('federated', $4::boolean) END WHERE id = $1"], params: [SRC, '/work/a', 'Name A', true] },
  { name: 'expireMemoryProposals', call: e => e.expireMemoryProposals('lapsed'), text: ["UPDATE memory_proposals SET state='expired', reason=$1, decided_by='gbrain:expiry'", "WHERE state='awaiting_owner' AND expires_at<=now() RETURNING 1"], params: ['lapsed'] },
  { name: 'listAwaitingMemoryProposals', call: e => e.listAwaitingMemoryProposals(5), text: ["SELECT * FROM memory_proposals WHERE state='awaiting_owner' ORDER BY created_at LIMIT $1"], params: [5] },
  { name: 'readMemoryProposal', call: e => e.readMemoryProposal('member', 'm1', REQ), text: ['SELECT * FROM memory_proposals WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid'], params: ['member', 'm1', REQ] },
  { name: 'readPendingProposalSummary', call: e => e.readPendingProposalSummary(), text: ['SELECT count(*) AS n,', "FROM memory_proposals WHERE state='awaiting_owner' AND expires_at>now()"], params: [] },
  { name: 'listMemoryProposalRows', call: e => e.listMemoryProposalRows({ sourceId: SRC, all: false, limit: 20, afterAt: null, afterId: null }), text: ['SELECT * FROM memory_proposals WHERE ($1::text IS NULL OR source_id=$1)', "($2::boolean OR state='awaiting_owner')", "ORDER BY date_trunc('milliseconds', created_at), request_id LIMIT $3"], params: [SRC, false, 20, null, null] },
  { name: 'listOwnerProposalRows', call: e => e.listOwnerProposalRows(REQ), text: ['SELECT * FROM memory_proposals WHERE request_id=$1::uuid LIMIT 2'], params: [REQ] },
  { name: 'purgeMemoryProposals', call: e => e.purgeMemoryProposals(30), text: ["DELETE FROM memory_proposals WHERE state<>'awaiting_owner'", "COALESCE(decided_at, updated_at) <= now() - ($1::integer * interval '1 day') RETURNING 1"], params: [30] },
];

for (const pin of PINS) {
  test(`${pin.name} sends the old statement and binds`, async () => {
    const { engine, last } = recordingEngine();
    await pin.call(engine);
    const sent = last();
    for (const fragment of pin.text) expect(sent.text).toContain(fragment);
    expect(sent.params).toEqual(pin.params);
  });
}
