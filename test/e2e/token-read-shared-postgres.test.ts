import { registerPostgresTests } from '../helpers/test-backends.ts';

// GST-2898: the read-shared switch on Postgres (direct and through PgBouncer in the E2E backend matrix).
await registerPostgresTests(() => import('../token-read-shared.test.ts'));
