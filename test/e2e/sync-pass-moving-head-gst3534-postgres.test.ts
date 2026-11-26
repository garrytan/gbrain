import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-pass-moving-head-gst3534.test.ts'));
