/**
 * BrainEngine parity: `gbrain guests grant-owner-clients` (loss row 32m-3). The guest-source check runs through the
 * typed `hasGuestSourceRow` member instead of caller SQL. PGLite and Postgres answer it with the statement the caller
 * ran; a Rust brain keeps no guest_sources and refuses it typed, naming the guest_sources capability.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: for a guest source made by `guests init --yes`, PGLite and Postgres print the same preview, `--json` and
 *    `--json --yes` and grant the same credentials; for a source that is not a guest source, both print the same "is not
 *    a guest source" line, exit 2 and write nothing. A Rust brain refuses both with engine_capability_missing
 *    (capability guest_sources), prints nothing, asks for no exit, writes nothing, and the CLI reports the same stderr
 *    and exit code for both.
 *  - Regression: the check ran `SELECT 1 FROM guest_sources` through executeRaw, so a Rust brain refused it as raw_sql,
 *    a refusal that names no storage the Rust engine could add; a store that answered "no row" would send the operator
 *    to `guests init` for a real guest source.
 *  - Why existing coverage misses it: test/guests-grant-owner-clients.test.ts runs on PGLite only.
 *  - Seam: none. Real engines. `guests init --yes` refuses on Rust (row 32m-3, next item), so the Rust arm's guest
 *    source is the config record `guests init` writes (createSource with guest: true), the only guest record it keeps.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runGuests } from '../../src/commands/guests.ts';
import { writeCliError } from '../../src/cli/cli-error.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { createSource, parityArms, resetArm, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest, arms } = parityArms(testBackends());

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

/** A guest source the way this arm can make one: `guests init --yes`, or on Rust the config record init writes. */
async function makeGuest(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  if (backend === 'rust') { await createSource(engine, backend, 'guests', { federated: true, guest: true, trust_ceiling: 'external_untrusted' }); return; }
  expect((await captured(() => runGuests(engine, ['init', '--source', 'guests', '--yes']))).exits).toEqual([]);
}

describe('guests grant-owner-clients (row 32m-3)', () => {
  parityTest('guests.ts:140 a guest source: the preview, --json and --json --yes agree; Rust refuses guest_sources',
    { methods: ['hasGuestSourceRow', 'insertOauthClient'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      await makeGuest(engine, backend);
      const preview = await captured(() => runGuests(engine, ['grant-owner-clients']));
      const json = await captured(() => runGuests(engine, ['grant-owner-clients', '--json']));
      const before = await clientReads(engine);
      const applied = await captured(() => runGuests(engine, ['grant-owner-clients', '--json', '--yes']));
      const after = await clientReads(engine);
      const again = await captured(() => runGuests(engine, ['grant-owner-clients']));
      return { preview, json, before, applied, after, again };
    });

  parityTest('guests.ts:140 a source that is not a guest source: the same line, exit 2, nothing written; Rust refuses guest_sources',
    { methods: ['hasGuestSourceRow', 'insertOauthClient'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      await createSource(engine, backend, 'not-guest');
      const before = await clientReads(engine);
      const run = await captured(() => runGuests(engine, ['grant-owner-clients', '--source', 'not-guest', '--yes']));
      expect(run.exits).toEqual([2]);
      return { run, unchanged: JSON.stringify(await clientReads(engine)) === JSON.stringify(before) };
    });

  // The parity harness counts a typed refusal as a stop; this pins what the Rust arm does at the CLI: the error, the
  // stderr and exit code the CLI writes for it, and that no credential changed.
  test('a Rust brain refuses guests grant-owner-clients with the typed guest_sources refusal, writes nothing, and the CLI exits with it', async () => {
    const rust = arms().find(arm => arm.backend === 'rust');
    if (!rust) return;
    const outcomes: unknown[] = [];
    for (const source of ['guests', 'not-guest']) {
      await resetArm(rust);
      const { engine } = rust;
      await seedCredentials(engine, 'rust');
      if (source === 'guests') await makeGuest(engine, 'rust');
      else await createSource(engine, 'rust', source);
      const before = JSON.stringify(await clientReads(engine));
      let thrown: unknown = null;
      const printed = await captured(async () => {
        try { await runGuests(engine, ['grant-owner-clients', '--source', source, '--yes']); } catch (e) { thrown = e; }
      });
      const stderr: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: unknown }).write = (s: string | Uint8Array) => { stderr.push(String(s)); return true; };
      let exitCode: number;
      try { exitCode = writeCliError(thrown, 'guests', { json: false }); } finally { (process.stderr as { write: unknown }).write = write; }
      const e = thrown as { code?: string; message?: string; reason?: string; detail?: string } | null;
      outcomes.push({ source, code: e?.code, reason: e?.reason, detail: e?.detail, message: e?.message, printed, exitCode, stderr: stderr.join(''),
        unchanged: JSON.stringify(await clientReads(engine)) === before });
    }
    const refusal = "This brain's engine does not support hasGuestSourceRow yet (it needs the guest_sources capability), so nothing ran.";
    expect(outcomes).toEqual(['guests', 'not-guest'].map(source => ({
      source, code: 'engine_capability_missing', reason: 'guest_sources',
      detail: 'member=hasGuestSourceRow capability=guest_sources outcome=none written=nothing', message: refusal,
      printed: { out: [], err: [], exits: [] }, exitCode: expect.any(Number), stderr: expect.stringContaining(refusal), unchanged: true,
    })));
    expect((outcomes[0] as { exitCode: number }).exitCode).toBe((outcomes[1] as { exitCode: number }).exitCode);
    expect((outcomes[0] as { stderr: string }).stderr).toBe((outcomes[1] as { stderr: string }).stderr);
  }, 120_000);
});
