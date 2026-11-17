/**
 * GST-2900: a held private restatement stays hidden from a caller who cannot read the private copy.
 * - think gathers no fence row held from a world-only caller, as gathered pages or as delivered evidence (GST-2891's
 *   page reads, for think);
 * - the reply to a held write (remember, put_page), its outcome and receipt copies, and get_write_request read as a plain
 *   save for such a caller, while a caller who reads the private copy still gets the proposal ref;
 * - a world fence row restating a private fact of its own entity kept on another page is held like a same-page one.
 * The owner and the local CLI read and write exactly as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { decideTrustProposal, listTrustProposals } from '../src/core/trust/proposals.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { runThink } from '../src/core/think/index.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { importSegmented, pageContent, privacyText } from './helpers/segmented-privacy-fixture.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { mulberry32 } from './helpers/seeded-random.ts';

const home = mkdtempSync(join(tmpdir(), 'gst2900-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
async function brain(engine: BrainEngine, managed: boolean): Promise<Brain> {
  const sourceId = 'gst2900-' + randomUUID().slice(0, 8);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.setConfig('brain.audience', 'shared');
  await engine.setConfig('think.return_unit', '');
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: 'token-' + sourceId, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await readsUnscopedOnPurpose(engine, minted.id);
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) => {
  __resetPrivateVisibilityCacheForTests();
  return operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
};
/** The same call as an owner-bound remote caller (what dispatch sets for a credential bound to the owner). */
const asOwner = (ctx: OperationContext, op: string, params: Record<string, unknown>) => withCallerAccess({ owner: true }, () => run(ctx, op, params));
const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const note = (title: string, rows: ReturnType<typeof row>[]) => '---\ntype: person\ntitle: ' + title + '\n---\n# ' + title + '\n\nProfile of ' + title + ', who keeps bees.\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n';
const rowsOf = (b: Brain, claim: string) => b.engine.executeRaw<{ id: number; visibility: string; entity_slug: string | null; slug: string | null }>(
  'SELECT id::int AS id, visibility, entity_slug, source_markdown_slug AS slug FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', [b.sourceId, claim]);
async function confirmAll(b: Brain, where: string, args: unknown[]) {
  for (const r of await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND ' + where, [b.sourceId, ...args]))
    await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [r.id])), TEST_WRITE_ATTRIBUTION));
}
const remoteSees = async (b: Brain, slug: string, claim: string) => JSON.stringify(await run(b.remote, 'recall', { entity: slug })).includes(claim);
const proposalsOf = async (b: Brain) => (await listTrustProposals(b.engine, { sourceId: b.sourceId })).filter(p => p.action === 'supersede_fact');
const owner = { confirmation: { via: 'tty' as const } };
/** The keys of a write reply and of its outcome and receipt copies, without the per-write values. */
const shape = (reply: Record<string, any>) => ({ top: Object.keys(reply).sort(), outcome: Object.keys(reply.outcome ?? {}).sort(),
  receipt: Object.keys(reply.write_request ?? {}).sort(), receiptOutcome: Object.keys(reply.write_request?.outcome ?? {}).sort() });

/** A person page with a confirmed private fact. */
async function privateOnPage(engine: BrainEngine, managed: boolean, slug: string, claim: string) {
  const b = await brain(engine, managed);
  await run(b.local, 'put_page', { slug, content: note('Lia Example', [row(1, 'Lia lives in Turin'), row(2, claim, 'private')]) });
  await confirmAll(b, 'source_markdown_slug=$2', [slug]);
  return b;
}
/** The private fact restated as a world fence row by a remote world-only put_page: held (GST-2511), its cell world on the page. */
async function heldPut(engine: BrainEngine, managed: boolean, slug: string, claim: string) {
  const b = await privateOnPage(engine, managed, slug, claim);
  const current = await run(b.remote, 'get_page', { slug, include_content: true });
  const held = await run(b.remote, 'put_page', { slug, expected_revision: current.revision,
    content: note('Lia Example', [row(1, 'Lia lives in Turin'), row(3, claim)]) });
  expect((await rowsOf(b, claim)).map(r => r.visibility)).toEqual(['private', 'private']);
  return { b, held };
}
/** The private fact restated by a remote world-only remember: held (GST-2875). */
async function heldRemember(engine: BrainEngine, managed: boolean, slug: string, claim: string) {
  const b = await privateOnPage(engine, managed, slug, claim);
  const held = await run(b.remote, 'remember', { fact: claim, provenance: 'chat', entity: slug });
  expect((await rowsOf(b, claim)).map(r => r.visibility)).toEqual(['private', 'private']);
  return { b, held };
}

