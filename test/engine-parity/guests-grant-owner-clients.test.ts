/**
 * BrainEngine parity: `gbrain guests grant-owner-clients` (loss row 32m-3). The guest-source check runs through the
 * typed `hasGuestSourceRow` member: PGLite and Postgres answer it with the statement the caller ran, and a Rust brain
 * from its guest_sources record (rust/crates/gbrain-store/src/guest_sources.rs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a guest source made by `guests init --yes`, every arm prints the same preview, `--json` and
 *    `--json --yes` and grants the same credentials; for a source that is not a guest source, every arm prints the same
 *    "is not a guest source" line, exits 2 and writes nothing.
 *  - Regression: the check ran `SELECT 1 FROM guest_sources` through executeRaw, so a Rust brain refused it as raw_sql;
 *    then, with no guest record, it refused it typed (guest_sources).
 *  - Why existing coverage misses it: test/guests-grant-owner-clients.test.ts runs on PGLite only.
 *  - Seam: none. Real engines.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runGuests } from '../../src/commands/guests.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'owner-example';
const PLAIN = 'source-a';

/** An owner with two bound clients (one reads only `source-a`, one reads the guest source already) and a member's client. */
async function seedCredentials(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, PLAIN);
  await addMember(engine, OWNER);
  await addMember(engine, 'bob-example');
  await setOwner(engine, OWNER);
  const clients: Array<[string, string, string[]]> = [
    ['c-narrow', OWNER, [PLAIN]], ['c-reading', OWNER, [PLAIN, 'guests']], ['c-member', 'bob-example', [PLAIN]],
  ];
  for (const [id, member, reads] of clients) {
    await engine.insertOauthClient({ client_id: id, client_name: `${id}-example`, client_secret_hash: 'secret-hash-value',
      grant_types: ['client_credentials'], scope: 'read write', source_id: PLAIN, federated_read: reads });
    await bindCredential(engine, { kind: 'client', id }, { member });
  }
}

/** stdout and stderr lines and the exit codes the command asked for; any other error is rethrown. */
async function captured(run: () => Promise<unknown>): Promise<{ out: string[]; err: string[]; exits: Array<number | undefined> }> {
  const out: string[] = [], err: string[] = [], exits: Array<number | undefined> = [];
  const [error, log, exit] = [console.error, console.log, process.exit];
  console.error = (...p: unknown[]) => { err.push(p.join(' ')); };
  console.log = (...p: unknown[]) => { out.push(p.join(' ')); };
  process.exit = ((code?: number) => { exits.push(code); throw Object.assign(new Error('EXIT'), { exitCode: code }); }) as typeof process.exit;
  try { await run(); } catch (e) {
    if ((e as Error).message !== 'EXIT') throw e;
  } finally { [console.error, console.log, process.exit] = [error, log, exit]; }
  return { out, err, exits };
}

async function clientReads(engine: BrainEngine): Promise<Record<string, string[]>> {
  const rows = await engine.listOauthClients();
  return Object.fromEntries(rows.map(r => [r.client_id, [...((r as { federated_read?: string[] | null }).federated_read ?? [])]]).sort());
}

/** A guest source made the way `gbrain guests init --source guests --yes` makes one, on every arm. */
async function makeGuest(engine: BrainEngine): Promise<void> {
  expect((await captured(() => runGuests(engine, ['init', '--source', 'guests', '--yes']))).exits).toEqual([]);
}

describe('guests grant-owner-clients (row 32m-3)', () => {
  parityTest('guests.ts:140 a guest source: the preview, --json and --json --yes agree on every arm',
    { methods: ['hasGuestSourceRow', 'insertOauthClient', 'upsertGuestSource'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      await makeGuest(engine);
      const preview = await captured(() => runGuests(engine, ['grant-owner-clients']));
      const json = await captured(() => runGuests(engine, ['grant-owner-clients', '--json']));
      const before = await clientReads(engine);
      const applied = await captured(() => runGuests(engine, ['grant-owner-clients', '--json', '--yes']));
      const after = await clientReads(engine);
      const again = await captured(() => runGuests(engine, ['grant-owner-clients']));
      return { preview, json, before, applied, after, again };
    });

  parityTest('guests.ts:140 a source that is not a guest source: the same line, exit 2, nothing written, on every arm',
    { methods: ['hasGuestSourceRow', 'insertOauthClient'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      await createSource(engine, backend, 'not-guest');
      const before = await clientReads(engine);
      const run = await captured(() => runGuests(engine, ['grant-owner-clients', '--source', 'not-guest', '--yes']));
      expect(run.exits).toEqual([2]);
      return { run, unchanged: JSON.stringify(await clientReads(engine)) === JSON.stringify(before) };
    });
});
