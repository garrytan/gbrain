import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../remote-fact-write-private-provenance.test.ts'));
