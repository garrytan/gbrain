import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../spend-nested-refusal-9086.test.ts'));
