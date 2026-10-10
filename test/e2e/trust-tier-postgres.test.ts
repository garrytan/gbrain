import { registerPostgresTests } from '../helpers/test-backends.ts';

// Memory trust tiers (#5575) on Postgres: the tier trigger, the attribution-seam
// settings and the write_origin JSONB binding, direct and through transaction-mode
// PgBouncer (scripts/e2e-backend-matrix.txt).
await registerPostgresTests(() => import('../trust-tier-schema.test.ts'));
