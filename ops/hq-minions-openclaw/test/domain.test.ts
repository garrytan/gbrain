import { describe, expect, test } from 'bun:test';
import { idempotencyKey, toJobData, WorkItemSchema } from '../src/domain.ts';

describe('domain', () => {
  test('builds work item data', () => {
    const input = WorkItemSchema.parse({
      projectId: 'hq',
      title: 'Test item'
    });
    const data = toJobData(input);
    expect(data.tracker_role).toBe('work_item');
    expect(data.project_id).toBe('hq');
    expect(data.title).toBe('Test item');
  });

  test('idempotency key is deterministic', () => {
    const input = WorkItemSchema.parse({
      projectId: 'hq',
      workstreamId: 'ops',
      title: 'Same'
    });
    expect(idempotencyKey(input)).toBe(idempotencyKey(input));
  });
});
