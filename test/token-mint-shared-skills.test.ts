import { expect, test } from 'bun:test';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import type { BrainEngine } from '../src/core/engine.ts';

test('legacy self-member issuance stores the explicit operation snapshot without granting editing', async () => {
  let inserted: { scopes?: string[] | null; permissions?: unknown } = {};
  const engine = { insertAccessToken: async (row: typeof inserted) => { inserted = row; return { id: '11111111-1111-4111-8111-111111111111' }; },
    executeRaw: async () => [{ id: '11111111-1111-4111-8111-111111111111' }],
    readScopeSourceConfigs: async () => [],
    transaction: (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine) } as unknown as BrainEngine;
  const minted = await mintLegacyToken(engine, { name: 'fixture-member', takesHolders: ['world'], scopes: ['read', 'skills_member_self'],
    sourceGrant: ['workspace'], allowedOperations: ['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill', 'get_skill'] });
  expect(minted.scopes).toEqual(['read', 'skills_member_self']);
  expect(inserted.scopes).toEqual(['read', 'skills_member_self']);
  expect(inserted.permissions).toEqual({ takes_holders: ['world'], source_id: ['workspace'], allowed_operations: ['join_brain', 'sync_brain_skills', 'leave_brain', 'get_skill'] });
});

test('an explicit empty operation ceiling stays deny-all; unknown operation names fail before insertion', async () => {
  let calls = 0, permissions: unknown;
  const engine = { insertAccessToken: async (row: { permissions: unknown }) => { calls++; permissions = row.permissions; return { id: '11111111-1111-4111-8111-111111111111' }; } } as unknown as BrainEngine;
  const base = { name: 'fixture-member', takesHolders: ['world'], scopes: ['read'] };
  await mintLegacyToken(engine, { ...base, allowedOperations: [] });
  expect(permissions).toEqual({ takes_holders: ['world'], allowed_operations: [] });
  await expect(mintLegacyToken(engine, { ...base, allowedOperations: ['made_up_operation'] })).rejects.toThrow('registered remote operation');
  expect(calls).toBe(1);
});
