import { registerPostgresTests } from '../helpers/test-backends.ts';

// GST-2898 D3-B: the read-shared recall merge on Postgres (direct and through PgBouncer in the E2E backend matrix).
await registerPostgresTests(() => import('../recall-read-shared-merge.test.ts'));
