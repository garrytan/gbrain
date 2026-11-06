import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../file-drift-segmented-protected-gst1555.test.ts'));
