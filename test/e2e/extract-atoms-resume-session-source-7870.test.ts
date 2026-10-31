import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-atoms-resume-session-source-7870.test.ts'));
