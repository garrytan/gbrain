import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../transcripts-archive-audience-lock-race.test.ts'));
