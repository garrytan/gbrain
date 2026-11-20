/**
 * The typed memory mutation reads (src/core/engine-sql/memory-mutation-reads.ts) send Postgres the statement text and
 * binds `remember` and `forget` (src/core/persistence/memory-mutations.ts) sent through `executeRaw` before the reads
 * had members. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old raw statement byte for byte, including the
 * factReadableUnder text with and without the private-provenance clause and under the owner's any-visibility rule, and
 * the remote forget guard's tier read (guardRemoteForget, src/core/trust/supersede-handlers.ts) with and without the
 * remote provenance floor, and the forget target read (src/core/persistence/forget-prepare.ts) in each form: any or world
 * visibility, the remote floor, a member's own page (whose slug now binds twice, $3 and $4, where the raw text reused $3)
 * and FOR UPDATE; and the reads that decide what a forget's withdrawal reaches (refuseForgetReachingOtherCopies and
 * ownerReachesFact, forget-prepare.ts): the unbacked check, the linked copies with and without the floor, the hidden
 * copy and the owner reach for an owner with and without a member identity; and the withdrawal claim read
 * (planFactWithdrawal, src/core/facts/withdrawal.ts) with and without a member page and the floor, and FOR UPDATE
 * (recordFactWithdrawal's row lock).
 * Fails when a member reorders a clause, renumbers a placeholder or binds a value as text.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { factVisibilitySql, factWithdrawalSubjectSql, onOwnedMemoryPageSql } from '../src/core/access/member-facts.ts';
import { outcomeMarkerSql } from '../src/core/facts/audit-sources.ts';
import { unbackedEntitySql } from '../src/core/facts/withdrawal-schema.ts';
import { projectionEligibleSql } from '../src/core/eligibility/sql.ts';
import { ownerReadPolicyFragment, privateProvenanceFilterUnderPolicy, readPolicyFragment, remoteProvenanceFloorSql } from '../src/core/search/private-visibility.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  const last = () => {
    const s = fake.statements().at(-1)!;
    return { text: s.text, params: s.params };
  };
  return { engine, last };
}

test('the source reads send the old remember and forget statements', async () => {
  const { engine, last } = recordingEngine();
  await engine.readSourceWriteRow('src-a');
  expect(last()).toEqual({
    text: "SELECT incarnation,archived,local_path,config->>'kind' AS kind,config->>'role' AS role FROM sources WHERE id=$1",
    params: ['src-a'],
  });
  await engine.readSourceLocalPath('src-a');
  expect(last()).toEqual({ text: 'SELECT local_path FROM sources WHERE id=$1', params: ['src-a'] });
});

test('the fact and page reads send the old forget statements', async () => {
  const { engine, last } = recordingEngine();
  await engine.readFactEntitySlug(42, 'src-a');
  expect(last()).toEqual({ text: 'SELECT entity_slug FROM facts WHERE id=$1 AND source_id=$2', params: [42, 'src-a'] });
  await engine.hasLiveFileBackedPage('src-a', ['notes/a', 'notes/b']);
  expect(last()).toEqual({
    text: 'SELECT 1 FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL AND source_path IS NOT NULL LIMIT 1',
    params: ['src-a', ['notes/a', 'notes/b']],
  });
});

test('factReadableUnder sends the old member withdrawal check, with and without the provenance clause', async () => {
  const { engine, last } = recordingEngine();
  const eligibility = { floor: 'tool_observed' as const };
  const eligible = projectionEligibleSql('facts', 'facts', eligibility);
  const old = (readable: string, provenance: string) =>
    `SELECT 1 FROM facts WHERE id=$1 AND source_id=$2 AND ${readable} AND ${eligible}${provenance}`;
  await engine.factReadableUnder({ id: 7, sourceId: 'src-a', anyVisibility: false, eligibility, excludePrivate: false });
  expect(last()).toEqual({ text: old(factVisibilitySql('facts', ['world']), ''), params: [7, 'src-a'] });
  await engine.factReadableUnder({ id: 7, sourceId: 'src-a', anyVisibility: false, eligibility, excludePrivate: true });
  expect(last()).toEqual({
    text: old(factVisibilitySql('facts', ['world']), ` AND ${privateProvenanceFilterUnderPolicy('facts')}`),
    params: [7, 'src-a'],
  });
  await engine.factReadableUnder({ id: 7, sourceId: 'src-a', anyVisibility: true, eligibility, excludePrivate: false });
  expect(last()).toEqual({ text: old('TRUE', ''), params: [7, 'src-a'] });
});

test('readRemoteForgetTier sends the old remote forget guard read, with and without the remote floor', async () => {
  const { engine, last } = recordingEngine();
  const old = (floor: string) => `SELECT trust_tier FROM facts WHERE id = $1 AND source_id = $2 AND visibility = 'world'${floor}`;
  await engine.readRemoteForgetTier({ factId: 9, sourceId: 'src-a', remoteFloor: false });
  expect(last()).toEqual({ text: old(''), params: [9, 'src-a'] });
  await engine.readRemoteForgetTier({ factId: 9, sourceId: 'src-a', remoteFloor: true });
  expect(last()).toEqual({ text: old(` AND ${remoteProvenanceFloorSql('facts')}`), params: [9, 'src-a'] });
});

test('readForgetTarget sends the forget target read, under the floor, on a member page and locked', async () => {
  const { engine, last } = recordingEngine();
  const head = 'SELECT id,entity_slug,source_markdown_slug,row_num,expired_at,trust_tier FROM facts\n    WHERE id=$1 AND source_id=$2 AND ';
  const base = { id: 5, sourceId: 'src-a', worldOnly: true, remoteFloor: false, lock: false, ownPage: null };
  await engine.readForgetTarget(base);
  expect(last()).toEqual({ text: `${head}($3::boolean=false OR visibility='world')`, params: [5, 'src-a', true] });
  await engine.readForgetTarget({ ...base, worldOnly: false, remoteFloor: true, lock: true });
  expect(last()).toEqual({
    text: `${head}($3::boolean=false OR visibility='world') AND ${remoteProvenanceFloorSql('facts')} FOR UPDATE`,
    params: [5, 'src-a', false],
  });
  const own = 'memory/members/alice-example';
  await engine.readForgetTarget({ ...base, remoteFloor: true, ownPage: own });
  expect(last()).toEqual({
    text: `${head}visibility='private' AND source_markdown_slug=$3 AND EXISTS (SELECT 1 FROM pages member_page\n      WHERE member_page.source_id=facts.source_id AND member_page.slug=$4 AND member_page.deleted_at IS NULL AND member_page.page_readers && ARRAY[$5::text])`,
    params: [5, 'src-a', own, own, 'member:alice-example'],
  });
});

test('the forget reach reads send the old refuseForgetReachingOtherCopies statements', async () => {
  const { engine, last } = recordingEngine();
  await engine.isFactEntityUnbacked(5, 'src-a');
  expect(last()).toEqual({ text: `SELECT ${unbackedEntitySql('u')} AS unbacked FROM facts u WHERE u.id=$1 AND u.source_id=$2`, params: [5, 'src-a'] });
  const linked = (floor: string) => `SELECT l.id,l.entity_slug FROM facts u
      JOIN facts l ON l.source_id=u.source_id AND l.visibility=u.visibility AND l.entity_slug IS NOT NULL AND l.entity_slug IS DISTINCT FROM u.entity_slug AND l.id<>u.id
        AND l.expired_at IS NULL AND (l.valid_until IS NULL OR l.valid_until > now())
        AND gbrain_fact_fingerprint(l.fact)=gbrain_fact_fingerprint(u.fact)
      WHERE u.id=$1 AND u.source_id=$2 AND ($3::boolean=false OR l.visibility='world')${floor}
      ORDER BY l.id LIMIT 5`;
  await engine.readLinkedFactCopies({ id: 5, sourceId: 'src-a', worldOnly: false, remoteFloor: false });
  expect(last()).toEqual({ text: linked(''), params: [5, 'src-a', false] });
  await engine.readLinkedFactCopies({ id: 5, sourceId: 'src-a', worldOnly: true, remoteFloor: true });
  expect(last()).toEqual({ text: linked(` AND ${remoteProvenanceFloorSql('l')}`), params: [5, 'src-a', true] });
  await engine.hasHiddenFactCopy({ id: 5, sourceId: 'src-a' });
  expect(last()).toEqual({
    text: `SELECT 1 FROM facts u
    JOIN facts l ON l.source_id=u.source_id AND l.visibility=u.visibility AND l.id<>u.id
      AND (u.entity_slug IS NULL OR ${unbackedEntitySql('u')} OR l.entity_slug=u.entity_slug)
      AND l.expired_at IS NULL AND (l.valid_until IS NULL OR l.valid_until > now())
      AND gbrain_fact_fingerprint(l.fact)=gbrain_fact_fingerprint(u.fact)
    WHERE u.id=$1 AND u.source_id=$2 AND NOT (${remoteProvenanceFloorSql('l')}) LIMIT 1`,
    params: [5, 'src-a'],
  });
});

test('ownerReachesFact sends the old owner reach statement, with and without a member identity', async () => {
  const { engine, last } = recordingEngine();
  const old = (identity: readonly string[], satisfied: readonly string[]) => {
    const page = `(${ownerReadPolicyFragment('pp', identity, satisfied)} AND ${readPolicyFragment('pp', identity, true, satisfied)})`;
    return `SELECT 1 FROM facts WHERE id=$1 AND source_id=$2 AND NOT ${onOwnedMemoryPageSql('facts')}
    AND NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id=facts.source_id AND pp.slug IN (facts.source_markdown_slug, facts.entity_slug) AND NOT ${page})`;
  };
  await engine.ownerReachesFact({ id: 5, sourceId: 'src-a', identity: [], satisfied: [] });
  expect(last()).toEqual({ text: old([], []), params: [5, 'src-a'] });
  const identity = ['member:alice-example'];
  await engine.ownerReachesFact({ id: 5, sourceId: 'src-a', identity, satisfied: ['rule-1'] });
  expect(last()).toEqual({ text: old(identity, ['rule-1']), params: [5, 'src-a'] });
});

test('readFactWithdrawalClaim sends the old planFactWithdrawal statement, with and without a member page and the floor, and locked', async () => {
  const { engine, last } = recordingEngine();
  const old = (floor: boolean, lock = false) => `SELECT visibility,fact,gbrain_fact_fingerprint(fact) AS fact_hash,${factWithdrawalSubjectSql('facts')} AS subject,expired_at IS NOT NULL AS expired FROM facts WHERE id=$1 AND source_id=$2
      AND NOT ${outcomeMarkerSql('facts')} AND ($3::boolean=false OR visibility='world' OR (visibility='private' AND source_markdown_slug=$4::text))${floor ? ` AND ${remoteProvenanceFloorSql('facts')}` : ''}${lock ? ' FOR UPDATE' : ''}`;
  await engine.readFactWithdrawalClaim({ id: 5, sourceId: 'src-a', worldOnly: false, memberPage: null, remoteFloor: false });
  expect(last()).toEqual({ text: old(false), params: [5, 'src-a', false, null] });
  await engine.readFactWithdrawalClaim({ id: 5, sourceId: 'src-a', worldOnly: true, memberPage: 'memory/members/alice-example', remoteFloor: false });
  expect(last()).toEqual({ text: old(false), params: [5, 'src-a', true, 'memory/members/alice-example'] });
  await engine.readFactWithdrawalClaim({ id: 5, sourceId: 'src-a', worldOnly: true, memberPage: null, remoteFloor: true });
  expect(last()).toEqual({ text: old(true), params: [5, 'src-a', true, null] });
  // recordFactWithdrawal's row lock (src/core/facts/withdrawal.ts) reads the same claim FOR UPDATE.
  await engine.readFactWithdrawalClaim({ id: 5, sourceId: 'src-a', worldOnly: true, memberPage: 'memory/members/alice-example', remoteFloor: true, lock: true });
  expect(last()).toEqual({ text: old(true, true), params: [5, 'src-a', true, 'memory/members/alice-example'] });
});
