/**
 * BrainEngine parity — the written forms of `valid_from` that `get_page` with `as_of` reads as a date.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an edition whose `valid_from` is one of the forms `validDate` accepts (src/core/valid-time.ts DATE_FORM)
 *    is dated on that calendar day, so `get_page` with `as_of` after it picks that edition; any other form leaves the
 *    edition undated, and the read picks the earlier dated edition. PGLite and Postgres read the form in SQL
 *    (`validDateSql`); the Rust arm reads it in `trust/valid_time.rs` (`valid_date`). All three must accept the same forms.
 *  - Regression: when the TypeScript form widens and Rust does not, `get_page` with `as_of` picks another edition on a
 *    Rust brain for the same page.
 *  - Why existing coverage misses it: the other as_of cases write `valid_from` only as `YYYY-MM-DD`.
 *  - Seam: none. Real engines; the read runs through the get_page operation. Ids and recorded times differ between
 *    arms, so each answer is folded to the edition's body, status and dates.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';

const { parityTest } = parityArms(testBackends());

/**
 * Each form writes 2026-02-01 (or, for an offset, an instant on that day). `dated` says whether the read takes it as
 * a date today. The ruling-3 forms are the offset spellings a YAML parser read as a UTC instant.
 */
const FORMS: Array<{ label: string; value: string; dated: boolean }> = [
  { label: 'date', value: '2026-02-01', dated: true },
  { label: 'T Z', value: '2026-02-01T00:00:00Z', dated: true },
  { label: 'T .000Z', value: '2026-02-01T00:00:00.000Z', dated: true },
  { label: 'T +00:00', value: '2026-02-01T00:00:00+00:00', dated: true },
  { label: 'T .0+00:00', value: '2026-02-01T00:00:00.0+00:00', dated: true },
  { label: 'T no zone', value: '2026-02-01T00:00:00', dated: false },
  { label: 't Z', value: '2026-02-01t00:00:00Z', dated: false },
  { label: 't no zone', value: '2026-02-01t00:00:00', dated: false },
  { label: 'space no zone', value: '2026-02-01 00:00:00', dated: false },
  { label: 'space Z', value: '2026-02-01 00:00:00Z', dated: false },
  { label: 'space .000+00:00', value: '2026-02-01 00:00:00.000+00:00', dated: false },
  { label: 'ruling 3: +00', value: '2026-02-01T00:00:00+00', dated: false },
  { label: 'ruling 3: space before offset', value: '2026-02-01 00:00:00 +00:00', dated: false },
  { label: 'ruling 3: -00:00', value: '2026-02-01T00:00:00-00:00', dated: false },
  { label: 'ruling 3: 02:00+02:00', value: '2026-02-01T02:00:00+02:00', dated: false },
  { label: 'offset, not UTC midnight', value: '2026-02-02T00:00:00+02:00', dated: false },
  { label: 'noon T Z', value: '2026-02-01T12:00:00Z', dated: false },
  { label: 'noon space', value: '2026-02-01 12:00:00', dated: false },
];

/** A dated edition picked in March: the form's edition when its date reads, else the January edition before it. */
const expected = (dated: boolean) => dated
  ? { body: 'february edition', status: 'in_force', valid_from: '2026-02-01', why: null }
  : { body: 'january edition', status: 'in_force', valid_from: '2026-01-01', why: null };

describe('engine parity: valid_from forms under get_page as_of', () => {
  parityTest('get_page as_of dates an edition by each written valid_from form', {
    methods: ['putPage', 'createVersion', 'listValidTimeIdentities', 'pickValidTimeEdition', 'readPageVersionEdition', 'beginSnapshotRead', 'pageAwaitsRederive'],
  }, async (engine: BrainEngine) => {
    const op = operations.find((o) => o.name === 'get_page')!;
    const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const out: Record<string, unknown> = {};
    for (const [i, form] of FORMS.entries()) {
      const slug = `vt/form-${String(i).padStart(2, '0')}`;
      await engine.putPage(slug, { type: 'note', title: 'F', compiled_truth: 'january edition', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
      await engine.createVersion(slug, { sourceId: 'default' });
      await engine.putPage(slug, { type: 'note', title: 'F', compiled_truth: 'february edition', timeline: '', frontmatter: { valid_from: form.value } });
      const r = await op.handler(ctx, { slug, as_of: '2026-03-01' }) as Record<string, unknown>;
      const vt = r.valid_time as Record<string, unknown>;
      out[form.label] = { body: String(r.compiled_truth).trim(), status: vt.status, valid_from: vt.valid_from, why: vt.why };
    }
    expect(out).toEqual(Object.fromEntries(FORMS.map((f) => [f.label, expected(f.dated)])));
    return out;
  });
});
