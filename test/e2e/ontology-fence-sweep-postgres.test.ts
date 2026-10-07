import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../ontology-fence-sweep.test.ts'));
