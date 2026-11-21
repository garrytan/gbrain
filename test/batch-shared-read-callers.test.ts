/**
 * The last unowned raw senders behind the shared-read memos: the drift check's clamp count, the export inventory's
 * source row, and a writer-row statement no caller sends any more.
 *
 * Fail-first: on the base 761280a028 persistence-compaction.ts read `(SELECT value FROM config WHERE key=$1)` inside
 * the drift statement, migration-export.ts sent `SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived`,
 * and the three memo sets still named `SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers`, so every
 * test below except the matcher check fails there.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the clamp count is a typed `getConfig` read; the export inventory reads its source through the typed
 *    `readSourceState`; no memo set names a statement that no caller sends (its writer row is the typed
 *    `readLocalWriterRow`, which `preparationReads` and `batchSharedReads` already answer).
 *  - Regression: a raw read here reaches the Rust engine's raw_sql refusal; a dead memo entry hides that the raw
 *    branch it keeps alive has no sender.
 *  - Why existing coverage misses it: the caller suites run on the SQL engines, where the raw reads answer. The
 *    behaviour is pinned by test/doctor-persistence-compaction.test.ts (the clamp count with no counter row,
 *    fail-first) and test/shared-skills-export.serial.test.ts (the policy hash equals the stored row's hash, a pin).
 *  - Seam: none; the source text of each file.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const CLAMP_SUBQUERY = /\(\s*SELECT\s+value\s+FROM\s+config\s+WHERE\s+key\s*=\s*\$1\s*\)/;
const EXPORT_SOURCE = /SELECT\s+config\s*,\s*incarnation\s+FROM\s+sources\s+WHERE\s+id\s*=\s*\$1\s+AND\s+NOT\s+archived/;
const DEAD_WRITER = /SELECT\s+lane\s*,\s*revoked_at\s*,\s*grant_ceiling\s+FROM\s+persistence_local_writers/;

describe('the unowned shared-read senders read typed members', () => {
  test('the drift check reads the clamp count through getConfig, not inside the drift statement', () => {
    const text = read('src/commands/doctor/checks/persistence-compaction.ts');
    expect(text).not.toMatch(CLAMP_SUBQUERY);
    expect(text).toContain('engine.getConfig(TRUE_UP_CLAMPED_KEY)');
  });

  test('the export inventory reads its source through readSourceState', () => {
    const text = read('src/core/shared-skills/migration-export.ts');
    expect(text).not.toMatch(EXPORT_SOURCE);
    expect(text).toContain('engine.readSourceState(sourceId)');
  });

  for (const rel of ['src/core/persistence/group-publish.ts', 'src/core/persistence/page-mutations.ts', 'src/core/persistence/preadmit-cache.ts']) {
    test(`${rel} names no writer-row statement that no caller sends`, () => {
      expect(read(rel)).not.toMatch(DEAD_WRITER);
    });
  }

  test('the matchers see the raw shapes the callers sent', () => {
    expect('COALESCE(e.topo_bytes,0)::text AS topo_bytes,(SELECT value FROM config WHERE key=$1) AS clamped').toMatch(CLAMP_SUBQUERY);
    expect("executeRaw('SELECT config,incarnation FROM sources WHERE id=$1 AND NOT archived', [sourceId])").toMatch(EXPORT_SOURCE);
    expect("'SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid'").toMatch(DEAD_WRITER);
    expect("'SELECT lane,credential_hash,grant_ceiling,revoked_at FROM persistence_local_writers WHERE id=$1::uuid'").not.toMatch(DEAD_WRITER);
  });
});
