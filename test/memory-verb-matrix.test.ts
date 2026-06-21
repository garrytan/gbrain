import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import {
  MEMORY_VERB_MATRIX,
  validateMemoryVerbMatrix,
} from '../src/core/services/operation-conformance-service.ts';

describe('memory verb matrix', () => {
  test('maps memory verbs only to existing operations', () => {
    const failures = validateMemoryVerbMatrix(operationsByName);

    expect(failures).toEqual([]);
    expect(MEMORY_VERB_MATRIX.discover_search).toEqual(expect.arrayContaining([
      'search',
      'query',
      'retrieve_context',
    ]));
    expect(MEMORY_VERB_MATRIX.route_writeback).toEqual(['route_memory_writeback']);
  });
});
