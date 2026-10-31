/**
 * Wave B PR 4 lane 4a (spec 11), Postgres arm: a fact purge leaves no page_segment_derivations row holding the claim;
 * this file runs retired rows, racing derivations, demotion, scope matching and the typed timeout of the sweep's
 * recording. Cases in test/helpers/derivation-purge-cases.ts; PGLite arm:
 * test/large-pages/derivation-purge-retired.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationPurgeRetiredCases } from '../helpers/derivation-purge-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationPurgeRetiredCases('postgres');
else describe.skip('purge leaves no derivation row holding the claim (postgres): retired', () => { test('needs DATABASE_URL', () => {}); });
