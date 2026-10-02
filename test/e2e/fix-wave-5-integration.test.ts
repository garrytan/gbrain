import { registerPostgresTests } from '../helpers/test-backends.ts';

// Fix wave 5 cross-lane journeys (ENG-O14): the PostgreSQL arm of test/fix-wave-5-integration.test.ts.
await registerPostgresTests(() => import('../fix-wave-5-integration.test.ts'));
