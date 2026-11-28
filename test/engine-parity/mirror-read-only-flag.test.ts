/**
 * BrainEngine parity — which `sources.config.mirror_read_only` values make a source a read-only mirror (#5409,
 * persistence/mirror-read-only.ts `sourceMirrorReadOnly`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), the flag turns a
 *    source read-only only for a JSON true or the string "true", as master's statement read it
 *    (`COALESCE(config->>'mirror_read_only','false')='true'`); every other value, arrays whose JavaScript string form is
 *    "true" (["true"], [true], [[true]]) included, leaves it writable.
 *  - Regression: the typed source read (`readSourceState`) returns the parsed config, and the check compared its
 *    String() form, so ["true"] read as a read-only mirror on every engine (P-0b, master #10407, ported to the trunk).
 *  - Why existing coverage misses it: test/mirror-read-only-flag-value.test.ts runs on PGLite only.
 *  - Seam: none.
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { sourceMirrorReadOnly } from '../../src/core/persistence/mirror-read-only.ts';

const { parityTest } = parityArms(testBackends());

const VALUES: Array<[string, unknown]> = [
  ['json-true', true], ['string-true', 'true'], ['json-false', false], ['string-false', 'false'], ['string-upper', 'TRUE'],
  ['json-null', null], ['array-string-true', ['true']], ['array-true', [true]], ['nested-array-true', [[true]]],
];

describe('mirror_read_only flag values', () => {
  parityTest('only a JSON true or the string "true" makes a source a read-only mirror; arrays and other values do not', {
    methods: ['readSourceState'], timeout: 60_000,
  }, async (engine, backend) => {
    for (const [id, value] of VALUES) await createSource(engine, backend, `flag-${id}`, { mirror_read_only: value });
    await createSource(engine, backend, 'flag-absent');
    const answers: Record<string, boolean> = {};
    for (const [id] of VALUES) answers[id] = await sourceMirrorReadOnly(engine as never, `flag-${id}`);
    answers.absent = await sourceMirrorReadOnly(engine as never, 'flag-absent');
    expect(answers).toEqual({
      'json-true': true, 'string-true': true, 'json-false': false, 'string-false': false, 'string-upper': false,
      'json-null': false, 'array-string-true': false, 'array-true': false, 'nested-array-true': false, absent: false,
    });
    return answers;
  });
});
