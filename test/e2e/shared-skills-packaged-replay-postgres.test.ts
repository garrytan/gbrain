import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../shared-skills-packaged-replay.serial.test.ts'));
