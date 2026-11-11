import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../persistence-derived-effect-publication-race.test.ts'));
