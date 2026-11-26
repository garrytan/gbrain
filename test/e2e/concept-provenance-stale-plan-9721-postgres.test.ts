import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../concept-provenance-stale-plan-9721.test.ts'));
