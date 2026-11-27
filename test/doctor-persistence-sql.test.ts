/**
 * The doctor persistence reads of src/core/engine-sql/doctor-persistence.ts keep the exact statement text the persistence
 * doctor checks and src/core/persistence/ helpers built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each statement that was built from a shared fragment (the refusal predicates, the current-binding and
 *    embedding-candidate predicates, the database-only page predicate, the orphan-binding statement, the managed-import and
 *    content-column fragments) carries that fragment's text verbatim, so the fragment and the member cannot drift apart.
 *  - Regression: a fragment changed in its home file without the member (or the reverse) changes what doctor counts on
 *    PGLite and Postgres, and the Rust store follows the member's text, not the fragment.
 *  - Why existing coverage misses it: the parity cases compare engines, not the text against the fragment.
 *  - Seam: a spy `EngineRawRead` that records the statements; nothing is executed (pure).
 */
import { describe, expect, test } from 'bun:test';
import * as sql from '../src/core/engine-sql/doctor-persistence.ts';
import type { EngineRawRead } from '../src/core/engine-sql/doctor-persistence.ts';
import { DRIFT_REFUSAL_SQL, GUARD_REFUSAL_SQL } from '../src/core/persistence/terminal-classify.ts';
import { CURRENT_BINDING_SQL } from '../src/core/persistence/parked-groups.ts';
import { EMBEDDING_CANDIDATE_WHERE } from '../src/core/persistence/embedding-settlement.ts';
import { databaseOnlyPageSql } from '../src/core/persistence/unbound-pages.ts';
import { ORPHANS } from '../src/core/persistence/orphan-bindings.ts';
import { CONTENT_COLUMNS, MANAGED_IMPORT } from '../src/core/persistence/overwritten-edits.ts';

/** The statements one member runs. */
async function statements(run: (raw: EngineRawRead) => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const raw: EngineRawRead = async (text) => { seen.push(text); return []; };
  await run(raw);
  return seen;
}

describe('doctor persistence SQL text', () => {
  test('the caller refusal reads carry the guard and drift refusal predicates', async () => {
    const guard = GUARD_REFUSAL_SQL('r');
    const drift = DRIFT_REFUSAL_SQL('r');
    for (const text of [
      ...await statements(raw => sql.listCallerRefusalRows(raw, ['s'], ['put_page'])),
      ...await statements(raw => sql.countCompactedCallerRefusals(raw, ['s'], ['put_page'])),
    ]) {
      expect(text).toContain(guard);
      expect(text).toContain(drift);
    }
  });

  test('the parked group read carries the current-binding predicate', async () => {
    const texts = await statements(raw => sql.listParkedGroupRows(raw, null));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toContain(CURRENT_BINDING_SQL);
  });

  test('the stale embedding reads carry the embedding candidate predicate', async () => {
    for (const text of [
      ...await statements(raw => sql.readStaleEmbeddingCounts(raw, null)),
      ...await statements(raw => sql.listStaleEmbeddingEffects(raw, null)),
    ]) expect(text).toContain(EMBEDDING_CANDIDATE_WHERE);
  });

  test('the unbound source read carries the database-only page predicate', async () => {
    const [text] = await statements(raw => sql.listUnboundSourcePages(raw));
    expect(text).toContain(databaseOnlyPageSql('p'));
  });

  test('the orphan binding read is the statement the check ran, ordered and limited when asked', async () => {
    expect(await statements(raw => sql.listOrphanBindingRows(raw, null))).toEqual([`${ORPHANS} ORDER BY b.source_id COLLATE "C"`]);
    expect(await statements(raw => sql.listOrphanBindingRows(raw, 1001.9))).toEqual([`${ORPHANS} ORDER BY b.source_id COLLATE "C" LIMIT 1001`]);
  });

  test('the overwrite candidate read carries the managed-import and content-column fragments', async () => {
    const [text] = await statements(raw => sql.listOverwriteCandidates(raw, 'default', 20, null));
    expect(text).toContain(MANAGED_IMPORT('s'));
    expect(text).toContain(CONTENT_COLUMNS('v'));
  });

  test('every member is listed once', () => {
    const members = Object.keys(sql).filter(name => typeof (sql as Record<string, unknown>)[name] === 'function');
    expect([...sql.DOCTOR_PERSISTENCE_MEMBERS].sort()).toEqual(members.sort());
  });
});
