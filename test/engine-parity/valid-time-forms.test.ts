/**
 * BrainEngine parity — the written forms of `valid_from` that `get_page` with `as_of` reads as a date.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an edition whose `valid_from` is one of the forms `validDate` accepts (src/core/valid-time.ts DAY_FORM
 *    and STAMP_FORM, PR 9908 af0ec1146e) is dated on that calendar day, so `get_page` with `as_of` after it picks that
 *    edition; any other form leaves the edition undated, and the read picks the earlier dated edition. PGLite and Postgres read the form in SQL
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
 * Each form writes 2026-02-01 (or an instant at midnight UTC on that day). `dated` says whether the read takes it as a
 * date: PR 9908 (af0ec1146e) reads a `YYYY-MM-DD` day as written, and a YAML timestamp (`STAMP_FORM`) by its instant,
 * which must be midnight UTC. The rest are refusals: an instant that is not midnight UTC, or a spelling outside the
 * form. An instant that rolls into year 10000 (`9999-12-31T24:00:00Z`, `9999-12-31T23:00:00-01:00`) is no date:
 * `validDate` and `validDateSql` both take years 1000 to 9999 only (PR 9908, 102ea0030f), and Rust mirrors them.
 */
const FORMS: Array<{ label: string; value: string; dated: boolean }> = [
  { label: 'date', value: '2026-02-01', dated: true },
  { label: 'T Z', value: '2026-02-01T00:00:00Z', dated: true },
  { label: 'T .000Z', value: '2026-02-01T00:00:00.000Z', dated: true },
  { label: 'T +00:00', value: '2026-02-01T00:00:00+00:00', dated: true },
  { label: 'T .0+00:00', value: '2026-02-01T00:00:00.0+00:00', dated: true },
  { label: 'T no zone', value: '2026-02-01T00:00:00', dated: true },
  { label: 't Z', value: '2026-02-01t00:00:00Z', dated: true },
  { label: 't no zone', value: '2026-02-01t00:00:00', dated: true },
  { label: 'space no zone', value: '2026-02-01 00:00:00', dated: true },
  { label: 'space Z', value: '2026-02-01 00:00:00Z', dated: true },
  { label: 'space .000+00:00', value: '2026-02-01 00:00:00.000+00:00', dated: true },
  { label: '+00', value: '2026-02-01T00:00:00+00', dated: true },
  { label: 'space before offset', value: '2026-02-01 00:00:00 +00:00', dated: true },
  { label: '-00:00', value: '2026-02-01T00:00:00-00:00', dated: true },
  { label: '02:00+02:00', value: '2026-02-01T02:00:00+02:00', dated: true },
  { label: 'one-digit month and day', value: '2026-2-1T00:00:00Z', dated: true },
  { label: 'tab separator', value: '2026-02-01\t00:00:00', dated: true },
  { label: 'two spaces', value: '2026-02-01  00:00:00', dated: true },
  { label: 'spaces and a tab', value: '2026-02-01 \t 00:00:00', dated: true },
  { label: 'one-digit hour', value: '2026-02-01T0:00:00Z', dated: true },
  { label: 'day before, -02:00', value: '2026-01-31T22:00:00-02:00', dated: true },
  { label: '24:00 of the day before', value: '2026-01-31T24:00:00Z', dated: true },
  { label: 'minute 60, +01:00', value: '2026-02-01T00:60:00+01:00', dated: true },
  { label: 'one-digit offset hour', value: '2026-02-01T02:00:00+2', dated: true },
  { label: 't, space, -00', value: '2026-02-01t00:00:00 -00', dated: true },
  { label: 'space before Z', value: '2026-02-01T00:00:00 Z', dated: true },
  { label: 'tab before offset', value: '2026-02-01T00:00:00\t+00:00', dated: true },
  { label: 'dot, Z', value: '2026-02-01T00:00:00.Z', dated: true },
  { label: 'trailing dot', value: '2026-02-01T00:00:00.', dated: true },
  { label: 'fourth fraction digit', value: '2026-02-01T00:00:00.0009Z', dated: true },
  { label: 'six zero fraction digits', value: '2026-02-01T00:00:00.000000Z', dated: true },
  { label: '01:30+01:30', value: '2026-02-01T01:30:00+01:30', dated: true },
  { label: 'day before, -01:00', value: '2026-01-31T23:00:00-01:00', dated: true },
  { label: 'T01:00:00Z', value: '2026-02-01T01:00:00Z', dated: false },
  { label: 'T00:00:00+01:00', value: '2026-02-01T00:00:00+01:00', dated: false },
  { label: 'offset, not UTC midnight', value: '2026-02-02T00:00:00+02:00', dated: false },
  { label: 'noon T Z', value: '2026-02-01T12:00:00Z', dated: false },
  { label: 'one second past', value: '2026-02-01T00:00:01Z', dated: false },
  { label: 'minute 60, Z', value: '2026-02-01T00:60:00Z', dated: false },
  { label: 'month 13', value: '2026-13-01', dated: false },
  { label: 'month only', value: '2026-02', dated: false },
  { label: 'not a date', value: 'nope', dated: false },
  { label: 'noon space', value: '2026-02-01 12:00:00', dated: false },
  { label: 'half a second', value: '2026-02-01T00:00:00.5Z', dated: false },
  { label: 'lower-case z', value: '2026-02-01T00:00:00z', dated: false },
  { label: '+0100', value: '2026-02-01T00:00:00+0100', dated: false },
  { label: 'offset with no minutes', value: '2026-02-01T00:00:00+00:', dated: false },
  { label: 'not a calendar day', value: '2026-02-30T00:00:00Z', dated: false },
  { label: 'trailing newline', value: '2026-02-01 00:00:00\n', dated: false },
  { label: 'trailing space', value: '2026-02-01T00:00:00Z ', dated: false },
  { label: 'leading space', value: ' 2026-02-01', dated: false },
  { label: 'x separator', value: '2026-02-01x00:00:00', dated: false },
  { label: 'T and no time', value: '2026-02-01T', dated: false },
  { label: 'five-digit year', value: '20260-02-01T00:00:00Z', dated: false },
  { label: 'rolls into year 10000', value: '9999-12-31T24:00:00Z', dated: false },
  { label: 'offset rolls into year 10000', value: '9999-12-31T23:00:00-01:00', dated: false },
];

/** A dated edition picked in March: the form's edition when its date reads, else the January edition before it. */
const expected = (form: { dated: boolean }) => form.dated
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
    expect(out).toEqual(Object.fromEntries(FORMS.map((f) => [f.label, expected(f)])));
    return out;
  });
});
