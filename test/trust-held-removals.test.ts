/**
 * W1 prerequisites (#6783 §12 (a) and (b)), on PGLite and, with DATABASE_URL,
 * on Postgres.
 *
 * (a) A lower-tier write never deletes, replaces or deactivates a take or
 * timeline row more trusted than it: a remote put_page that drops or rewrites
 * a confirmed take, or drops a confirmed timeline row, keeps the row and files
 * a `forget` proposal; a remote takes_remove of a confirmed take is
 * forget_requires_owner; the takes reconcile never prunes a held row. The
 * owner's accept applies the write.
 *
 * (b) Lowering an input lowers what was derived from it (an agent page edit,
 * an owner tier change); raising it never promotes the derivative.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withCoordinatedWrite, withTrustBackfill, withTrustPromotion } from '../src/core/persistence/context.ts';
import { listTrustProposals } from '../src/core/trust/proposals.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { setRowTier } from '../src/core/trust/page-handlers.ts';
import { extractTakesFromDb } from '../src/core/cycle/extract-takes.ts';
import { materializeSegmentedBody } from '../src/core/page-body/ingest.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-held-removals-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };
const owner = { confirmation: { via: 'tty' as const } };

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
async function brain(engine: BrainEngine): Promise<Brain> {
  const sourceId = `held-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
const coordinated = (b: Brain, fn: (tx: BrainEngine) => Promise<unknown>) =>
  b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
/** The owner confirms a row (CEO-9), through the promotion seam. */
const confirm = (b: Brain, table: 'takes' | 'timeline_entries' | 'facts', id: number) =>
  coordinated(b, tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw(`UPDATE ${table} SET trust_tier='user_confirmed' WHERE id=$1`, [id])));
/** A row classified operator_curated through the deterministic backfill seam (CEO-10). */
const curate = (b: Brain, table: 'pages' | 'facts', id: number) => coordinated(b, async tx => {
  await tx.executeRaw(`UPDATE ${table} SET trust_tier='unknown' WHERE id=$1`, [id]);
  await withTrustBackfill(tx, () => tx.executeRaw(`UPDATE ${table} SET trust_tier='operator_curated' WHERE id=$1`, [id]));
});
const pageId = async (b: Brain, slug: string) => Number((await b.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, slug]))[0]!.id);
const takesOf = async (b: Brain, slug: string) => b.engine.executeRaw<{ id: number; row_num: number; claim: string; active: boolean; trust_tier: string }>(
  'SELECT id::int AS id, row_num, claim, active, trust_tier FROM takes WHERE page_id=$1 ORDER BY row_num', [await pageId(b, slug)]);
const remoteContent = async (b: Brain, slug: string) => operationsByName.get_page.handler(b.remote, { slug, include_content: true }) as Promise<Record<string, any>>;
/** A local agent's read: remote readers never see the takes fence (and a remote put_page merges it back), so a fence rewrite is a local agent write. */
const localContent = async (b: Brain, slug: string) => operationsByName.get_page.handler(b.local, { slug, include_content: true }) as Promise<Record<string, any>>;
const proposalsFor = async (b: Brain, table: string, id: number) => (await listTrustProposals(b.engine, { sourceId: b.sourceId }))
  .filter(p => p.target_table === table && p.target_id === id);

