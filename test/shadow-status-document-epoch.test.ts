/**
 * The shadow status document reads one evidence epoch (docs/guides/engine-swap.md#readiness).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the swap verdict from mixing two Rust candidates: the follower's epoch
 * start, clean reconciles, probe and allocator checks (criteria 1 and 7) must come from the same evidence epoch as the
 * read, search and child evidence. (2) Fails when the document is assembled across an epoch rotation, e.g. the epoch
 * changes while the eligibility query is awaited and the follower fields keep the old epoch while the evidence fields
 * name the new one. (3) The builders' own tests each read one epoch; nothing tested their assembly. (4) Real shadow
 * files and the real epoch writer; the engine is a stub whose only job is to rotate the epoch while its query is
 * pending, then fail it (eligibility then reports `read_failed`, as designed).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { policyHash, READINESS_POLICY } from '../src/core/engine-swap/policy.ts';
import { capabilitySetHash, ensureEpoch, readEpoch, type EpochInputs } from '../src/shadow/evidence-epoch.ts';
import { shadowStatusDocument } from '../src/shadow/status-document.ts';

const INPUTS: EpochInputs = {
  seed_id: 'seed-1', rust_addon_sha256: 'a'.repeat(64), comparator_version: 1, adapter_version: 'abi1.catalog3',
  capability_set_hash: capabilitySetHash(['pages', 'search']), readiness_policy_hash: policyHash(READINESS_POLICY),
};
const STARTED = Date.parse('2026-11-24T00:00:00.000Z');
const NOW = new Date('2026-11-30T12:00:00.000Z');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** An engine whose every query first opens a new epoch (a new Rust addon), then fails. */
function rotatingEngine(dir: string): BrainEngine {
  const rotate = async (): Promise<never> => {
    await new Promise(r => setTimeout(r, 5));
    ensureEpoch(dir, { ...INPUTS, rust_addon_sha256: 'b'.repeat(64) }, STARTED + 86_400_000);
    throw Object.assign(new Error('stub query failed'), { code: 'stub_failed' });
  };
  return new Proxy({ kind: 'pglite', capabilities: new Set<string>() } as unknown as BrainEngine, {
    get(target, prop) {
      if (prop in target) return (target as unknown as Record<PropertyKey, unknown>)[prop];
      if (prop === 'then') return undefined;
      return rotate;
    },
  });
}

describe('the shadow status document', () => {
  test('an epoch that rotates while the document is assembled never mixes two epochs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-status-epoch-'));
    dirs.push(dir);
    const first = ensureEpoch(dir, INPUTS, STARTED);
    const doc = await shadowStatusDocument({ key: 'pglite-test', dir }, NOW, rotatingEngine(dir));
    const current = readEpoch(dir)!;
    expect(current.epoch_id).not.toBe(first.epoch_id); // the stub did rotate it
    // Every epoch-bound field names the same epoch: the one current when the document was finished.
    expect(doc.epoch_id).toBe(current.epoch_id);
    expect(doc.epoch_started_at).toBe(current.started_at);
    expect(doc.evidence?.epoch_id).toBe(current.epoch_id);
    expect(doc.evidence?.epoch_started_at).toBe(current.started_at);
  });

  test('a stable epoch: the follower and the evidence fields name it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-status-epoch-'));
    dirs.push(dir);
    const e = ensureEpoch(dir, INPUTS, STARTED);
    const doc = await shadowStatusDocument({ key: 'pglite-test', dir }, NOW);
    expect(doc.epoch_id).toBe(e.epoch_id);
    expect(doc.evidence?.epoch_id).toBe(e.epoch_id);
  });
});
