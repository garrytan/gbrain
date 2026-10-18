import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../remote-fact-list-private-provenance.test.ts'));
