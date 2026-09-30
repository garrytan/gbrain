import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-contextual-mode-5621.serial.test.ts'));
