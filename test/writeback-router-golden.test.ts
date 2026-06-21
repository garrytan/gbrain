import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import {
  MEMORY_AUTHORITY_GATES,
  validateMemoryAuthorityGates,
} from '../src/core/services/operation-conformance-service.ts';

describe('writeback governance golden gates', () => {
  test('pins direct and agent-mediated writeback authority gates to live operation schemas', () => {
    const failures = validateMemoryAuthorityGates(operationsByName);

    expect(failures).toEqual([]);
    expect(MEMORY_AUTHORITY_GATES.put_page).toMatchObject({
      authority_gate: 'direct_page_write_with_source_attribution_and_expected_hash',
      snapshot_param: 'expected_content_hash',
      source_param: 'source_refs',
      ledger_operation: 'put_page',
    });
    expect(MEMORY_AUTHORITY_GATES.route_memory_writeback).toMatchObject({
      authority_gate: 'router_decision_before_agent_mediated_page_writeback',
      snapshot_param: 'target_snapshot_hash',
      source_param: 'source_refs',
    });
  });
});