describe('held removals (W1 #6783 §12 (a))', () => {
  test('an agent put_page that drops or rewrites a confirmed take keeps it with a forget proposal; the owner accept applies the page', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'people/gina-example';
      await run(b.local, 'put_page', { slug, content: page('Gina', 'Gina.') });
      for (const claim of ['Gina will join acme-example', 'Gina moves to Lisbon', 'Gina ships the beta']) {
        await run(b.local, 'takes_add', { slug, claim, kind: 'bet', holder: 'world', weight: 0.6 });
      }
      const before = await takesOf(b, slug);
      for (const take of before.slice(0, 2)) await confirm(b, 'takes', take.id);
      const current = await localContent(b, slug);
      // Row 1 removed, row 2's claim rewritten in place, row 3 (agent_written, like the writer) removed.
      const edited = String(current.content).split('\n').filter(line => !line.includes('Gina will join acme-example') && !line.includes('Gina ships the beta'))
        .join('\n').replace('Gina moves to Lisbon', 'Gina moves to Porto');
      const put = await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision });
      expect(put.contested?.proposal_refs).toHaveLength(2);
      const after = await takesOf(b, slug);
      expect(after.find(t => t.id === before[0]!.id)).toMatchObject({ claim: 'Gina will join acme-example', active: true, trust_tier: 'user_confirmed' });
      expect(after.find(t => t.id === before[1]!.id)).toMatchObject({ claim: 'Gina moves to Lisbon', active: true, trust_tier: 'user_confirmed' });
      expect(after.some(t => t.id === before[2]!.id)).toBe(false);
      const [removed] = await proposalsFor(b, 'takes', before[0]!.id);
      const [replaced] = await proposalsFor(b, 'takes', before[1]!.id);
      expect(removed).toMatchObject({ action: 'forget', status: 'pending', proposer: 'fence_projection' });
      expect(removed!.before_state).toMatchObject({ change: 'removed', writer_tier: 'agent_written', row: { tier: 'user_confirmed' } });
      expect(replaced!.before_state).toMatchObject({ change: 'replaced' });
      // A republish of the same text files nothing new.
      const again = await localContent(b, slug);
      await run(b.local, 'put_page', { slug, content: `${String(again.content)}\nMore.`, expected_revision: again.revision });
      expect((await listTrustProposals(engine, { sourceId: b.sourceId })).length).toBe(2);
      expect((await decideTrustProposal(engine, removed!.id, 'accept', owner)).status).toBe('accepted');
      expect((await decideTrustProposal(engine, replaced!.id, 'accept', owner)).status).toBe('accepted');
      const settled = await takesOf(b, slug);
      expect(settled.some(t => t.claim === 'Gina will join acme-example')).toBe(false);
      expect(settled.find(t => t.row_num === before[1]!.row_num)).toMatchObject({ claim: 'Gina moves to Porto', trust_tier: 'agent_written' });
    }
  }), 120_000);

  test('a remote put_page that drops a confirmed timeline row keeps it with a forget proposal; the owner accept deletes it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'people/hana-example';
      await run(b.local, 'put_page', { slug, content: page('Hana', 'Hana.\n\n## Timeline\n\n- **2026-01-05** | note — Hana joined acme-example\n- **2026-02-07** | note — Hana moved to Kyoto') });
      const rows = await engine.executeRaw<{ id: number; summary: string }>('SELECT id::int AS id, summary FROM timeline_entries WHERE page_id=$1 ORDER BY date', [await pageId(b, slug)]);
      expect(rows).toHaveLength(2);
      await confirm(b, 'timeline_entries', rows[0]!.id);
      const current = await remoteContent(b, slug);
      const edited = String(current.content).split('\n').filter(line => !line.includes('Hana joined') && !line.includes('Hana moved')).join('\n');
      const put = await run(b.remote, 'put_page', { slug, content: edited, expected_revision: current.revision });
      expect(put.contested?.proposal_ref).toMatch(/^tp\d+$/);
      const kept = await engine.executeRaw<{ id: number; trust_tier: string }>('SELECT id::int AS id, trust_tier FROM timeline_entries WHERE page_id=$1', [await pageId(b, slug)]);
      expect(kept).toEqual([{ id: rows[0]!.id, trust_tier: 'user_confirmed' }]);
      const [proposal] = await proposalsFor(b, 'timeline_entries', rows[0]!.id);
      expect(proposal).toMatchObject({ action: 'forget', status: 'pending' });
      expect(proposal!.before_state).toMatchObject({ change: 'removed', writer_tier: 'agent_written' });
      expect((await decideTrustProposal(engine, proposal!.id, 'accept', owner)).status).toBe('accepted');
      expect(await engine.executeRaw('SELECT id FROM timeline_entries WHERE page_id=$1', [await pageId(b, slug)])).toHaveLength(0);
    }
  }), 120_000);

  test('a remote takes_remove of a confirmed take is forget_requires_owner with one proposal; the owner accept removes it from the fence and index', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'people/ivan-example';
      await run(b.local, 'put_page', { slug, content: page('Ivan', 'Ivan.') });
      const added = await run(b.local, 'takes_add', { slug, claim: 'Ivan will run the marathon', kind: 'bet', holder: 'world', weight: 0.5 });
      const [take] = await takesOf(b, slug);
      await confirm(b, 'takes', take!.id);
      let refused: any;
      for (let i = 0; i < 2; i++) {
        refused = await run(b.remote, 'takes_remove', { slug, row_num: added.row_num }).then(() => null, (error: unknown) => error);
        expect(refused?.code).toBe('forget_requires_owner');
      }
      expect((await takesOf(b, slug))[0]).toMatchObject({ id: take!.id, active: true });
      const proposals = await proposalsFor(b, 'takes', take!.id);
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({ action: 'forget', proposer: 'takes_remove' });
      expect((await decideTrustProposal(engine, proposals[0]!.id, 'accept', owner)).status).toBe('accepted');
      expect(await takesOf(b, slug)).toHaveLength(0);
      expect(String((await remoteContent(b, slug)).content)).not.toContain('Ivan will run the marathon');
    }
  }), 120_000);

  test('the owner accept of a held strike-through (or kind change) applies it to the take; it does not remove the take', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'people/lena-example';
      await run(b.local, 'put_page', { slug, content: page('Lena', 'Lena.') });
      for (const claim of ['Lena will move to Lima', 'Lena prefers tea']) await run(b.local, 'takes_add', { slug, claim, kind: 'bet', holder: 'world', weight: 0.6 });
      const before = await takesOf(b, slug);
      for (const take of before) await confirm(b, 'takes', take.id);
      const current = await localContent(b, slug);
      const edited = String(current.content).replace('Lena will move to Lima', '~~Lena will move to Lima~~').replace(/(\| Lena prefers tea \| )bet/, '$1take');
      expect(edited).not.toBe(String(current.content));
      const put = await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision });
      expect(put.contested?.proposal_refs).toHaveLength(2);
      const struck = (await proposalsFor(b, 'takes', before[0]!.id))[0]!;
      const rekinded = (await proposalsFor(b, 'takes', before[1]!.id))[0]!;
      expect(struck.before_state).toMatchObject({ change: 'deactivated' });
      expect(rekinded.before_state).toMatchObject({ change: 'replaced' });
      expect((await decideTrustProposal(engine, struck.id, 'accept', owner)).status).toBe('accepted');
      expect((await decideTrustProposal(engine, rekinded.id, 'accept', owner)).status).toBe('accepted');
      const after = await engine.executeRaw<{ row_num: number; claim: string; kind: string; active: boolean }>(
        'SELECT row_num, claim, kind, active FROM takes WHERE page_id=$1 ORDER BY row_num', [await pageId(b, slug)]);
      expect(after).toEqual([
        { row_num: before[0]!.row_num, claim: 'Lena will move to Lima', kind: 'bet', active: false },
        { row_num: before[1]!.row_num, claim: 'Lena prefers tea', kind: 'take', active: true },
      ]);
      const text = String((await localContent(b, slug)).content);
      expect(text).toContain('~~Lena will move to Lima~~');
      expect(text).toContain('Lena prefers tea');
    }
  }), 120_000);

  test('on a segmented page, the owner accept of held take and timeline changes applies them; the page and its rows agree', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      try {
        const slug = 'people/kai-example';
        const filler = Array.from({ length: 20_000 }, (_, i) => `Kai note line ${i} about the acme-example offsite and its agenda.`).join('\n');
        // The takes are added while the page is inline and a publish over 1 MiB promotes it.
        await run(b.local, 'put_page', { slug, content: page('Kai', 'Kai.\n\n## Timeline\n\n- **2026-01-05** | note — Kai joined acme-example\n- **2026-02-07** | note — Kai moved to Seoul') });
        for (const claim of ['Kai will lead the offsite', 'Kai ships the agenda']) await run(b.local, 'takes_add', { slug, claim, kind: 'bet', holder: 'world', weight: 0.6 });
        const storage = async () => (await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE id=$1', [await pageId(b, slug)]))[0]!.body_storage;
        const small = await localContent(b, slug);
        const big = String(small.content).replace('Kai.\n', `Kai.\n\n${filler}\n`);
        await run(b.local, 'put_page', { slug, content: big, expected_revision: small.revision });
        expect(await storage()).toBe('segmented');
        const takes = await takesOf(b, slug);
        const timeline = await engine.executeRaw<{ id: number; summary: string }>('SELECT id::int AS id, summary FROM timeline_entries WHERE page_id=$1 ORDER BY date', [await pageId(b, slug)]);
        expect(takes).toHaveLength(2);
        expect(timeline).toHaveLength(2);
        for (const take of takes) await confirm(b, 'takes', take.id);
        await confirm(b, 'timeline_entries', timeline[0]!.id);
        // A local agent publish drops take 1, rewrites take 2 and drops the confirmed timeline row.
        // A whole-body get_page refuses a segmented page (body: 'none' reads the revision), so the agent edits the text it published.
        const current = await operationsByName.get_page.handler(b.local, { slug, body: 'none' }) as Record<string, any>;
        const edited = big.split('\n').filter(line => !line.includes('Kai will lead the offsite') && !line.includes('Kai joined acme-example')).join('\n')
          .replace('Kai ships the agenda', 'Kai ships the budget');
        const put = await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision });
        expect(put.contested?.proposal_refs).toHaveLength(3);
        expect(await storage()).toBe('segmented');
        // takes_remove reads a segmented page within 24 MiB back whole, as it reads an inline page: the held rewrite of take 2
        // leaves its database row and the fence apart, so the remove refuses before any guard and files nothing.
        const refused = await run(b.remote, 'takes_remove', { slug, row_num: takes[1]!.row_num }).then(() => null, (error: unknown) => error) as any;
        expect(refused?.code).toBe('invalid_params');
        expect(String(refused?.message)).toContain("Row #2's database copy disagrees with the page's takes fence");
        const pending = (await listTrustProposals(engine, { sourceId: b.sourceId })).filter(p => p.status === 'pending');
        expect(pending.map(p => `${p.target_table}:${p.target_id}`).sort()).toEqual([`takes:${takes[0]!.id}`, `takes:${takes[1]!.id}`, `timeline_entries:${timeline[0]!.id}`].sort());
        for (const proposal of pending) expect((await decideTrustProposal(engine, proposal.id, 'accept', owner)).status).toBe('accepted');
        expect((await takesOf(b, slug)).map(t => [t.row_num, t.claim, t.active])).toEqual([[takes[1]!.row_num, 'Kai ships the budget', true]]);
        expect((await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1', [await pageId(b, slug)])).map(r => r.summary)).toEqual(['Kai moved to Seoul']);
        expect(await storage()).toBe('segmented');
        const stored = await materializeSegmentedBody(engine, await pageId(b, slug), b.sourceId);
        const text = `${stored.compiled_truth}\n${stored.timeline}`;
        for (const gone of ['Kai will lead the offsite', 'Kai ships the agenda', 'Kai joined acme-example']) expect(text).not.toContain(gone);
        expect(text).toContain('Kai ships the budget');
        expect(text).toContain('Kai moved to Seoul');
        expect(text).toContain('Kai note line 19999');
      } finally {
        await engine.setConfig('pages.segmented_storage', 'off');
      }
    }
  }), 240_000);

  test('the takes reconcile never prunes or overwrites a held take', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'people/jun-example';
      await run(b.local, 'put_page', { slug, content: page('Jun', 'Jun.') });
      await run(b.local, 'takes_add', { slug, claim: 'Jun will found a company', kind: 'bet', holder: 'world', weight: 0.5 });
      await run(b.local, 'takes_add', { slug, claim: 'Jun prefers Go', kind: 'take', holder: 'world', weight: 0.5 });
      const before = await takesOf(b, slug);
      for (const take of before) await confirm(b, 'takes', take.id);
      const current = await localContent(b, slug);
      const edited = String(current.content).split('\n').filter(line => !line.includes('Jun will found a company')).join('\n').replace('Jun prefers Go', 'Jun prefers Rust');
      await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision });
      await extractTakesFromDb(engine, { slugs: [slug], sourceId: b.sourceId, rebuild: true });
      const after = await takesOf(b, slug);
      expect(after.map(t => [t.id, t.claim, t.trust_tier])).toEqual(before.map(t => [t.id, t.claim, 'user_confirmed']));
      expect((await listTrustProposals(engine, { sourceId: b.sourceId })).filter(p => p.status === 'pending')).toHaveLength(2);
    }
  }), 120_000);
});

