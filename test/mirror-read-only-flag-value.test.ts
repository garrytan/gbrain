/**
 * #5409: which `sources.config.mirror_read_only` values make a source a read-only mirror for publication
 * (persistence/mirror-read-only.ts `sourceMirrorReadOnly`).
 *
 * Protects: the flag reads as master's statement read it, `COALESCE(config->>'mirror_read_only','false')='true'`: on for a
 * JSON true or the string "true" and off for every other value, including arrays whose JavaScript string form is "true"
 * (["true"], [true]). The typed source read (`readSourceState`) returns the parsed config, so the check must compare the
 * value itself, not its String() form. PGLite; the comparison runs in TypeScript, so the engine does not change it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sourceMirrorReadOnly } from '../src/core/persistence/mirror-read-only.ts';

describe('mirror_read_only flag values', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  const cases: Array<[string, unknown, boolean]> = [
    ['json-true', true, true],
    ['string-true', 'true', true],
    ['json-false', false, false],
    ['string-false', 'false', false],
    ['string-upper', 'TRUE', false],
    ['json-null', null, false],
    ['array-string-true', ['true'], false],
    ['array-true', [true], false],
    ['nested-array-true', [[true]], false],
  ];

  for (const [id, value, expected] of cases) {
    test(`${JSON.stringify(value)} reads as ${expected ? 'read-only' : 'writable'}`, async () => {
      const sourceId = `flag-${id}`;
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, jsonb_build_object('mirror_read_only', $2::jsonb))`,
        [sourceId, JSON.stringify(value)]);
      // What master's statement answers for the same row.
      const [sql] = await engine.executeRaw<{ read_only: boolean }>(
        `SELECT COALESCE(config->>'mirror_read_only','false')='true' AS read_only FROM sources WHERE id=$1`, [sourceId]);
      expect(sql!.read_only).toBe(expected);
      expect(await sourceMirrorReadOnly(engine, sourceId)).toBe(expected);
      expect(await sourceMirrorReadOnly(engine, sourceId, true)).toBe(expected);
    });
  }

  test('a source with no flag is writable', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('flag-absent', 'flag-absent', '{}'::jsonb)`);
    expect(await sourceMirrorReadOnly(engine, 'flag-absent')).toBe(false);
  });
});
