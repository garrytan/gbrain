import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../search-facts-block-visible-8411.test.ts'));
