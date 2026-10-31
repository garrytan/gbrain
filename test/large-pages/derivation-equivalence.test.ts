/**
 * Wave B PR 4 lane 4a (spec 8.1, 8.2): the incremental links, mentions, timeline and fence derivations of a segmented
 * page equal a full recompute after every step of a seeded sequence of appends and edits (PGLite arm; the PostgreSQL
 * arm is test/e2e/derivation-equivalence-postgres.test.ts). Cases in test/helpers/derivation-equivalence-cases.ts.
 */
import { registerDerivationEquivalenceCases } from '../helpers/derivation-equivalence-cases.ts';

registerDerivationEquivalenceCases('pglite');
