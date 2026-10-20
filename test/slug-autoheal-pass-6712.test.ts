/**
 * #6712 PR 4b lane C: the #6865 stray slug: line heal (src/core/repair/slug-autoheal.ts) skips with `sync_unfinished`
 * while the source's sync has not finished. A non-company source syncs by the live pass and keeps no cursor row, so the
 * skip reads the pass row and the drain lease: a newest pass that is open or ended other than `synced`/`up_to_date`, an
 * open episode, or another drainer's live lease. A heal after the pass's own stamp at HEAD runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { SyncResult } from '../src/commands/sync.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP, readPassRow, type ManagedSyncPassValue } from '../src/core/persistence/sync-pass-row.ts';
import { healAfterManagedSync, SLUG_AUTO_REMOVE_KEY } from '../src/core/repair/slug-autoheal.ts';
import { withEnv } from './helpers/with-env.ts';

const STRAY = 'investors/fund-a.md';
const STRAY_BYTES = '---\ntitle: "Fund A"\ntype: company\nslug: fund-a\n---\nFund A invests in example companies.\n';
const SYNCED = { status: 'synced', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [] } as SyncResult;

let engine: PGLiteEngine;
let home: string;
let root: string;
let incarnation: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-slug-autoheal-pass-'));
  root = join(home, 'content');
  await inHome(async () => {
    mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    git('init', '-q'); git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@example.invalid');
    mkdirSync(join(root, 'investors'));
    writeFileSync(join(root, STRAY), STRAY_BYTES);
    git('add', STRAY); git('commit', '-qm', 'fixture');
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
    chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
    await claimWorktree(engine, 'default', root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    await engine.setConfig(SLUG_AUTO_REMOVE_KEY, 'false');
    const first = await sync();
    expect(first.slug_lines_removed).toMatchObject({ skipped: 'disabled', removed: 0, pending: 1 });
    await engine.setConfig(SLUG_AUTO_REMOVE_KEY, 'true');
  });
  [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
}, 180_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

function inHome<T>(run: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, run);
}
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const sync = () => performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true } as never);
const heldPaths = async () => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).map(hold => [hold.path, hold.code]);

async function passValue(): Promise<ManagedSyncPassValue> {
  const row = await readPassRow(engine, 'default', incarnation);
  expect(row).not.toBeNull();
  return row!.value;
}
async function writePass(value: ManagedSyncPassValue): Promise<void> {
  await engine.executeRaw('UPDATE op_checkpoints SET completed_keys=jsonb_build_array($3::text::jsonb) WHERE op=$1 AND fingerprint=$2',
    [MANAGED_SYNC_PASS_OP, 'default:' + incarnation, JSON.stringify(value)]);
}

describe('the #6865 heal reads the pass row for a source with no cursor (#6712 PR 4b)', () => {
  test("an unfinished pass, an open episode or another drainer's lease skips the heal with sync_unfinished", () => inHome(async () => {
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op IN ('managed-sync','managed-sync-manifest','managed-sync-slice')")).toEqual([]);
    expect(await heldPaths()).toEqual([[STRAY, 'frontmatter_slug_conflict']]);
    const settled = await passValue();
    expect(['synced', 'up_to_date']).toContain(settled.telemetry.outcome);
    expect(settled.obligations.episode).toBeUndefined();
    const unfinished: Array<[string, ManagedSyncPassValue]> = [
      ['an open pass', { ...settled, telemetry: { ...settled.telemetry, outcome: 'open', ended_at: null, stop_reason: null } }],
      ['a pass that stopped not_converged', { ...settled, telemetry: { ...settled.telemetry, outcome: 'resumable', stop_reason: 'not_converged' } }],
      ['a pass that stopped writer_pending', { ...settled, telemetry: { ...settled.telemetry, outcome: 'resumable', stop_reason: 'writer_pending' } }],
      ['a pass that stopped blocked', { ...settled, telemetry: { ...settled.telemetry, outcome: 'blocked', stop_reason: 'reconcile_read_incomplete' } }],
      ['a scoped pass that synced with its episode still open', { ...settled, telemetry: { ...settled.telemetry, outcome: 'synced', stop_reason: 'selection_scoped' },
        obligations: { ...settled.obligations, episode: { opened_at: new Date().toISOString(), full_id: 'episode-6712-lane-c',
          selection: { exclude: [], includeHidden: [], strategy: 'markdown', srcSubpath: null, mode: 'committed' }, inherited: { noEmbed: true, noExtract: true, noSchemaPack: false, from: 'flag' } } } }],
    ];
    try {
      for (const [label, value] of unfinished) {
        await writePass(value);
        const report = (await healAfterManagedSync(engine, { sourceId: 'default' } as never, SYNCED)).slug_lines_removed;
        expect({ label, report }).toMatchObject({ label, report: { skipped: 'sync_unfinished', removed: 0, pending: 1 } });
        expect(report!.notice).toContain('the source still has an unfinished sync');
        expect(readFileSync(join(root, STRAY), 'utf8')).toBe(STRAY_BYTES);
      }
      await writePass(settled);
      const lease = await tryAcquireDbLock(engine, syncLockId('default'), 2);
      expect(lease).not.toBeNull();
      try {
        expect((await healAfterManagedSync(engine, { sourceId: 'default' } as never, SYNCED)).slug_lines_removed).toMatchObject({ skipped: 'sync_unfinished', removed: 0, pending: 1 });
      } finally { await lease!.release(); }
      expect(readFileSync(join(root, STRAY), 'utf8')).toBe(STRAY_BYTES);
    } finally { await writePass(settled); }
    expect(await heldPaths()).toEqual([[STRAY, 'frontmatter_slug_conflict']]);
  }), 180_000);

  test('a pass left open is finished by the next sync, whose stamp at HEAD lets the heal run', () => inHome(async () => {
    const settled = await passValue();
    await writePass({ ...settled, telemetry: { ...settled.telemetry, outcome: 'open', ended_at: null, stop_reason: null } });
    const head = git('rev-parse', 'HEAD');
    const result = await sync();
    const after = await passValue();
    expect(['synced', 'up_to_date']).toContain(after.telemetry.outcome);
    expect(after.telemetry.pass_id).not.toBe(settled.telemetry.pass_id);
    expect(after.obligations.converged?.target).toBe(head);
    expect(result.slug_lines_removed).toMatchObject({ removed: 1, pending: 0, failed: 0, removed_paths: [STRAY] });
    expect(readFileSync(join(root, STRAY), 'utf8')).toBe(STRAY_BYTES.replace('slug: fund-a\n', ''));
    expect(await heldPaths()).toEqual([]);
  }), 180_000);
});
