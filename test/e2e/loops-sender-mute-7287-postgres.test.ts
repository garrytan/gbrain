import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../loops-sender-mute-7287.test.ts'));
