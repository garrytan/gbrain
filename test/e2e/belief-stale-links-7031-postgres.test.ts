import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7031: the PostgreSQL arm of the mention-pass belief journaling test.
await registerPostgresTests(() => import('../belief-stale-links-7031.test.ts'));
