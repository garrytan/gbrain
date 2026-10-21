import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../embedding-provenance-dimensions-7182.test.ts'));
