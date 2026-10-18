/**
 * Wave 16 G3.5 ([R13], #6513 comments, media-corpus): a database refusal's public
 * `reason` is a CLOSED enum mapped from known raiser / SQLSTATE combinations.
 * `PUBLIC_DETAIL_KEYS` is a key allow-list, not a value sanitizer, and an
 * operator trigger can interpolate a row value at the message prefix, so no
 * message-derived identifier ever reaches a public projection.
 *
 *  - `gbrain_stamp_write_attribution` "not classified for table" → `attribution_unclassified_table`;
 *    `gbrain_stamp_trust_tier` "not classified for table" → `trust_unclassified_table`;
 *    the real graduation fence (SQLSTATE 55000 from `gbrain_graduation_fence`, which
 *    `databaseRefusal` ignored before) → `graduation_in_progress`, classified retry / no human;
 *    anything else → `unknown`, and a synthetic P0001 carrying the fence's text stays `unknown`.
 *  - nothing of the message is kept, owner-side included (#5974's pinned rule); `publicFailureDetail`
 *    drops any `reason` outside the enum, however it was stored.
 *  - the purged / guard / trust-raise prefixes keep their codes and gain no reason.
 */
import { expect, test } from 'bun:test';
import { PUBLICATION_REASONS, databaseRefusal, publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';

const PRIVATE = 'private_person_example_42';
const pg = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? '')), fields);
const raise = (raiser: string, message: string, extra: Record<string, unknown> = {}) =>
  pg({ code: 'P0001', message, where: `PL/pgSQL function ${raiser}() line 7 at RAISE`, table_name: 'pages', severity: 'ERROR', ...extra });
const leak = (value: unknown) => JSON.stringify(value).includes(PRIVATE);

test('the reason enum is closed and covers the three known raisers; everything else is unknown', () => {
  expect([...PUBLICATION_REASONS].sort()).toEqual(['attribution_unclassified_table', 'graduation_in_progress', 'schema_missing', 'trust_unclassified_table', 'unknown']);
  const attribution = databaseRefusal(raise('gbrain_stamp_write_attribution', 'gbrain_stamp_write_attribution is not classified for table pages'))!;
  expect(attribution).toMatchObject({ code: 'storage_error', detail: { origin: 'database_trigger', sqlstate: 'P0001', raiser: 'gbrain_stamp_write_attribution', table: 'pages', reason: 'attribution_unclassified_table' } });
  expect(attribution.message).toBe('Publication failed (P0001 in gbrain_stamp_write_attribution: attribution_unclassified_table). Inspect owner diagnostics.');
  const trust = databaseRefusal(raise('gbrain_stamp_trust_tier', 'gbrain_stamp_trust_tier is not classified for table facts', { table_name: 'facts' }))!;
  expect(trust).toMatchObject({ code: 'storage_error', detail: { raiser: 'gbrain_stamp_trust_tier', table: 'facts', reason: 'trust_unclassified_table' } });
  // A known raiser with another message is not that reason.
  expect(databaseRefusal(raise('gbrain_stamp_write_attribution', `${PRIVATE}: refused`))!.detail).toMatchObject({ raiser: 'gbrain_stamp_write_attribution', reason: 'unknown' });
  // The same message text under a raiser the map does not know is unknown too.
  expect(databaseRefusal(raise('operator_hook', 'gbrain_stamp_write_attribution is not classified for table pages'))!.detail).toMatchObject({ raiser: 'operator_hook', reason: 'unknown' });
});

test('an unknown operator trigger: reason unknown, and no part of its message is kept anywhere', () => {
  for (const message of [`${PRIVATE}: refused`, `"${PRIVATE}": refused`, `${PRIVATE}\nline two\r\n\x1b[31mred`, `${PRIVATE}_${'x'.repeat(500)}`]) {
    const failure = databaseRefusal(raise('operator_hook', message))!;
    expect(failure.code).toBe('storage_error');
    expect(failure.message).toBe('Publication failed (P0001 in operator_hook: unknown). Inspect owner diagnostics.');
    expect(failure.detail).toMatchObject({ origin: 'database_trigger', sqlstate: 'P0001', raiser: 'operator_hook', table: 'pages', reason: 'unknown' });
    // #5974's rule stands: the stored (owner-only) detail keeps fixed identifiers only, so the prefix is kept nowhere.
    expect(leak(failure)).toBe(false);
    expect(failure.detail).toEqual({ origin: 'database_trigger', sqlstate: 'P0001', raiser: 'operator_hook', table: 'pages', reason: 'unknown' });
    expect(publicFailureDetail(failure.detail)).toEqual({ origin: 'database_trigger', sqlstate: 'P0001', raiser: 'operator_hook', table: 'pages', reason: 'unknown' });
  }
  // No raiser at all (a bare RAISE outside plpgsql): origin database, reason unknown, no prefix leak.
  const bare = databaseRefusal(pg({ code: 'P0001', message: `${PRIVATE}: refused` }))!;
  expect(bare.message).toBe('Publication failed (P0001: unknown). Inspect owner diagnostics.');
  expect(publicFailureDetail(bare.detail)).toEqual({ origin: 'database', sqlstate: 'P0001', reason: 'unknown' });
});

