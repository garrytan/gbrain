/**
 * GST-2314 review round: the stale-plan error (SQLSTATE 0A000, "cached plan must not change result type") is
 * recognised by the untranslated C routine as well as the English message, so a server with non-English
 * lc_messages still retries it, and an uncharged stale plan (persistence.preparation_deadlines false) is released
 * as database contention instead of failing the accepted write.
 */
import { expect, test } from 'bun:test';
import { transientDatabaseFailure } from '../src/core/persistence/coordinator.ts';
import { isStalePlanError } from '../src/core/retry-matcher.ts';

const pgError = (fields: { code: string; message: string; routine?: string }) =>
  Object.assign(new Error(fields.message), { code: fields.code, ...(fields.routine ? { routine: fields.routine } : {}) });

test('a stale plan is recognised by its routine when the server translates the message', () => {
  expect(isStalePlanError(pgError({ code: '0A000', message: 'der gecachte Plan darf den Ergebnistyp nicht ändern', routine: 'RevalidateCachedQuery' }))).toBe(true);
  expect(isStalePlanError(pgError({ code: '0A000', message: 'cached plan must not change result type' }))).toBe(true);
});

test('every other 0A000 stays a refusal', () => {
  expect(isStalePlanError(pgError({ code: '0A000', message: 'cannot use RETURNING with a view', routine: 'transformReturningList' }))).toBe(false);
  expect(isStalePlanError(pgError({ code: 'XX000', message: 'internal', routine: 'RevalidateCachedQuery' }))).toBe(false);
});

test('an uncharged stale plan is transient database contention', () => {
  expect(transientDatabaseFailure(pgError({ code: '0A000', message: 'cached plan must not change result type', routine: 'RevalidateCachedQuery' }))).toBe(true);
  expect(transientDatabaseFailure(pgError({ code: '0A000', message: 'cannot use RETURNING with a view', routine: 'transformReturningList' }))).toBe(false);
});
