/**
 * Opt-in `bun --preload` for a CLI subprocess (never listed in bunfig.toml): when GBRAIN_TEST_FAIL_SQL is set, every PGlite
 * query whose text matches that regex throws a permission error, so a test can fail one read of a real `gbrain` run.
 * Used by test/enforced-member.serial.test.ts (the entity lookup read failing under GBRAIN_ENFORCED_MEMBER).
 */
import { PGlite } from '@electric-sql/pglite';

const pattern = process.env.GBRAIN_TEST_FAIL_SQL;
if (pattern) {
  const re = new RegExp(pattern, 's');
  const original = PGlite.prototype.query;
  (PGlite.prototype as { query: unknown }).query = function (this: PGlite, sql: unknown, ...rest: unknown[]) {
    if (typeof sql === 'string' && re.test(sql)) {
      return Promise.reject(Object.assign(new Error('permission denied for table injected_entity_lookup'), { code: '42501' }));
    }
    return (original as (...a: unknown[]) => unknown).call(this, sql, ...rest);
  };
}
