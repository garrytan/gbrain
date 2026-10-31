/**
 * Wave B PR 4 lane 4a (spec 11), Postgres arm: a fact purge leaves no page_segment_derivations row holding the claim;
 * this file runs rows entering the sweep's scope while it walks, open writers, and the scope lock (scope_lock_busy).
 * Cases in test/helpers/derivation-purge-cases.ts; PGLite arm: test/large-pages/derivation-purge-scope.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationPurgeScopeCases } from '../helpers/derivation-purge-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationPurgeScopeCases('postgres');
else describe.skip('purge leaves no derivation row holding the claim (postgres): scope', () => { test('needs DATABASE_URL', () => {}); });
