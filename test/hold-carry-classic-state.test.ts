/**
 * Wave-5 follow-up: `sources writer deactivate` carries managed connector holds
 * into each source's classic state file. These pin the two edges the
 * integrated scenario (fix-wave-4-integration X6) does not reach:
 *   - a source whose worktree another host owns is not written from here
 *     (its classic state lives on that host); deactivation keeps refusing;
 *   - a hold copied by an earlier deactivation that then aborted, and was
 *     resolved in managed mode since, is cleared on the next carry instead of
 *     coming back as held in classic mode.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { carryHoldsToClassicState, holdCarryBlocked, planHoldCarry } from '../src/core/connectors/item-holds-store.ts';
import { carryLegacyFailCounts } from '../src/core/connectors/item-holds.ts';
import { connectorCheckpointKey, connectorIdentity } from '../src/core/persistence/connector-identity.ts';

let engine: PGLiteEngine;
let dir: string;
const config = { kind: 'google', g_account: 'reader@example.com', g_services: 'gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const HOST = randomUUID();
const held = () => carryLegacyFailCounts(undefined, { 'thread-1': 3 }, id => id, '2026-10-01T00:00:00.000Z');
const stateFile = () => join(dir, '.google-source.json');

async function setManagedHolds(holds: unknown): Promise<void> {
  const [row] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='gmail-a'");
  const key = connectorCheckpointKey('gmail-a', row.incarnation, connectorIdentity('google', config, dir));
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-connector'");
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-connector',$1,$2::text::jsonb)`,
    [key, JSON.stringify([{ state: { history_id: 'h1', item_holds: holds } }])]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-hold-carry-'));
  await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)', ['gmail-a', dir, JSON.stringify(config)]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  rmSync(stateFile(), { force: true });
  await engine.executeRaw('DELETE FROM persistence_source_bindings');
  await engine.executeRaw('DELETE FROM persistence_worktrees');
});

describe('carrying connector holds into classic state', () => {
  test('a locally owned source takes its managed holds, other classic fields kept', async () => {
    await setManagedHolds(held());
    writeFileSync(stateFile(), JSON.stringify({ gmail_history_id: 'classic-cursor' }));
    const carried = await carryHoldsToClassicState(engine, HOST);
    expect(carried).toEqual([{ source_id: 'gmail-a', items: 1, state_file: stateFile() }]);
    const classic = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(classic.gmail_history_id).toBe('classic-cursor');
    expect(classic.item_holds).toEqual(JSON.parse(JSON.stringify(held())));
  });

  test('a hold copied by an aborted deactivation and resolved since is cleared, not resurrected', async () => {
    writeFileSync(stateFile(), JSON.stringify({ gmail_history_id: 'classic-cursor', item_holds: held() }));
    await setManagedHolds({ version: 1, items: {} });
    expect(await carryHoldsToClassicState(engine, HOST)).toEqual([]);
    const classic = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(classic).toEqual({ gmail_history_id: 'classic-cursor' });
  });

  test('a source whose worktree another host owns blocks and is never written from here', async () => {
    await setManagedHolds(held());
    const [incarnation] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='gmail-a'");
    const other = randomUUID();
    const [worktree] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees (owner_host_id) VALUES ($1::uuid) RETURNING id::text', [other]);
    await engine.executeRaw('INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES ($1, $2::uuid, $3::uuid)',
      ['gmail-a', incarnation.incarnation, worktree.id]);
    const [plan] = await planHoldCarry(engine, HOST);
    expect(plan).toMatchObject({ source_id: 'gmail-a', items: 1, owner_host: other });
    expect(holdCarryBlocked(plan)).toBe(true);
    await expect(carryHoldsToClassicState(engine, HOST)).rejects.toThrow(/cannot take its held items on this host/);
    expect(existsSync(stateFile())).toBe(false);
    // The owning host carries them.
    expect(holdCarryBlocked((await planHoldCarry(engine, other))[0])).toBe(false);
  });
});
