/**
 * The typed memory mutation reads (src/core/engine-sql/memory-mutation-reads.ts) send Postgres the statement text and
 * binds `remember` and `forget` (src/core/persistence/memory-mutations.ts) sent through `executeRaw` before the reads
 * had members. A drift here changes a query plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old raw statement byte for byte, including the
 * factReadableUnder text with and without the private-provenance clause and under the owner's any-visibility rule, and
 * the remote forget guard's tier read (guardRemoteForget, src/core/trust/supersede-handlers.ts) with and without the
 * remote provenance floor.
 * Fails when a member reorders a clause, renumbers a placeholder or binds a value as text.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { factVisibilitySql } from '../src/core/access/member-facts.ts';
import { projectionEligibleSql } from '../src/core/eligibility/sql.ts';
import { privateProvenanceFilterUnderPolicy, remoteProvenanceFloorSql } from '../src/core/search/private-visibility.ts';
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
