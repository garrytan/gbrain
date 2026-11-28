/**
 * Receipt compaction on a Rust brain refuses up front.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a Rust engine, `compactWriteReceiptsDetailed` rejects with `engine_capability_missing` naming the
 *    listing member (`listCompactableReceipts`) and `outcome=none`, before any candidate is read or any receipt is
 *    written, so an aged committed put receipt stays exactly as it was. The compaction pass (`runCompactionPass`, what a
 *    one-shot consumer runs after a put) does not ask for the listing on an engine without raw SQL: it records the skip
 *    and returns instead of failing the chain, and reaches no refusing member (a caught refusal still counts in parity).
 *  - Regression: the listing was served, so the pass read the aged receipt and then failed halfway, in `compactReceipt`,
 *    with the raw-SQL refusal (`member=executeRaw`), which also aborted the queue upkeep that follows the pass.
 *  - Why existing coverage misses it: no parity case calls the listing, and the CLI put test never ages a receipt.
 *  - Seam: none. The receipt comes from a real `gbrain put` through the CLI on a Rust brain; the engine is the real addon.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { compactWriteReceiptsDetailed } from '../src/core/persistence/journal.ts';
import { runCompactionPass } from '../src/core/persistence/compaction-pass.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { loadRustArmAddon, rustArmAddonPath, rustArmRequested } from './engine-parity/rust-arm.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

describe.skipIf(!rustArmRequested())('Rust engine: receipt compaction', () => {
  let root: string;
  let engine: RustEngine;
  let receiptId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-rust-compaction-'));
    const home = join(root, 'home');
    const db = join(root, 'db');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: db }));
    const put = spawnSync(process.execPath, ['--no-env-file', CLI, 'put', 'notes/aged', '--content', '---\ntype: note\ntitle: Aged\n---\n# Aged\n\nA page whose put receipt ages.\n', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
      env: { PATH: process.env.PATH ?? '', HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() },
    });
    if (put.status !== 0) throw new Error(`gbrain put exited ${put.status}: ${put.stdout.trim() || put.stderr.trim().slice(-2000)}`);
    engine = openRustEngine({ addon: await loadRustArmAddon(), databasePath: db });
    await engine.connect({ engine: 'pglite', database_path: db } as never);
    // The receipt is aged: a retention of 0 days makes every completed receipt older than the window.
    const aged = await engine.openStore('listCompactableReceipts').brain.listCompactableReceipts(0) as Array<{ id: string }>;
    expect(aged.length).toBe(1);
    receiptId = aged[0]!.id;
  }, 180_000);
  afterAll(async () => {
    await engine?.disconnect();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const receipt = () => (engine as unknown as BrainEngine).readWriteRequestById(receiptId);

  test('an aged committed put receipt is refused before any read, and stays as it was', async () => {
    const before = await receipt();
    expect(before).toMatchObject({ operation: 'put_page', state: 'committed', compacted: false });
    expect(before!.intent).not.toBeNull();

    const refused = await compactWriteReceiptsDetailed(engine as unknown as BrainEngine, 0).then(() => null, (e: { code?: string; detail?: string }) => e);
    expect(refused?.code).toBe('engine_capability_missing');
    // The refusal is the listing's, taken before anything ran; the raw-SQL refusal of compactReceipt (member=executeRaw) is the halfway one.
    expect(refused?.detail).toContain('member=listCompactableReceipts');
    expect(refused?.detail).toContain('outcome=none');
    expect(refused?.detail).toContain('written=nothing');

    expect(await receipt()).toEqual(before!);
  });

  test('the compaction pass skips the listing without asking for it, records the skip and returns', async () => {
    // Every member the pass reaches is recorded; asking for the unserved listing would raise a refusal even if caught.
    const reached = new Set<string>();
    const recorded = new Proxy(engine as unknown as BrainEngine, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        reached.add(String(prop));
        return value.bind(target);
      },
    });
    const record = await runCompactionPass(recorded, { hostId: 'rust-compaction-test' });
    expect(record).toMatchObject({ compacted: 0, freed_bytes: 0, skipped_by_reason: { receipt_compaction_unsupported: 1 } });
    expect(reached.has('listCompactableReceipts')).toBe(false);
    expect((await receipt())!.compacted).toBe(false);
  });
});
