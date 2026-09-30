import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import type { TopologyCloneRecovery } from '../src/core/persistence/topology-clone-model.ts';
import { finishTopologyClone } from '../src/core/persistence/topology-recovery.ts';
import { withEnv } from './helpers/with-env.ts';

const cloneId = '12345678-abcd-4abc-8abc-123456789abc';

async function fixture(targetName: string, run: (record: TopologyCloneRecovery, home: string) => Promise<void>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-recovery-paths-')));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const target = join(home, targetName);
      await run({
        version: 1, kind: 'clone', phase: 'aborting', operation: 'add',
        sourceId: 'recovery-source', incarnation: randomUUID(), worktreeId: randomUUID(),
        ownerHostId: localHostId(), ownerEpoch: '1', target,
        stage: join(home, `.gbrain-clone-${targetName}-${cloneId}`),
        aside: `${target}.gbrain-old-${cloneId}`, beforeHash: null, afterHash: null,
        manifest: null, canonicalStamp: '', checkpoint: null, sourceRemoteUrl: null,
        input: { operation: 'add', sourceId: 'recovery-source', path: target }, cloneBudget: 65_536,
      }, home);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function expectValidation(record: TopologyCloneRecovery, accepted: boolean) {
  const id = randomUUID();
  const validated = new Error('recovery transaction reached');
  let transactions = 0;
  // Stop at the first publication transaction. Invalid recovery paths must be
  // rejected before that boundary, without opening a datastore or moving files.
  const engine = {
    kind: 'pglite',
    executeRaw: async (sql: string, params: unknown[]) => {
      expect(sql).toBe('SELECT * FROM persistence_topology_changes WHERE id=$1::uuid');
      expect(params).toEqual([id]);
      return [{ id, state: 'recovering', recovery: record }];
    },
    transaction: async () => { transactions++; throw validated; },
  } as unknown as BrainEngine;
  if (accepted) await expect(finishTopologyClone(engine, id)).rejects.toBe(validated);
  else await expect(finishTopologyClone(engine, id)).rejects.toMatchObject({ code: 'recovery_required' });
  expect(transactions).toBe(accepted ? 1 : 0);
}

test.each(['canonical', 'brain.[v1]+(draft)$^{backup}', 'brain with spaces-記憶'])(
  'clone recovery accepts generated UUID paths for the literal target %s',
  async targetName => fixture(targetName, async record => expectValidation(record, true)),
);

test('clone recovery rejects malformed staging tokens and target prefix collisions', async () => fixture('brain.[v1]+(draft)', async (record, home) => {
  for (const suffix of ['', cloneId.slice(1), `${cloneId}a`, cloneId.toUpperCase(), `${cloneId.slice(0, -1)}g`, `extra-${cloneId}`]) {
    await expectValidation({ ...record, stage: join(home, `.gbrain-clone-${basename(record.target)}-${suffix}`) }, false);
  }
  for (const targetName of ['brainX[v1]+(draft)', 'brain.v1draft', `${basename(record.target)}-other`]) {
    await expectValidation({ ...record, stage: join(home, `.gbrain-clone-${targetName}-${cloneId}`) }, false);
  }
}));

test('clone recovery retains parent, canonical path, aside prefix and owner checks', async () => fixture('canonical', async (record, home) => {
  const invalid: Partial<TopologyCloneRecovery>[] = [
    { stage: join(home, 'other', basename(record.stage)) },
    { aside: join(home, 'other', basename(record.aside)) },
    { stage: `${home}/./${basename(record.stage)}` },
    { target: `${home}/./canonical` },
    { aside: `${record.target}-other.gbrain-old-${cloneId}` },
    { aside: `${record.target}.gbrain-old-` },
    { aside: `${record.target}.gbrain-old-${cloneId.toUpperCase()}` },
    { aside: `${record.target}.gbrain-old-${cloneId}g` },
    { ownerHostId: randomUUID() },
  ];
  for (const change of invalid) await expectValidation({ ...record, ...change }, false);
}));
