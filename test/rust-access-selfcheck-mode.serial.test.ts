/**
 * Multi-user lane L4: the access self-check is really on when its switches are set.
 *
 * The test preload strips GBRAIN_RUST_MULTIUSER, so a run that only sets the variables reads in single-user mode and
 * proves nothing. This file sets the switches in-run, reopens a Rust brain so the store resolves multi-user mode at
 * open, asserts `store().multiuser`, and checks that a caller's read went through the self-check (one more comparison,
 * no refusal). The CI lane .github/workflows/rust-multiuser-selfcheck.yml runs it before the parity suite.
 *
 * Needs the addon `bun run rust:build` writes (or GBRAIN_TEST_RUST_ENGINE_ADDON).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { accessSelfCheckStats } from '../src/core/rust-engine/access-self-check.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

const SWITCHES = ['GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_ACCESS_SELF_CHECK'] as const;
const saved: Record<string, string | undefined> = {};
let engine: RustEngine;
let dir: string;
const connect = () => engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);

beforeAll(async () => {
  for (const k of SWITCHES) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'gbrain-selfcheck-mode-'));
  engine = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: rustArmAddonPath() } }), databasePath: join(dir, 'db') });
  await connect();
  await engine.initSchema();
  await engine.putPage('notes/open', { type: 'note', title: 'Open', compiled_truth: 'x', frontmatter: {} } as never);
});

afterAll(async () => {
  await engine?.disconnect();
  rmSync(dir, { recursive: true, force: true });
  for (const k of SWITCHES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const read = () => withCallerAccess({ identity: ['member:alice-example'] },
  () => engine.readPageHiddenFromCaller('default', 'notes/open', { policy: 'read' }));

describe('the access self-check mode', () => {
  test('a brain opened single-user runs no self-check, even with the switches set later', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    process.env.GBRAIN_RUST_ACCESS_SELF_CHECK = '1';
    expect(engine.openStore('selfcheck-mode').multiuser).toBe(false);
    const before = accessSelfCheckStats().compared;
    expect(await read()).toBe(false);
    expect(accessSelfCheckStats().compared).toBe(before);
  });

  test('a brain reopened with the switches set is multi-user and checks every caller read', async () => {
    await engine.disconnect();
    await connect();
    expect(engine.openStore('selfcheck-mode').multiuser).toBe(true);
    const before = accessSelfCheckStats();
    expect(await read()).toBe(false);
    const after = accessSelfCheckStats();
    expect(after.compared).toBeGreaterThan(before.compared);
    expect(after.refused).toBe(before.refused);
  });
});
