import { describe, expect, test } from 'bun:test';
import {
  fingerprint,
  resumeFilter,
  type OpCheckpointKey,
} from 'gbrain/operation-checkpoints';

describe('gbrain/operation-checkpoints public contract', () => {
  test('exports only the generic downstream checkpoint primitives', async () => {
    const checkpoints = await import('gbrain/operation-checkpoints');
    expect(Object.keys(checkpoints).sort()).toEqual([
      'appendCompleted',
      'clearOpCheckpoint',
      'fingerprint',
      'loadOpCheckpoint',
      'recordCompleted',
      'resumeFilter',
    ]);
  });

  test('consumer import provides stable fingerprints and pure resume filtering', () => {
    const params = {
      source_id: 'source-a',
      snapshot: 'tree-abc123',
      contract_version: 1,
    };
    const key: OpCheckpointKey = {
      op: 'consumer:extract:v1',
      fingerprint: fingerprint(params),
    };

    expect(key.fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(fingerprint({ contract_version: 1, snapshot: 'tree-abc123', source_id: 'source-a' }))
      .toBe(key.fingerprint);
    expect(resumeFilter(['record-1', 'record-2', 'record-3'], ['record-2']))
      .toEqual(['record-1', 'record-3']);
  });
});
