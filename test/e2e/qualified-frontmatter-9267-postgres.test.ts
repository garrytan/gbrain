import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../qualified-frontmatter-9267.test.ts'));
