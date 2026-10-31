import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../protocol-guard-refusal-7777.test.ts'));
