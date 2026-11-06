/** The identifier probe (#7491) on PostgreSQL: the dual-backend cases in test/search/identifier-probe.serial.test.ts. */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search/identifier-probe.serial.test.ts'));
