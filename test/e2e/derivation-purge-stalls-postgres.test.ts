/**
 * Wave B PR 4 lane 4a (spec 11), Postgres arm: a fact purge leaves no page_segment_derivations row holding the claim;
 * this file runs stalls, paid work, the early pending return, receipt probes and the doctor check. Cases in
 * test/helpers/derivation-purge-cases.ts; PGLite arm: test/large-pages/derivation-purge-stalls.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationPurgeStallsCases } from '../helpers/derivation-purge-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationPurgeStallsCases('postgres');
else describe.skip('purge leaves no derivation row holding the claim (postgres): stalls', () => { test('needs DATABASE_URL', () => {}); });
