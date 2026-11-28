/**
 * extract_atoms from a second process on a Rust brain: the client reaches the brain over the owner socket, where
 * transactions do not cross, so it cannot publish the atoms a model call returns. The phase must refuse by name before
 * its first model call, so the client pays nothing.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on an owner-socket client, a phase run with work ends with `engine_capability_missing` (via=owner_ipc)
 *    and makes no model call, on every run; the owner process itself still extracts and stores the atoms.
 *  - Regression: the state gate passed on a client, so each run paid for a model call, the atom publication then
 *    refused (it opens a transaction) and the item was recorded as a transient failure: every dream cycle of an opt-in
 *    brain paid again for atoms it could never store.
 *  - Why existing coverage misses it: the extract_atoms tests run the phase in the owner process only, and the owner
 *    socket tests call members one at a time, never a phase that publishes.
 *  - Seam: `_chat` (the phase's own model seam) counts the calls instead of reaching a provider; real owner sockets.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { electOwner, type OwnerRole } from '../src/core/rust-engine/owner-ipc/election.ts';
import { ownerWholeOperations } from '../src/core/rust-engine/owner-ipc/owner-ops.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const ADDON_TARGET = detectAddonTarget();
const ADDON_BUILT = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${ADDON_TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = ADDON_TARGET !== null && existsSync(ADDON_BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON_BUILT} does not exist; run bun run rust:build`);
}

const BODY = 'We met and decided many durable things about the example project. '.repeat(40);
const atoms = (titles: string[]): ChatResult => ({
  text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.` }))),
  blocks: [{ type: 'text', text: '' }], stopReason: 'end',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
});

async function clientOf(socketPath: string): Promise<{ engine: BrainEngine; close: () => void }> {
  const connection = await connectOwner(socketPath);
  const engine = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
  const close = installOwnerClient(engine, connection);
  return { engine, close };
}

/** What a refused run reports, and whether the owner process itself still extracts afterwards. */
interface Refusal { member: string; reason: string; via: string | null; ownerExtracts: boolean }

/** PGLite owner: the client's state gate refuses over the socket (transactions do not cross); the owner extracts. */
const PGLITE_OWNER: Refusal = { member: 'assertAtomStateStore', reason: 'transactions', via: 'owner_ipc', ownerExtracts: true };
/** Rust owner: discovery is refused before the state gate (the store keeps no sync-21 discovery state), for everyone. */
const RUST_OWNER: Refusal = { member: 'listExtractablePages', reason: 'health', via: null, ownerExtracts: false };

/** Runs the phase twice from a client: each run must refuse by name and make no model call. */
async function expectClientRefusesBeforeTheModel(socketPath: string, owner: BrainEngine, expected: Refusal) {
  await owner.putPage('meetings/example', { type: 'meeting', title: 'Example', compiled_truth: BODY, timeline: '', frontmatter: {} } as never);
  const { engine, close } = await clientOf(socketPath);
  let calls = 0;
  try {
    for (let run = 0; run < 2; run++) {
      const outcome = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { calls++; return atoms(['First claim']); } })
        .then(result => ({ result }), (error: unknown) => ({ error }));
      expect('error' in outcome ? null : (outcome as { result: unknown }).result).toBeNull();
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('engine_capability_missing');
      expect((error as OperationError).detail).toContain(`member=${expected.member}`);
      if (expected.via) expect((error as OperationError).detail).toContain(`via=${expected.via}`);
      expect((error as OperationError).reason).toBe(expected.reason);
    }
    expect(calls).toBe(0);
    expect(await owner.listPages({ type: 'atom' } as never)).toEqual([]);
  } finally { close(); }
  if (expected.ownerExtracts) {
    // The owner process itself still extracts and stores the atoms.
    const result = await runPhaseExtractAtoms(owner, { _transcripts: [], _chat: async () => { calls++; return atoms(['First claim']); } });
    expect(result.status).toBe('ok');
    expect(calls).toBe(1);
    expect((await owner.listPages({ type: 'atom' } as never)).length).toBe(1);
    return;
  }
  // The Rust owner refuses the same way: no model call, nothing stored.
  const ownerRun = await runPhaseExtractAtoms(owner, { _transcripts: [], _chat: async () => { calls++; return atoms(['First claim']); } })
    .then(() => null, (error: unknown) => error);
  expect(ownerRun).toBeInstanceOf(OperationError);
  expect((ownerRun as OperationError).code).toBe('engine_capability_missing');
  expect((ownerRun as OperationError).detail).toContain(`member=${expected.member}`);
  expect(calls).toBe(0);
  expect(await owner.listPages({ type: 'atom' } as never)).toEqual([]);
}

describe('extract_atoms from an owner-socket client, owner on PGLite', () => {
  let dir: string;
  let owner: PGLiteEngine;
  let role: OwnerRole;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-owner-'));
    owner = new PGLiteEngine();
    await owner.connect({});
    await owner.initSchema();
    role = await electOwner(owner, join(dir, 'brain.rust'), { wholeOperations: ownerWholeOperations() });
  }, 120_000);

  afterAll(async () => {
    if (role?.role === 'owner') { await role.server.close(); await role.lock.release(); }
    await owner?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the phase refuses by name before the model call, on every run, and the owner still extracts', async () => {
    expect(role.role).toBe('owner');
    await expectClientRefusesBeforeTheModel(ownerSocketPath(join(dir, 'brain.rust')), owner, PGLITE_OWNER);
  }, 120_000);
});

describe.skipIf(!HAVE_ADDON)('extract_atoms from an owner-socket client, owner on the Rust engine', () => {
  let dir: string;
  let db: string;
  let owner: RustEngine;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-owner-rust-'));
    db = join(dir, 'brain.rust');
    mkdirSync(db, { recursive: true });
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON_BUILT } });
    owner = openRustEngine({ addon, databasePath: db });
    await owner.connect({ engine: 'rust', database_path: db } as never);
    expect(existsSync(ownerSocketPath(db))).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (owner) await disposePersistenceConsumer(owner as unknown as BrainEngine);
    await owner?.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('the phase refuses by name before the model call, on every run, for the client and the owner', async () => {
    await expectClientRefusesBeforeTheModel(ownerSocketPath(db), owner as unknown as BrainEngine, RUST_OWNER);
  }, 120_000);
});
