import { registerPostgresTests } from '../helpers/test-backends.ts';

// #7085: the PostgreSQL arm of the managed import refusing once with sync.write_through off.
await registerPostgresTests(() => import('../import-write-through-off-7085.test.ts'));
