import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fence eligibility overlay for chunks (#5575 ENG-1) on Postgres: the one-query
// overlay read (facts tiers, fact_purges, write-gate holds), keyword hits on the
// overlaid chunks, and the fence-append page tier keeper under the tier trigger.
await registerPostgresTests(() => import('../fence-chunk-overlay.test.ts'));
