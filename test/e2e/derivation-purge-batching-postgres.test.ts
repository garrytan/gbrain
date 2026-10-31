/**
 * Wave B PR 4 lane 4a (spec 11), Postgres arm: a fact purge leaves no page_segment_derivations row holding the claim;
 * this file runs sweep batches, cursors, writes behind and beside the sweep, deadlines and batch halving. Cases in
 * test/helpers/derivation-purge-cases.ts; PGLite arm: test/large-pages/derivation-purge-batching.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationPurgeBatchingCases } from '../helpers/derivation-purge-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationPurgeBatchingCases('postgres');
else describe.skip('purge leaves no derivation row holding the claim (postgres): batching', () => { test('needs DATABASE_URL', () => {}); });
