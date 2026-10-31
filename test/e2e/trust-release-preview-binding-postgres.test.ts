import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../trust-release-preview-binding.test.ts'));