test('the real graduation fence (55000) is recognised as graduation_in_progress and classified retry; a P0001 with its text is not', () => {
  const real = databaseRefusal(pg({ code: '55000', message: 'graduation_in_progress: this database is fenced by gbrain engine graduation run 0b6f0c3a-1111-4222-8333-944455556666; writes are refused until the run grants it authority',
    hint: 'Run: gbrain migrate --status --json', where: 'PL/pgSQL function gbrain_graduation_fence() line 5 at RAISE', table_name: 'pages' }))!;
  expect(real).toMatchObject({ code: 'storage_error', detail: { origin: 'database_trigger', sqlstate: '55000', raiser: 'gbrain_graduation_fence', table: 'pages', reason: 'graduation_in_progress' } });
  expect(real.message).toContain('graduation_in_progress');
  expect(real.message).not.toContain('0b6f0c3a');
  expect(publicFailureDetail(real.detail)).toEqual({ origin: 'database_trigger', sqlstate: '55000', raiser: 'gbrain_graduation_fence', table: 'pages', reason: 'graduation_in_progress' });
  expect(classifySyncFault({ code: 'storage_error', detail: 'graduation_in_progress' })).toMatchObject({ safe_actions: ['retry'], needs_human: false });
  // The same text as a P0001 from another raiser, or a 55000 from another raiser, is unknown.
  expect(databaseRefusal(raise('operator_hook', 'graduation_in_progress: this database is fenced by gbrain engine graduation run x'))!.detail).toMatchObject({ sqlstate: 'P0001', reason: 'unknown' });
  expect(databaseRefusal(pg({ code: '55000', message: 'graduation_in_progress: spoofed', where: 'PL/pgSQL function operator_hook() line 1 at RAISE' }))!.detail).toMatchObject({ sqlstate: '55000', raiser: 'operator_hook', reason: 'unknown' });
  // Any other SQLSTATE is still not a database refusal this module names.
  expect(databaseRefusal(pg({ code: '55P03', message: 'lock timeout' }))).toBeNull();
  expect(databaseRefusal(pg({ code: '23505', message: 'duplicate key' }))).toBeNull();
});

test('publicFailureDetail never adds keys and never passes a reason outside the enum, whatever was stored', () => {
  const stored = { origin: 'database_trigger', sqlstate: 'P0001', raiser: 'operator_hook', table: 'pages', reason: PRIVATE, message_prefix: `${PRIVATE}: refused`, sources: { target: 'private-source' }, attempt: { consumer_version: '1', consumer_host_id: 'h' }, extra: PRIVATE };
  expect(publicFailureDetail(stored)).toEqual({ origin: 'database_trigger', sqlstate: 'P0001', raiser: 'operator_hook', table: 'pages' });
  expect(publicFailureDetail({ origin: 'database', sqlstate: 'P0001', reason: 'unknown' })).toEqual({ origin: 'database', sqlstate: 'P0001', reason: 'unknown' });
  expect(publicFailureDetail({ origin: 'database', sqlstate: 'P0001', reason: 42 })).toEqual({ origin: 'database', sqlstate: 'P0001' });
  expect(publicFailureDetail({ origin: 'owner_exception', error_class: 'TypeError', frame: 'src/x.ts:1' })).toEqual({ origin: 'owner_exception' });
});

test('the typed prefixes keep their codes and gain no reason', () => {
  expect(databaseRefusal(raise('gbrain_purge_guard', 'purged_content: the page holds purged content'))).toMatchObject({ code: 'purged_content' });
  expect(databaseRefusal(raise('gbrain_purge_guard', 'purged_content: x'))!.detail).not.toHaveProperty('reason');
  expect(databaseRefusal(raise('gbrain_require_managed_writer', 'writer_coordinator_required: outside', { constraint_name: 'managed_writer_guard:source_scope' }))).toMatchObject({ code: 'writer_coordinator_required', detail: { branch: 'source_scope' } });
  expect(databaseRefusal(raise('gbrain_stamp_trust_tier', 'trust_raise_refused: needs confirmation'))).toMatchObject({ code: 'trust_raise_refused' });
  expect(databaseRefusal(raise('gbrain_stamp_trust_tier', 'trust_raise_refused: needs confirmation'))!.detail).not.toHaveProperty('reason');
});
