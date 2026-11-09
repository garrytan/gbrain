import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../adoption-recovery-evidence-8869.serial.test.ts'));
