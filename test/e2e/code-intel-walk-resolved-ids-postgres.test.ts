import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../code-intel/recursive-walk-resolved-ids-5439.test.ts'));
