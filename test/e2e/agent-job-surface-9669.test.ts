import { registerPostgresTests } from '../helpers/test-backends.ts';

// #9669: the PostgreSQL arm of agent jobs keeping their submitter's tool surface.
await registerPostgresTests(() => import('../agent-job-surface-9669.test.ts'));
