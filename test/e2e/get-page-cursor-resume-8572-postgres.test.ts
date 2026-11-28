import { registerPostgresTests } from '../helpers/test-backends.ts';
await registerPostgresTests(() => import('../get-page-cursor-resume-8572.test.ts'));
