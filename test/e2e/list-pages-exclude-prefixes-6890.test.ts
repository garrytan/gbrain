import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../list-pages-exclude-prefixes-6890.test.ts'));
