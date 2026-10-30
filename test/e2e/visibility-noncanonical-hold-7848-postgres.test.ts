import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../visibility-noncanonical-hold-7848.test.ts'));
