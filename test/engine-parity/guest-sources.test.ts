/**
 * BrainEngine parity: guest sources on every engine (loss row 32m-3 and `guests init --yes`). A Rust brain keeps the
 * guest_sources record (rust/crates/gbrain-store/src/guest_sources.rs) and enforces the guest-source rules of the trust
 * trigger (src/core/trust/schema.ts `guestGuard`) when it stores a page, fact, take or timeline row.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `guests init` (preview, then --yes) and `guests grant-owner-clients` print the same bytes on every arm; a
 *    source whose config alone says guest is "not a guest source" on every arm. A page in a guest source is created only
 *    by a listed writer (source_writer_restricted) publishing a guest note (guest_attribution_missing), and is never
 *    stored above the source's ceiling; a fact, take or timeline row there is refused (guest_page_immutable); a guest
 *    source takes no local path (guest_source_database_only). Each refusal has the same message on every arm and
 *    writes nothing.
 *  - Regression: a Rust brain refused init (raw_sql) and grant-owner-clients (guest_sources); a guest record without
 *    the rules would let any writer save any page at any tier in a guest source.
 *  - Why existing coverage misses it: the guest tests (test/guest-notes-*.test.ts) run on PGLite and Postgres only.
 *  - Not reachable on Rust: the fail-closed refusal of a role row-level security keeps from reading guest_sources
 *    (writer_coordinator_required); the Rust store has no row-level security.
 *  - Seam: none. Real engines; the write context is set with withWriteAttribution and applyTransactionSettings.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runGuests } from '../../src/commands/guests.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { initGuestSource } from '../../src/core/guests/sources.ts';
import { withWriteAttribution } from '../../src/core/persistence/context.ts';
import type { TrustTier } from '../../src/core/trust/tier.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'owner-example';
const PLAIN = 'source-a';
const BROKER = { kind: 'oauth_client' as const, id: 'broker-a' };
const OTHER = { kind: 'oauth_client' as const, id: 'broker-b' };
const REQUEST = randomUUID();

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

/** An owner with two bound clients (one reads only `source-a`, one already reads `guests`) and the broker client. */
async function seedCredentials(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, PLAIN);
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
  for (const [id, reads] of [['c-narrow', [PLAIN]], ['c-reading', [PLAIN, 'guests']], [BROKER.id, [PLAIN]]] as const) {
    await engine.insertOauthClient({ client_id: id, client_name: `${id}-example`, client_secret_hash: 'secret-hash-value',
      grant_types: ['client_credentials'], scope: 'read write', source_id: PLAIN, federated_read: [...reads] });
    if (id !== BROKER.id) await bindCredential(engine, { kind: 'client', id }, { member: OWNER });
  }
}

async function clientReads(engine: BrainEngine): Promise<Record<string, string[]>> {
  const rows = await engine.listOauthClients();
  return Object.fromEntries(rows.map(r => [r.client_id, [...((r as { federated_read?: string[] | null }).federated_read ?? [])]]).sort());
}

/** A write by `principal` declared at `tier`; `guestNote` names the write's request as the guest note it publishes. */
function writeAs<T>(engine: BrainEngine, principal: { kind: 'oauth_client'; id: string }, tier: TrustTier, guestNote: boolean, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(tx => withWriteAttribution(tx, { requestId: REQUEST, principal, trust: { tier, origin: { channel: 'test' } } }, async () => {
    if (guestNote) await tx.applyTransactionSettings(['gbrain.guest_note'], [REQUEST]);
    return fn(tx);
  }));
}

/** The message a write is refused with, or null when it is not refused. */
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => String((e as Error)?.message ?? e));

const note = (body: string) => ({ type: 'note', title: 'Guest words', compiled_truth: body, timeline: '', frontmatter: {} }) as Parameters<BrainEngine['putPage']>[1];

