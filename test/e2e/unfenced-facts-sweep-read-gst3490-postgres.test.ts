import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../unfenced-facts-sweep-read-gst3490.test.ts'));
