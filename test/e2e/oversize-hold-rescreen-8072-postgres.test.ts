import { registerPostgresTests } from '../helpers/test-backends.ts';

// #8072 on Postgres: held over-ceiling files stay unread across refresh ticks, and the refresh sync budget.
await registerPostgresTests(() => import('../oversize-hold-rescreen-8072.test.ts'));
