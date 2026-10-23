import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-atoms-raised-cap-drain.serial.test.ts'));
