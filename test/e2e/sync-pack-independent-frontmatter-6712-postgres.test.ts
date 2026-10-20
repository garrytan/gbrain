import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-pack-independent-frontmatter-6712.test.ts'));