/** The v0.60.253.0 accept of a held take whose fence row kept its claim: an owner takes_remove bound to the proposal (what that release ran). */
async function acceptAsV253(b: Brain, proposalId: number, slug: string, rowNum: number) {
  const nonce = randomUUID();
  await b.engine.executeRaw(`UPDATE trust_proposals SET after_state = after_state || jsonb_build_object('accept_nonce', $2::text) WHERE id = $1`, [proposalId, nonce]);
  await submitPageMutation(b.local as never, { operation: 'takes_remove', params: { slug, source_id: b.sourceId, row_num: rowNum,
    trust_accept: proposalId, trust_accept_nonce: nonce, request_id: randomUUID() } });
}
async function repairCli(b: Brain, args: string[]): Promise<Record<string, any>> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await runRepairCommand(b.engine, [...args, '--source', b.sourceId, '--json']); } finally { console.log = original; process.stdout.write = write; }
  return JSON.parse(printed).results[0];
}

describe('gbrain repair accepted-takes (the v0.60.253.0 accept bug)', () => {
  test('a take the v0.60.253.0 accept removed stays gone through a republish and reconcile; the repair restores exactly the accepted row from the records (managed and unmanaged)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const [engine, managed] of engines.flatMap(e => [[e, true], [e, false]] as const)) {
      const b = await brain(engine);
      if (!managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const slug = 'people/mina-example';
      await run(b.local, 'put_page', { slug, content: page('Mina', 'Mina.') });
      for (const claim of ['Mina will move to Lima', 'Mina prefers tea', 'Mina ships the atlas']) await run(b.local, 'takes_add', { slug, claim, kind: 'bet', holder: 'world', weight: 0.6 });
      const before = await takesOf(b, slug);
      // Take 3 is graded in its fence (v0.60.253.0's takes_remove refused a resolved row); take 2 only in the database.
      await run(b.local, 'takes_resolve', { slug, row_num: before[2]!.row_num, quality: 'correct', resolved_at: '2026-10-01' });
      await coordinated(b, tx => tx.executeRaw(`UPDATE takes SET resolved_at='2026-10-02', resolved_quality='incorrect' WHERE id=$1`, [before[1]!.id]));
      for (const take of before) await confirm(b, 'takes', take.id);
      const current = await localContent(b, slug);
      const edited = String(current.content).replace('Mina will move to Lima', '~~Mina will move to Lima~~').replace(/(\| Mina prefers tea \| )bet/, '$1take')
        .replace(/(\| )(Mina ships the atlas)( \|)/, '$1~~$2~~$3');
      await run(b.local, 'put_page', { slug, content: edited, expected_revision: current.revision });
      const struck = (await proposalsFor(b, 'takes', before[0]!.id))[0]!;
      const rekinded = (await proposalsFor(b, 'takes', before[1]!.id))[0]!;
      const graded = (await proposalsFor(b, 'takes', before[2]!.id))[0]!;
      await acceptAsV253(b, struck.id, slug, before[0]!.row_num);
      await acceptAsV253(b, rekinded.id, slug, before[1]!.row_num);
      expect(((await acceptAsV253(b, graded.id, slug, before[2]!.row_num).then(() => null, (e: unknown) => e)) as Error | null)?.message).toBe('Resolved takes are immutable.');
      expect((await takesOf(b, slug)).map(t => t.claim)).toEqual(['Mina ships the atlas']);
      // Nothing brings them back on its own: the page no longer carries the rows.
      const again = await localContent(b, slug);
      expect(String(again.content)).not.toContain('Mina will move to Lima');
      await run(b.local, 'put_page', { slug, content: `${String(again.content)}\nMore.`, expected_revision: again.revision });
      await extractTakesFromDb(engine, { slugs: [slug], sourceId: b.sourceId } as never);
      expect((await takesOf(b, slug)).map(t => t.claim)).toEqual(['Mina ships the atlas']);
      // Preview lists both, writes nothing.
      const preview = await repairCli(b, ['accepted-takes']);
      expect(preview.preview_hash).toBeString();
      expect((preview.listing as Array<{ item: string; class: string }>).map(l => [l.item, l.class])).toEqual([
        [`${b.sourceId}:${slug}#${before[0]!.row_num}`, 'accepted_deactivated'], [`${b.sourceId}:${slug}#${before[1]!.row_num}`, 'accepted_replaced']]);
      expect((await takesOf(b, slug)).map(t => t.claim)).toEqual(['Mina ships the atlas']);
      const applied = await repairCli(b, ['accepted-takes', '--apply', '--expect', preview.preview_hash]);
      expect(applied.applied).toBe(2);
      const after = await engine.executeRaw<{ row_num: number; claim: string; kind: string; active: boolean; trust_tier: string; resolved_quality: string | null }>(
        'SELECT row_num, claim, kind, active, trust_tier, resolved_quality FROM takes WHERE page_id=$1 ORDER BY row_num', [await pageId(b, slug)]);
      // The tier is the accepted write's (what a correct accept leaves); take 2's database-only grade is in no record and stays lost.
      expect(after).toEqual([
        { row_num: before[0]!.row_num, claim: 'Mina will move to Lima', kind: 'bet', active: false, trust_tier: 'agent_written', resolved_quality: null },
        { row_num: before[1]!.row_num, claim: 'Mina prefers tea', kind: 'take', active: true, trust_tier: 'agent_written', resolved_quality: null },
        { row_num: before[2]!.row_num, claim: 'Mina ships the atlas', kind: 'bet', active: true, trust_tier: 'user_confirmed', resolved_quality: 'correct' },
      ]);
      const text = String((await localContent(b, slug)).content);
      expect(text).toContain('~~Mina will move to Lima~~');
      expect(text).toContain('| Mina prefers tea | take |');
      expect(text).not.toContain('(removed)');
      // A second preview finds nothing; the restored rows hold.
      expect((await repairCli(b, ['accepted-takes'])).listing ?? []).toEqual([]);
    }
  }), 240_000);
});

