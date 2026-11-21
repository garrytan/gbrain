import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../google-gmail-migrated-window-9129.test.ts'));