describe('guest sources (row 32m-3, guests init)', () => {
  parityTest('guests init: the preview and --yes print the same, and the source then reads as a guest source',
    { methods: ['upsertGuestSource', 'hasGuestSourceRow', 'listGuestSourceIds'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      const preview = await captured(() => runGuests(engine, ['init', '--source', 'guests', '--writer', `oauth_client:${BROKER.id}`]));
      const applied = await captured(() => runGuests(engine, ['init', '--source', 'guests', '--writer', `oauth_client:${BROKER.id}`, '--yes']));
      const again = await captured(() => runGuests(engine, ['init', '--source', 'guests']));
      return { preview, applied, again, row: await engine.hasGuestSourceRow('guests'), guests: await engine.listGuestSourceIds(['guests', PLAIN]) };
    });

  parityTest('guests.ts:140 grant-owner-clients on a guest source: the preview, --json and --json --yes agree on every arm',
    { methods: ['hasGuestSourceRow', 'upsertGuestSource'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      expect((await captured(() => runGuests(engine, ['init', '--source', 'guests', '--yes']))).exits).toEqual([]);
      const preview = await captured(() => runGuests(engine, ['grant-owner-clients']));
      const json = await captured(() => runGuests(engine, ['grant-owner-clients', '--json']));
      const applied = await captured(() => runGuests(engine, ['grant-owner-clients', '--json', '--yes']));
      return { preview, json, applied, after: await clientReads(engine) };
    });

  parityTest('guests.ts:140 a source whose config alone says guest is not a guest source here, on every arm',
    { methods: ['hasGuestSourceRow', 'listGuestSourceIds'] }, async (engine, backend) => {
      await seedCredentials(engine, backend);
      await createSource(engine, backend, 'cfg-guest', { federated: true, guest: true });
      const before = await clientReads(engine);
      const run = await captured(() => runGuests(engine, ['grant-owner-clients', '--source', 'cfg-guest', '--yes']));
      return { run, unchanged: JSON.stringify(await clientReads(engine)) === JSON.stringify(before),
        stillGuestForReads: await engine.listGuestSourceIds(['cfg-guest']) };
    });

  parityTest('guest page rules: only a listed writer publishing a guest note creates a page, capped at the ceiling',
    { methods: ['upsertGuestSource', 'putPage', 'getPage', 'readPageTrustRows', 'applyTransactionSettings'] }, async (engine, backend) => {
      await createSource(engine, backend, 'guests');
      await initGuestSource(engine, 'guests', [`${BROKER.kind}:${BROKER.id}`]);
      const put = (slug: string) => (tx: BrainEngine) => tx.putPage(slug, note('guest words'), { sourceId: 'guests' });
      const outsider = await refusal(writeAs(engine, OTHER, 'agent_written', true, put('notes/outsider')));
      const unattributed = await refusal(writeAs(engine, BROKER, 'agent_written', false, put('notes/plain')));
      const accepted = await refusal(writeAs(engine, BROKER, 'operator_curated', true, put('notes/guest')));
      const [stored] = await engine.readPageTrustRows({ keys: [{ source_id: 'guests', slug: 'notes/guest' }] });
      const rewrite = await refusal(writeAs(engine, OTHER, 'agent_written', true, tx => tx.putPage('notes/guest', note('rewritten'), { sourceId: 'guests' })));
      return { outsider, unattributed, accepted, tier: stored?.trust_tier ?? null, rewrite,
        written: (await engine.getPage('notes/outsider', { sourceId: 'guests' })) === null && (await engine.getPage('notes/plain', { sourceId: 'guests' })) === null };
    });

  parityTest('guest row rules: no fact, take or timeline row is stored in a guest source',
    { methods: ['upsertGuestSource', 'insertFacts', 'addTakesBatch', 'addTimelineEntry', 'putPage', 'applyTransactionSettings'] }, async (engine, backend) => {
      await createSource(engine, backend, 'guests');
      await initGuestSource(engine, 'guests', [`${BROKER.kind}:${BROKER.id}`]);
      await writeAs(engine, BROKER, 'agent_written', true, tx => tx.putPage('notes/guest', note('guest words'), { sourceId: 'guests' }));
      const page = (await engine.getPage('notes/guest', { sourceId: 'guests' }))!;
      const fact = await refusal(writeAs(engine, BROKER, 'agent_written', true, tx =>
        tx.insertFacts([{ fact: 'a claim', source: 'test', row_num: 1, source_markdown_slug: 'notes/guest' }], { source_id: 'guests' })));
      const take = await refusal(writeAs(engine, BROKER, 'agent_written', true, tx =>
        tx.addTakesBatch([{ page_id: Number(page.id), row_num: 1, claim: 'a take', kind: 'take', holder: 'world' }])));
      const timeline = await refusal(writeAs(engine, BROKER, 'agent_written', true, tx =>
        tx.addTimelineEntry('notes/guest', { date: '2026-01-01', summary: 'an event', detail: '', source: 'test' }, { sourceId: 'guests' })));
      return { fact, take, timeline };
    });

  parityTest('a guest source takes no local path', { methods: ['upsertGuestSource', 'attachSourcePath'] }, async (engine, backend) => {
    await createSource(engine, backend, 'guests');
    await initGuestSource(engine, 'guests', []);
    const attach = await refusal(engine.attachSourcePath('guests', '/srv/guests'));
    return { attach: attach?.replace(/^error: /, '') ?? null, path: (await engine.getSource('guests'))?.local_path ?? null };
  });
});
