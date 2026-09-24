import { expect, test } from 'bun:test';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import type { BrainEngine } from '../src/core/engine.ts';

test('legacy self-member issuance stores the explicit operation snapshot without granting editing', async () => {
  let params: unknown[] = [];
  const engine = { executeRaw: async (_sql: string, values: unknown[]) => { params = values; return [{ id: '11111111-1111-4111-8111-111111111111' }]; } } as unknown as BrainEngine;
  const minted = await mintLegacyToken(engine, { name: 'fixture-member', takesHolders: ['world'], scopes: ['read', 'skills_member_self'],
    sourceGrant: ['workspace'], allowedOperations: ['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill', 'get_skill'] });
  expect(minted.scopes).toEqual(['read', 'skills_member_self']);
  expect(params[2]).toBe('{read,skills_member_self}');
  expect(params[3]).toEqual({ takes_holders: ['world'], source_id: ['workspace'], allowed_operations: ['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill'] });
});

test('an explicit empty operation ceiling stays deny-all; unknown operation names fail before insertion', async () => {
  let calls = 0, params: unknown[] = [];
  const engine = { executeRaw: async (_sql: string, values: unknown[]) => { calls++; params = values; return [{ id: '11111111-1111-4111-8111-111111111111' }]; } } as unknown as BrainEngine;
  const base = { name: 'fixture-member', takesHolders: ['world'], scopes: ['read'] };
  await mintLegacyToken(engine, { ...base, allowedOperations: [] });
  expect(params[3]).toEqual({ takes_holders: ['world'], allowed_operations: [] });
  await expect(mintLegacyToken(engine, { ...base, allowedOperations: ['made_up_operation'] })).rejects.toThrow('registered remote operation');
  expect(calls).toBe(1);
});
