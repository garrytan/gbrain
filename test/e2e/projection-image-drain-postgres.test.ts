import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../projection-image-drain.test.ts'));
