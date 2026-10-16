import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../code-intel/ruby-call-edges-resolution.test.ts'));
