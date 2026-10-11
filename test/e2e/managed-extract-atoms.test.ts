import { afterAll, beforeAll, describe, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withSourceRowDiagnostics } from '../helpers/source-row-diagnostics.ts';
import { atomContractCases, exerciseManagedAtoms, atomBatchCases, exerciseManagedAtomBatch, atomAuthorityCases, exerciseManagedAtomAuthority, exerciseManagedAtomReconciliation, atomRetirementCases, exerciseManagedAtomRetirement } from '../helpers/managed-atoms-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('managed atom PostgreSQL caller parity', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  }, 120_000);
  afterAll(async () => { await fixture?.close(); resetGateway(); });
  for (const scenario of atomContractCases) test(scenario, () => withSourceRowDiagnostics(fixture.engine, `atoms-${scenario.replaceAll('_', '-')}`, () => exerciseManagedAtoms(fixture.engine, scenario)), 60_000);
  for (const scenario of atomBatchCases) test(`batch ${scenario}`, () => withSourceRowDiagnostics(fixture.engine, `atoms-${scenario.replaceAll('_', '-')}`, () => exerciseManagedAtomBatch(fixture.engine, scenario)), 60_000);
  for (const scenario of atomAuthorityCases) test(`authority ${scenario} rejects normal and dry runs before providers`, () => exerciseManagedAtomAuthority(fixture.engine, scenario), 60_000);
  test('reconciles stale atom pages and files', () => withSourceRowDiagnostics(fixture.engine, 'managed-atom-reconcile', () => exerciseManagedAtomReconciliation(fixture.engine)), 60_000);
  for (const scenario of atomRetirementCases) test(`retirement ${scenario}`, () => withSourceRowDiagnostics(fixture.engine, `atom-retire-${scenario.replaceAll('_', '-')}`, () => exerciseManagedAtomRetirement(fixture.engine, scenario)), 60_000);
});
