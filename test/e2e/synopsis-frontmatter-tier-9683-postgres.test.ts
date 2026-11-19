import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../synopsis-frontmatter-tier-9683.test.ts'));
