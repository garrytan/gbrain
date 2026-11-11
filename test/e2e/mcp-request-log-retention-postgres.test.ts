import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../mcp-request-log-retention.test.ts'));
