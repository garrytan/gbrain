import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import {
  REQUIRED_MUTATION_ALIASES,
  validateMutationNameAlignment,
} from '../src/core/services/operation-conformance-service.ts';

describe('memory mutation name alignment', () => {
  test('keeps public mutation operations aligned with mutation ledger enum names', () => {
    const failures = validateMutationNameAlignment(operationsByName);

    expect(failures).toEqual([]);
    expect(REQUIRED_MUTATION_ALIASES.create_memory_redaction_plan).toEqual(['create_redaction_plan']);
    expect(REQUIRED_MUTATION_ALIASES.apply_memory_redaction_plan).toEqual(['execute_redaction_plan']);
  });
});
