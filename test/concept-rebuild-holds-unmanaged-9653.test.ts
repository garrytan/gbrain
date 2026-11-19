import { registerConceptHoldTests } from './helpers/concept-rebuild-holds-9653.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) registerConceptHoldTests(true, backend, backend === 'postgres' ? requirePostgresTestDatabase() : undefined);
