/** Real PostgreSQL mirror SQL, source identities, recovery cursors and keyless cloud retrieval. */
import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../hydradb-cloud-recovery.serial.test.ts'));
