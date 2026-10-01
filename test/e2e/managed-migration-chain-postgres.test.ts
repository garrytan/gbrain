/**
 * The whole orchestrator chain on a managed Postgres brain; the PGLite run
 * is test/managed-migration-chain.slow.test.ts. See
 * test/helpers/managed-migration-chain-contract.ts for what it protects.
 */
import { expect, test } from 'bun:test';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { runExhaustedCapacityChain, runManagedMigrationChain } from '../helpers/managed-migration-chain-contract.ts';

test('postgres: the managed migration chain completes from v0.11.0 and a rerun is idempotent', async () => {
  await runManagedMigrationChain(requirePostgresTestDatabase(), expect);
}, 900_000);

test('postgres: exhausted request IDs refuse the first backfill up front, and raising the limit completes the chain', async () => {
  await runExhaustedCapacityChain(requirePostgresTestDatabase(), expect);
}, 900_000);
