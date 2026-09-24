import { expect, test } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { brainMembershipOperations } from '../src/core/ops/brain-membership.ts';
import { parseOpArgs } from '../src/cli.ts';

test('shared skill synchronization does not replace the existing local administrator sync API', () => {
  const legacy = operationsByName.sync_brain;
  expect(legacy.scope).toBe('admin');
  expect(legacy.localOnly).toBe(true);
  expect(legacy.params.repo).toBeDefined();
  expect(legacy.params.installation_id).toBeUndefined();
  expect(operations.filter(operation => operation.name === 'sync_brain')).toHaveLength(1);
  const member = operationsByName.sync_brain_skills;
  expect(member.scope).toBe('read');
  expect(member.localOnly).not.toBe(true);
  expect(member.mutating).toBe(true);
  expect(member.requiredScopes).toEqual(['skills_member_self']);
  expect(member.params.installation_id).toBeDefined();
  expect(operations.filter(operation => operation.name === 'sync_brain_skills')).toHaveLength(1);
});

test('membership operations use the registry-contained domain array convention', () => {
  expect(Array.isArray(brainMembershipOperations)).toBe(true);
  expect(brainMembershipOperations.map(operation => operation.name)).toEqual(['join_brain', 'sync_brain_skills', 'leave_brain']);
  for (const operation of brainMembershipOperations) expect(operations).toContain(operation);
});

test('named CLI skill commands parse structured flags without echoing invalid private inputs', () => {
  for (const args of [
    ['--adapter', 'generic', '--follow-policy', '{"approved":true,"source_ids":["default"]}'],
    ['--adapter=generic', '--follow-policy={"approved":true,"source_ids":["default"]}'],
  ]) {
    expect(parseOpArgs(operationsByName.join_brain, args)).toEqual({ adapter: 'generic', follow_policy: { approved: true, source_ids: ['default'] } });
  }
  const files = [{ path: 'skills/example/SKILL.md', content: 'Synthetic fixture', file_class: 'prose' }];
  expect(parseOpArgs(operationsByName.put_skill, ['--files', JSON.stringify(files)]).files).toEqual(files);
  for (const value of ['private-fixture-invalid-json', 'null', '[]', 'true']) {
    try { parseOpArgs(operationsByName.join_brain, ['--follow-policy', value]); throw new Error('Expected JSON object refusal'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'invalid_params' });
      expect((error as Error).message).toBe('--follow-policy requires a JSON object.');
    }
  }
  expect(() => parseOpArgs(operationsByName.put_skill, ['--files', '{}'])).toThrow('--files requires a JSON array.');
});
