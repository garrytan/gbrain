import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fence chunk trust on read (#5575 Cat 37-1, 37-2, 38-1) on Postgres: the
// read-time fence row lookup (stored tiers, flag receipts, pending supersede
// proposals), the rewritten marker and envelope, and the chunk-time
// unconfirmed marker.
await registerPostgresTests(() => import('../fence-chunk-trust-read.test.ts'));