const arms = [0, 1].flatMap(engineIndex => [true, false].map(managed => ({ engineIndex, managed })));
const label = (a: { engineIndex: number; managed: boolean }) => (a.engineIndex ? 'postgres' : 'pglite') + ', ' + (a.managed ? 'managed' : 'unmanaged');
const each = (name: string, fn: (engine: BrainEngine, managed: boolean) => Promise<void>) => {
  for (const a of arms) test(name + ' (' + label(a) + ')', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines.slice(a.engineIndex, a.engineIndex + 1)) await fn(engine, a.managed);
  }), 180_000);
};

describe('GST-2900: think', () => {
  each('think shows a held restatement only to callers who read the private copy, as gathered pages and as delivered evidence', async (engine, managed) => {
    const slug = 'people/lia-example', claim = 'Lia keeps bees zebracornheld';
    const { b } = await heldPut(engine, managed, slug, claim);
    expect(JSON.stringify(await run(b.local, 'get_page', { slug, include_content: true }))).toContain(claim + ' | fact | 1.0 | world');
    const prompts: string[] = [];
    const client = { async create(params: { messages: Array<{ content: unknown }> }) {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    const prompt = async (remote: boolean) => {
      __resetPrivateVisibilityCacheForTests();
      await runThink(engine, { question: 'Lia keeps bees', client: client as never, remote, sourceId: b.sourceId });
      return prompts.at(-1)!;
    };
    for (const unit of ['', 'page', 'window']) {
      await engine.setConfig('think.return_unit', unit);
      const seen = { unit, worldOnly: await prompt(true), local: await prompt(false), ownerBound: await withCallerAccess({ owner: true }, () => prompt(true)) };
      expect({ unit, gathered: seen.worldOnly.includes('Lia lives in Turin'), worldOnly: seen.worldOnly.includes('zebracornheld'),
        local: seen.local.includes('zebracornheld'), ownerBound: seen.ownerBound.includes('zebracornheld') })
        .toEqual({ unit, gathered: true, worldOnly: false, local: true, ownerBound: true });
      const keyless = JSON.stringify(await run(b.remote, 'think', { question: 'Lia keeps bees' }));
      expect({ unit, gathered: keyless.includes('Lia lives in Turin'), leaks: keyless.includes('zebracornheld') }).toEqual({ unit, gathered: true, leaks: false });
    }
  });
});

describe('GST-2900: a credential with a private-facts grant', () => {
  each('reads the held row in think, get_page and search, as before GST-2891; a world-only credential does not', async (engine, managed) => {
    const slug = 'people/lia-example', claim = 'Lia keeps bees wombatheld';
    const { b } = await heldPut(engine, managed, slug, claim);
    const granted = { ...b.remote, auth: { ...b.remote.auth!, privateFacts: { mode: 'granted_sources' as const, sources: [b.sourceId] } } };
    const asGranted = <T>(fn: () => Promise<T>) => withCallerAccess({ privateFactSources: [b.sourceId] }, fn);
    const prompts: string[] = [];
    const client = { async create(params: { messages: Array<{ content: unknown }> }) {
      prompts.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: '{"answer":"ok","citations":[],"gaps":[]}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } };
    const prompt = async () => {
      __resetPrivateVisibilityCacheForTests();
      await runThink(engine, { question: 'Lia keeps bees', client: client as never, remote: true, sourceId: b.sourceId });
      return prompts.at(-1)!;
    };
    const reads = async (read: <T>(fn: () => Promise<T>) => Promise<T>, ctx: OperationContext) => ({
      think: (await read(prompt)).includes('wombatheld'),
      get_page: JSON.stringify(await read(() => run(ctx, 'get_page', { slug, include_content: true }))).includes('wombatheld'),
      search: JSON.stringify(await read(() => run(ctx, 'search', { query: 'wombatheld' }))).includes('wombatheld'),
    });
    expect(await reads(asGranted, granted)).toEqual({ think: true, get_page: true, search: true });
    expect(await reads(fn => fn(), b.remote)).toEqual({ think: false, get_page: false, search: false });
  });
});

describe('GST-2900: the reply to a held write', () => {
  each('a held remember reads as a plain save to a world-only writer, on the reply, its copies and get_write_request; an owner-bound caller keeps the ref', async (engine, managed) => {
    const slug = 'people/lia-example', claim = 'Lia keeps bees quokkaheld';
    const { b, held } = await heldRemember(engine, managed, slug, claim);
    const saved = await run(b.remote, 'remember', { fact: 'Lia drinks green tea', provenance: 'chat', entity: slug });
    const [proposal] = await proposalsOf(b);
    expect(proposal).toBeDefined();
    expect(JSON.stringify(held)).not.toContain('contested');
    expect(JSON.stringify(held)).not.toContain('tp' + proposal!.id);
    expect(shape(held)).toEqual(shape(saved));
    expect({ status: held.status, visibility: held.visibility }).toEqual({ status: saved.status, visibility: saved.visibility });
    const receipt = await run(b.remote, 'get_write_request', { request_id: held.request_id });
    expect(JSON.stringify(receipt)).not.toContain('contested');
    expect(shape(receipt)).toEqual(shape(await run(b.remote, 'get_write_request', { request_id: saved.request_id })));
    const listed = JSON.stringify(await run(b.remote, 'list_write_requests', {}));
    expect(listed).not.toContain('contested');
    expect((await asOwner(b.remote, 'get_write_request', { request_id: held.request_id })).outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
    expect((await run(b.local, 'get_write_request', { request_id: held.request_id })).outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
    const ownerHeld = await asOwner(b.remote, 'remember', { fact: 'Lia keeps bees ownerheld', provenance: 'chat', entity: slug });
    expect(ownerHeld.contested).toBeUndefined();
  });

  each('an owner-bound writer still gets the proposal ref of its held restatement', async (engine, managed) => {
    const slug = 'people/lia-example', claim = 'Lia keeps bees ownerboundheld';
    const b = await privateOnPage(engine, managed, slug, claim);
    const res = await asOwner(b.remote, 'remember', { fact: claim, provenance: 'chat', entity: slug });
    const [proposal] = await proposalsOf(b);
    expect(proposal).toBeDefined();
    expect(res.contested?.proposal_ref).toBe('tp' + proposal!.id);
    expect(res.outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
    expect(res.write_request?.outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
  });

  each('a writer whose credential reads private facts in the source still gets the proposal ref on the write reply', async (engine, managed) => {
    const slug = 'people/lia-example', claim = 'Lia keeps bees grantedheld';
    const b = await privateOnPage(engine, managed, slug, claim);
    const granted = { ...b.remote, auth: { ...b.remote.auth!, privateFacts: { mode: 'granted_sources' as const, sources: [b.sourceId] } } };
    const res = await run(granted, 'remember', { fact: claim, provenance: 'chat', entity: slug });
    const [proposal] = await proposalsOf(b);
    expect(proposal).toBeDefined();
    expect(res.contested?.proposal_ref).toBe('tp' + proposal!.id);
    expect(res.write_request?.outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
    const read = await withCallerAccess({ privateFactSources: [b.sourceId] }, () => run(granted, 'get_write_request', { request_id: res.request_id }));
    expect(read.outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
  });

  each('a held put_page reads as a plain save to a world-only writer', async (engine, managed) => {
    const slug = 'people/lia-example', claim = 'Lia keeps bees numbatheld';
    const { b, held } = await heldPut(engine, managed, slug, claim);
    const [proposal] = await proposalsOf(b);
    expect(proposal).toBeDefined();
    expect(JSON.stringify(held)).not.toContain('contested');
    expect(JSON.stringify(await run(b.remote, 'get_write_request', { request_id: held.request_id }))).not.toContain('contested');
    expect(await remoteSees(b, slug, claim)).toBe(false);
    expect((await asOwner(b.remote, 'get_write_request', { request_id: held.request_id })).outcome?.contested?.proposal_ref).toBe('tp' + proposal!.id);
  });
});

describe('GST-2900: a restatement on another page about the same entity', () => {
  each('a world fence row restating a private fact of its entity kept off its page is held until the owner accepts', async (engine, managed) => {
    const slug = 'people/ada-example', claim = 'Ada keeps bees wombatheld';
    const b = await brain(engine, managed);
    await run(b.local, 'remember', { fact: claim, provenance: 'chat', entity: slug, visibility: 'private' });
    const [copy] = await rowsOf(b, claim);
    expect(copy).toMatchObject({ visibility: 'private', entity_slug: slug });
    expect(copy!.slug).not.toBe(slug);
    await confirmAll(b, 'id=$2', [copy!.id]);
    const res = await run(b.remote, 'put_page', { slug, content: note('Ada Example', [row(1, 'Ada lives in Oslo'), row(2, claim)]) });
    expect(JSON.stringify(res)).not.toContain('contested');
    const rows = await rowsOf(b, claim);
    expect(rows.map(r => ({ visibility: r.visibility, onPage: r.slug === slug }))).toEqual([{ visibility: 'private', onPage: false }, { visibility: 'private', onPage: true }]);
    expect(await remoteSees(b, slug, claim)).toBe(false);
    expect(JSON.stringify(await run(b.remote, 'get_page', { slug, include_content: true }))).not.toContain(claim);
    expect(JSON.stringify(await run(b.local, 'get_page', { slug, include_content: true }))).toContain(claim);
    const granted = { ...b.remote, auth: { ...b.remote.auth!, privateFacts: { mode: 'granted_sources' as const, sources: [b.sourceId] } } };
    const grantedRead = (op: string, params: Record<string, unknown>) => withCallerAccess({ privateFactSources: [b.sourceId] }, () => run(granted, op, params));
    expect({ get_page: JSON.stringify(await grantedRead('get_page', { slug, include_content: true })).includes(claim),
      search: JSON.stringify(await grantedRead('search', { query: 'wombatheld' })).includes(claim) }).toEqual({ get_page: false, search: false });
    const [proposal] = await proposalsOf(b);
    expect(proposal).toMatchObject({ target_id: copy!.id, related_id: rows[1]!.id });
    expect((await decideTrustProposal(engine, proposal!.id, 'accept', owner)).status).toBe('accepted');
    expect(await remoteSees(b, slug, claim)).toBe(true);
  });

  each('a world row about another entity stays unheld', async (engine, managed) => {
    const claim = 'Keeps bees on the roof koalaunheld';
    const b = await brain(engine, managed);
    await run(b.local, 'remember', { fact: claim, provenance: 'chat', entity: 'people/ada-example', visibility: 'private' });
    await confirmAll(b, 'fact=$2', [claim]);
    const res = await run(b.remote, 'put_page', { slug: 'people/ben-example', content: note('Ben Example', [row(1, claim)]) });
    expect(res.contested).toBeUndefined();
    expect((await rowsOf(b, claim)).map(r => r.visibility)).toEqual(['private', 'world']);
    expect(await proposalsOf(b)).toEqual([]);
  });
});

/** GST-2900: a segmented page's size, as a world-only caller is told it, leaves the held row out like its windows do. */
for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe('GST-2900: segmented page size (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const filler = privacyText(mulberry32(2900), 1_400_000, { keys: false });
    const facts = (rows: ReturnType<typeof row>[]) => '## Facts\n\n' + renderFactsTable(rows as never) + '\n';
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await importSegmented(engine, 'notes/held-size', pageContent(filler + facts([row(1, 'Size keeps bees okapiworld'), row(2, 'Size keeps bees okapiheld')])));
      await importSegmented(engine, 'notes/plain-size', pageContent(filler + facts([row(1, 'Size keeps bees okapiworld')])));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        "INSERT INTO facts (source_id, fact, kind, visibility, source, source_markdown_slug, row_num) VALUES ('default', $1, 'fact', 'private', 'fixture', $2, 2)",
        ['Size keeps bees okapiheld', 'notes/held-size']), TEST_WRITE_ATTRIBUTION));
    }, 300_000);
    afterAll(async () => { await close(); });
    const call = async (remote: boolean, op: string, params: Record<string, unknown>) => {
      __resetPrivateVisibilityCacheForTests();
      return (await dispatchToolCall(engine, op, params, { remote, sourceId: 'default' })).content.map(c => c.text).join('\n');
    };
    const sizes = (text: string) => [...text.matchAll(/total_bytes\\?":\s*(\d+)/g)].map(m => Number(m[1]));
    test('get_page and get_versions report the held page as large as the page without the row; the local CLI is told the stored size', async () => {
      const read = async (remote: boolean, slug: string) => sizes(await call(remote, 'get_page', { slug, include_content: true }))[0];
      const held = await read(true, 'notes/held-size'), plain = await read(true, 'notes/plain-size');
      expect(held).toBeGreaterThan(1_000_000);
      expect(held).toBe(plain);
      const stored = Number(/stores its (\d+)-byte/.exec(await call(false, 'get_page', { slug: 'notes/held-size', include_content: true }))?.[1]);
      expect(stored).toBeGreaterThan(held!);
      const versions = async (slug: string) => {
        await engine.createVersion(slug, { sourceId: 'default' });
        return sizes(await call(true, 'get_versions', { slug }));
      };
      const [heldVersion] = await versions('notes/held-size');
      const [plainVersion] = await versions('notes/plain-size');
      expect(heldVersion).toBeGreaterThan(1_000_000);
      expect(heldVersion).toBe(plainVersion);
    }, 300_000);
  });
}
