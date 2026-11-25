/**
 * Whether a default-source writer is the brain owner is judged from the config table itself, not from a snapshot.
 *
 * Protects:
 * - `defaultSourceWriterIsOwner` reads `access.owner_member` through the keyed config read (`getConfigValues`). A batch's
 *   preparation view answers `getConfig` from the snapshot taken when the batch began, so a former owner would stay
 *   exempt from the member-only reader labels on every page the batch prepares afterwards, and publication does not
 *   recompute them.
 * Fails when the owner check goes back to `getConfig`.
 * No database: the engine is a stub whose snapshot read still names the old owner.
 */
import { expect, test } from 'bun:test';
import { defaultSourceWriterIsOwner } from '../src/core/persistence/page-visibility.ts';

function stubEngine(snapshotOwner: string, tableOwner: string) {
  return {
    getConfig: async () => snapshotOwner,
    getConfigValues: async (keys: readonly string[]) => keys.map(key => ({ key, value: tableOwner })),
    executeRaw: async () => { throw new Error('the typed keyed read serves this'); },
    readLiveMember: async () => ({ id: 'live' }),
  } as unknown as Parameters<typeof defaultSourceWriterIsOwner>[0];
}

test('a former owner is not the owner once the table names another, whatever the snapshot says', async () => {
  const engine = stubEngine('alice-example', 'bob-example');
  expect(await defaultSourceWriterIsOwner(engine, 'member:alice-example')).toBe(false);
  expect(await defaultSourceWriterIsOwner(engine, 'member:bob-example')).toBe(true);
});
