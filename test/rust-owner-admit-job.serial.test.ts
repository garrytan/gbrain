/**
 * Jobs submitted from a second process of a Rust brain (an owner-socket client): `admitJob` and
 * `coalesceOnIdempotencyKey` (multi-writer conformance C18, multi-user lane L3).
 *
 * Mode: each case runs twice: plain Rust (GBRAIN_RUST_MULTIUSER unset) and multi-user Rust (set to 1 in-run, after the
 * preload), and asserts what the owner's store resolved (`multiuser` false, then true).
 *
 * 1. Protects: a client's job submission is admitted by the owner (one row, visible to both engines); a second
 *    submission under the same idempotency key coalesces onto that row; a key held under another authority gives the
 *    client the same refusal it gives in process (the policy's `decide` hook throws it on the client, from the row the
 *    owner sends back). A delegated client's admission (it needs a transaction) is still refused typed.
 * 2. Fails on: a client submission refused because its policy carries functions; a coalesce that inserts a second row;
 *    a held key that is admitted, or refused with a different error than in process.
 * 3. Existing coverage: rust-owner-ipc.test.ts covers members without function arguments; nothing submitted a job
 *    from a client.
 * 4. Seam: none below the engine: real owner engine, real socket, real store, the real MinionQueue.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const dirs: string[] = [];

async function open(dir: string): Promise<RustEngine> {
  const engine = openRustEngine({ addon: await loadRustArmAddon(), databasePath: join(dir, 'db') });
  await engine.connect({ engine: 'rust', database_path: join(dir, 'db') } as never);
  return engine;
}

const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => String((e as { code?: string }).code ?? (e as Error).message));

describeAddon('jobs submitted from an owner-socket client of a Rust brain', () => {
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  for (const multiuser of [false, true]) {
    test(`${multiuser ? 'multi-user' : 'plain'} Rust: admitted, coalesced, and a held key refused as in process`, async () => {
      if (multiuser) process.env.GBRAIN_RUST_MULTIUSER = '1'; else delete process.env.GBRAIN_RUST_MULTIUSER;
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-admit-job-'));
      dirs.push(dir);
      const owner = await open(dir);
      const client = await open(dir);
      try {
        expect({ owner: owner.ownerRole, client: client.ownerRole, multiuser: owner.openStore('admit-job').multiuser })
          .toEqual({ owner: 'owner', client: 'client', multiuser });
        const fromClient = new MinionQueue(client);
        const job = await fromClient.add('sync', { n: 1 }, { idempotency_key: 'key-a' });
        expect(job.coalesced ?? false).toBe(false);
        expect((await owner.getJob(job.id))?.idempotency_key).toBe('key-a');
        const again = await fromClient.add('sync', { n: 1 }, { idempotency_key: 'key-a' });
        expect({ id: again.id, coalesced: again.coalesced }).toEqual({ id: job.id, coalesced: true });
        expect((await owner.listJobs({ limit: 50 })).length).toBe(1);

        // A key held under another authority: the client refuses it exactly as the owner does in process.
        const other = { submissionAuthority: { kind: 'remote', token_name: 'agent-key', scopes: ['write'] } };
        const inProcess = await codeOf(new MinionQueue(owner).add('sync', { n: 2 }, { idempotency_key: 'key-a' }, other as never));
        const viaOwner = await codeOf(fromClient.add('sync', { n: 2 }, { idempotency_key: 'key-a' }, other as never));
        expect(inProcess).not.toBe('ok');
        expect(viaOwner).toBe(inProcess);
        expect((await owner.listJobs({ limit: 50 })).length).toBe(1);

        // The idempotency fast path takes the same hook.
        const coalesced = await client.coalesceOnIdempotencyKey('key-a', { authority: job.submission_authority ?? null, decide: async () => 'coalesce' } as never);
        expect(coalesced?.id).toBe(job.id);
      } finally {
        await client.disconnect();
        await owner.disconnect();
      }
    }, 120_000);
  }
});
