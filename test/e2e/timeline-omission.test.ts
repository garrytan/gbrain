import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../timeline-omission.test.ts'));
