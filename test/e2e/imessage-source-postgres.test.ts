import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../imessage-source.test.ts'), () => import('../imessage-owner-only.test.ts'), () => import('../owner-only-removal-lineage.test.ts'));
