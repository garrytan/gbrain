/**
 * Postgres arms of the wanted-pages scenarios (test/wanted-links.test.ts runs
 * the same bodies on PGLite).
 */
import { describe, test } from 'bun:test';
import { bareNameReferenceSettles, disabledClearsRows, forwardReferenceHeals, onlyUnresolvedAuthoredReferences,
  privateOriginsStayPrivate, restoredTargetHeals } from '../helpers/wanted-links-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres wanted pages', () => {
  test('a forward reference heals once its target exists', () => forwardReferenceHeals(url), 180_000);
  test('only unresolved authored references are wanted', () => onlyUnresolvedAuthoredReferences(url), 180_000);
  test('a bare-name reference settles', () => bareNameReferenceSettles(url), 180_000);
  test('private origins stay private', () => privateOriginsStayPrivate(url), 180_000);
  test('restoring a deleted target heals', () => restoredTargetHeals(url), 180_000);
  test('disabling clears rows', () => disabledClearsRows(url), 180_000);
});
