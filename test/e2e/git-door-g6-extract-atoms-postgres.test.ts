import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../git-door-g6-extract-atoms.test.ts'));
