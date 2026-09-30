import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../timeline-materialize.test.ts'));
