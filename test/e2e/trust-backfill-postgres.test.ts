import { registerPostgresTests } from '../helpers/test-backends.ts';

// `gbrain trust backfill` and doctor `trust_tiers` (#5575) on Postgres: the
// read-only dry run, the coordinated apply on a managed brain and the JSONB origin.
await registerPostgresTests(() => import('../trust-backfill.test.ts'));
