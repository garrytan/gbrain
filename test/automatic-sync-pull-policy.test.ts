import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { automaticSyncPull } from '../src/core/persistence/automatic-sync-policy.ts';
import { resolveJobPull } from '../src/commands/jobs.ts';

function engine(enabled: boolean, claimed: boolean, fail = false, singleton?: readonly unknown[]): BrainEngine {
  return { executeRaw: async (sql: string) => {
    if (fail) throw new Error('synthetic metadata unavailable');
    if (sql.includes('FROM persistence_brain')) return singleton ?? [{ enabled }];
    if (sql.includes('FROM persistence_source_bindings')) return claimed ? [{ source_id: 'example' }] : [];
    throw new Error('Unexpected metadata query');
  } } as unknown as BrainEngine;
}
test('automatic pull uses ownership metadata, not immutable, clone or federation flags', async () => {
  for (const immutable of [false, true]) for (const encoded of [false, true]) {
    const config = { remote_url: 'https://example.invalid/repository.git', immutable, managed_clone: true, federated: false };
    const source = { id: 'example', config: encoded ? JSON.stringify(config) : config };
    expect(await automaticSyncPull(engine(false, false), source)).toBe(true);
    expect(await automaticSyncPull(engine(false, true), source)).toBe(false);
    expect(await automaticSyncPull(engine(true, false), source)).toBe(false);
    expect(await automaticSyncPull(engine(true, true), source)).toBe(false);
  }
  expect(await automaticSyncPull(engine(false, false), { id: 'example', config: {} })).toBe(false);
});
test('unavailable authoritative metadata cannot fall back to requesting pull', async () => {
  await expect(automaticSyncPull(engine(false, false, true), { id: 'example', config: { remote_url: 'https://example.invalid/repository.git' } })).rejects.toThrow('metadata unavailable');
});
test('automatic policy never silently rewrites explicit manual pull or legacy inverse intent', () => {
  expect(resolveJobPull({ pull: true, noPull: true })).toBe(true);
  expect(resolveJobPull({ pull: false, noPull: false })).toBe(false);
  expect(resolveJobPull({ noPull: false })).toBe(true);
  expect(resolveJobPull({ noPull: true })).toBe(false);
  expect(resolveJobPull({})).toBe(true);
});

for (const [label, singleton] of [
  ['missing', []], ['null row', [null]], ['missing enabled', [{}]],
  ['null enabled', [{ enabled: null }]], ['string false', [{ enabled: 'false' }]],
  ['numeric false', [{ enabled: 0 }]], ['ambiguous', [{ enabled: false }, { enabled: true }]],
] as const) test(`automatic pull refuses ${label} singleton metadata with an empty binding`, async () => {
  const db = engine(false, false, false, singleton);
  await expect(automaticSyncPull(db, { id: 'example', config: { remote_url: 'https://example.invalid/repository.git' } }))
    .rejects.toMatchObject({ code: 'storage_error' });
});
