import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../decide/triage-decide-recheck-7307.serial.test.ts'));
