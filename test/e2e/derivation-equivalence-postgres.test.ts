/**
 * Wave B PR 4 lane 4a (spec 8.1, 8.2), Postgres arm: the incremental links, mentions, timeline and fence derivations of
 * a segmented page equal a full recompute after every step of a seeded sequence of appends and edits, and a forget
 * deletes only the derivation rows that may hold the text it rewrote. Cases in test/helpers/derivation-equivalence-cases.ts;
 * PGLite arm: test/large-pages/derivation-equivalence.test.ts.
 */
import { describe, test } from 'bun:test';
import { registerDerivationEquivalenceCases } from '../helpers/derivation-equivalence-cases.ts';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) registerDerivationEquivalenceCases('postgres');
else describe.skip('incremental derivations equal a full recompute (postgres)', () => { test('needs DATABASE_URL', () => {}); });
