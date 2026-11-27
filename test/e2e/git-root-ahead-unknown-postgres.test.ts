import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../git-root-ahead-unknown.test.ts'));
