/**
 * Wave B PR 4 lane 4a (spec 11), Postgres arm: a fact purge leaves no page_segment_derivations row holding the claim;
 * this file runs a retired row stating the claim in a normalized form (Greek final sigma, Turkish dotted I, case and
 * spacing). Cases in test/helpers/derivation-purge-cases.ts; PGLite arm:
 * test/large-pages/derivation-purge-normalized.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationPurgeNormalizedCases } from '../helpers/derivation-purge-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationPurgeNormalizedCases('postgres');
else describe.skip('purge leaves no derivation row holding the claim (postgres): normalized', () => { test('needs DATABASE_URL', () => {}); });
