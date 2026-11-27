import { describe, expect, test } from 'bun:test';
import { unexplainedReadRoutes } from './helpers/read-route-allowance.ts';

describe('engine parity: raw_sql (read-route allowance)', () => {
  test('only the three named members on preparationRead are excused; any other write member that reads on a read route still fails', () => {
    const recorded: Array<[string, string]> = [
      ['restorePage', 'preparationRead'], ['invalidateStaleSignatureEmbeddings', 'preparationRead'], ['invalidateContentDriftEmbeddings', 'preparationRead'], // excused
      ['someOtherWriteMember', 'preparationRead'], // another write member on the same route
      ['restorePage', 'engineSqlRead'], ['invalidateContentDriftEmbeddings', 'ownRawRead'], // a named member on a different route
      ['someLockingWrite', 'preparationRead(unbounded)'], // a locking read stays allowed
    ];
    expect(unexplainedReadRoutes(recorded)).toEqual([
      'someOtherWriteMember -> preparationRead', 'restorePage -> engineSqlRead', 'invalidateContentDriftEmbeddings -> ownRawRead']);
  });
});