describe('derived-tier propagation (W1 #6783 §12 (b))', () => {
  test('an agent edit that lowers a page lowers the fact derived from it; an owner raise never promotes it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      const slug = 'notes/kiko-example';
      await run(b.local, 'put_page', { slug, content: page('Kiko', 'Kiko runs the lab.') });
      const input = await pageId(b, slug);
      await curate(b, 'pages', input);
      const fact = await run(b.local, 'remember', { fact: 'Kiko runs the lab', provenance: 'notes', entity: 'people/kiko-example' });
      const derived = Number(fact.id);
      await curate(b, 'facts', derived);
      await coordinated(b, tx => recordDerivationInputs(tx, { table: 'facts', id: derived, sourceId: b.sourceId }, [{ table: 'pages', id: input }]));
      const tier = async (table: string, id: number) => (await engine.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM ${table} WHERE id=$1`, [id]))[0]!.trust_tier;
      expect(await tier('facts', derived)).toBe('operator_curated');
      const current = await remoteContent(b, slug);
      await run(b.remote, 'put_page', { slug, content: String(current.content).replace('runs the lab', 'runs the lab and the press'), expected_revision: current.revision });
      expect(await tier('pages', input)).toBe('agent_written');
      expect(await tier('facts', derived)).toBe('agent_written');
      // The owner lowers the input further: the derivative follows. Raising it back never promotes the derivative.
      expect(await setRowTier(engine, { table: 'pages', id: input, sourceId: b.sourceId, tier: 'external_untrusted' })).toBe(true);
      expect(await tier('facts', derived)).toBe('external_untrusted');
      expect(await setRowTier(engine, { table: 'pages', id: input, sourceId: b.sourceId, tier: 'user_confirmed', ceiling: 'user_confirmed' })).toBe(true);
      expect(await tier('pages', input)).toBe('user_confirmed');
      expect(await tier('facts', derived)).toBe('external_untrusted');
      const [row] = await engine.executeRaw<{ write_origin: Record<string, any> }>('SELECT write_origin FROM facts WHERE id=$1', [derived]);
      expect(row!.write_origin.input_lowered).toMatchObject({ from: 'agent_written' });
    }
  }), 120_000);
});
