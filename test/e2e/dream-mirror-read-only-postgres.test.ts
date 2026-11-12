/** #8935: exercise dream file publication and retirement against real PostgreSQL. */
import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../cycle/dream-reverse-write-commit.test.ts'));
