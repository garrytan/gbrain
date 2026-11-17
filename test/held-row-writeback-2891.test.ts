/**
 * GST-2891 write-back: a caller whose fact reads are world-only reads a page without its held rows, so a page it writes
 * back arrives without them. put_page restores each held row it left out from the stored page (never from the writer's text), so
 * the pending widening survives and the owner's accept still widens it; the owner's own writes and the local CLI's
 * stay as they were. edit_page's diff shows such a caller the page as get_page does, without the held rows.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import { testBackends } from './helpers/test-backends.ts';
import { heldProposalRef } from './helpers/held-proposal.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { importSegmented, pageContent } from './helpers/segmented-privacy-fixture.ts';
import { checkEnforcedWrite, enforcedRead, ENFORCED_MEMBER_ENV } from '../src/cli/enforced-member.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const OWNER = 'owner-example';
type Row = { rowNum: number; claim: string; kind: string; confidence: number; visibility: string; notability: string; active: boolean; context?: string };
const row = (n: number, claim: string, visibility = 'world'): Row => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const NOTES = '## Notes\n\nSomething here.\n';
const pageText = (title: string, rows: Row[], prose = 'Profile.', after = NOTES) =>
  '---\ntype: person\ntitle: ' + title + '\nvalid_from: 2020-01-01\n---\n# ' + title + '\n\n' + prose + '\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n\n' + after;
type Held = { slug: string; title: string; claim: string; canary: string; turin: string; tp: number };
type FactRow = { fact: string; visibility: string; row_num: number | null; expired: boolean };
type Who = 'local' | 'writer' | 'owner';

for (const kind of testBackends()) {
  describe('GST-2891 held rows on write-back (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: Who, op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      if (who === 'local') return (await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: 'default' })).content.map(c => c.text).join('\n');
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      return (await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] })).content.map(c => c.text).join('\n');
    }
    const page = async (who: Who, slug: string) => JSON.parse(await call(who, 'get_page', { slug, include_content: true })) as { content: string; revision: string };
    const stored = (slug: string) => call('local', 'get_page', { slug, include_content: true });
    const put = (who: Who, slug: string, content: string, revision: string) => call(who, 'put_page', { slug, content, expected_revision: revision, request_id: randomUUID() });
    const facts = (slug: string) => engine.executeRaw<FactRow>(
      'SELECT fact, visibility, row_num, expired_at IS NOT NULL AS expired FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id', ['default', slug]);
    const accept = async (tp: number) => (await decideTrustProposal(engine, tp, 'accept', { confirmation: { via: 'tty' as const } })).status;
    /** A page whose row 2 is a confirmed private fact and whose row 3 is the writer's world restatement of it, held until the owner accepts. */
    async function heldPage(name: string): Promise<Held> {
      const first = name[0]!.toUpperCase() + name.slice(1), canary = name + 'heldcanary';
      const held = { slug: 'people/' + name + '-example', title: first + ' Example', canary, claim: first + ' keeps bees ' + canary, turin: first + ' lives in Turin' };
      await call('local', 'put_page', { slug: held.slug, content: pageText(held.title, [row(1, held.turin), row(2, held.claim, 'private')]), request_id: randomUUID() });
      for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default', held.slug]))
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [r.id])), TEST_WRITE_ATTRIBUTION));
      const res = await call('writer', 'remember', { fact: held.claim, provenance: 'chat', entity: held.slug, request_id: randomUUID() });
      expect(res).not.toContain('proposal_ref');
      const tp = parseTrustProposalRef(await heldProposalRef(engine, 'default', held.claim))!;
      expect(await stored(held.slug)).toContain('| 3 | ' + held.claim + ' |');
      expect((await page('writer', held.slug)).content).not.toContain(canary);
      return { ...held, tp };
    }
    /** The held restatement is still row 3 of the stored page and of its facts, and the owner's accept widens it. */
    async function heldRowKept(h: Held) {
      expect(await stored(h.slug)).toContain('| 3 | ' + h.claim + ' |');
      const live = async () => (await facts(h.slug)).filter(f => f.fact === h.claim && !f.expired).map(f => [f.row_num, f.visibility]);
      expect(await live()).toEqual([[2, 'private'], [3, 'private']]);
      expect(await accept(h.tp)).toBe('accepted');
      expect(await live()).toEqual([[3, 'world']]);
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [OWNER]);
      const writer = await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      await readsUnscopedOnPurpose(engine, writer.id);
      const owner = await mintLegacyToken(engine, { name: 'owner', scopes: ['read', 'write'], takesHolders: ['world'] });
      await bindCredential(engine, { kind: 'token', id: owner.id }, { member: OWNER });
      Object.assign(tokens, { writer: writer.token, owner: owner.token });
      await setOwner(engine, OWNER);
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); }, 60_000);

    test('a get_page -> put_page round trip keeps the held row, and the owner\'s accept still widens it', async () => {
      const h = await heldPage('ada');
      const cur = await page('writer', h.slug);
      await put('writer', h.slug, cur.content.replace('Something here.', 'Something else.'), cur.revision);
      expect(await stored(h.slug)).toContain('Something else.');
      await heldRowKept(h);
    }, 180_000);

    test('a whole new body keeps the held row', async () => {
      const h = await heldPage('bea');
      const cur = await page('writer', h.slug);
      await put('writer', h.slug, pageText(h.title, [row(1, 'Bea lives in Milan')], 'A new profile.', '## Elsewhere\n\nNew notes.\n'), cur.revision);
      const body = await stored(h.slug);
      expect(body).toContain('Bea lives in Milan');
      expect(body).not.toContain(h.turin);
      await heldRowKept(h);
    }, 180_000);

    test('deleting the lines around the held row keeps it and honors the deletion of what the writer saw', async () => {
      const h = await heldPage('cai');
      const cur = await page('writer', h.slug);
      const lines = cur.content.split('\n');
      const cut = lines.filter(l => !l.includes(h.turin) && l !== '## Notes' && l !== 'Something here.');
      expect(cut.length).toBe(lines.length - 3);
      await put('writer', h.slug, cut.join('\n'), cur.revision);
      const body = await stored(h.slug);
      expect(body).not.toContain(h.turin);
      expect(body).not.toContain('Something here.');
      await heldRowKept(h);
    }, 180_000);

    test('a row 3 the writer sends with the held claim cannot reword it: the stored cells are restored, and the held row is not duplicated', async () => {
      const h = await heldPage('dov');
      const heldLine = () => stored(h.slug).then(s => (JSON.parse(s) as { compiled_truth: string }).compiled_truth.split('\n').filter(l => l.startsWith('| 3 | ')));
      const before = await heldLine();
      const cur = await page('writer', h.slug);
      await put('writer', h.slug, pageText(h.title, [row(1, h.turin), { ...row(3, h.claim), confidence: 0.5, notability: 'high', context: 'written by the writer' }]), cur.revision);
      const body = (JSON.parse(await stored(h.slug)) as { compiled_truth: string }).compiled_truth;
      expect(body).not.toContain('written by the writer');
      expect(await heldLine()).toEqual(before);
      expect(body.split('| ' + h.claim + ' |').length - 1).toBe(2);
      await heldRowKept(h);
    }, 180_000);

    test('the owner\'s own write and the local CLI\'s remove the held row as on master', async () => {
      for (const who of ['owner', 'local'] as const) {
        const h = await heldPage(who === 'owner' ? 'eve' : 'fay');
        const cur = await page(who, h.slug);
        expect(cur.content).toContain('| 3 | ' + h.claim + ' |');
        await put(who, h.slug, cur.content.split('\n').filter(l => !l.startsWith('| 3 | ')).join('\n'), cur.revision);
        expect(await stored(h.slug)).not.toContain('| 3 | ' + h.claim + ' |');
        expect((await facts(h.slug)).filter(f => f.fact === h.claim).map(f => [f.row_num, f.visibility, f.expired])).toEqual([[2, 'private', false], [null, 'private', true]]);
        expect(await accept(h.tp)).toBe('superseded');
      }
    }, 240_000);

    test('an enforced member (GBRAIN_ENFORCED_MEMBER) reads without the held row, and its put_page and edit_page keep it and leave it out of the diff', async () => {
      // The held row is the page's only copy of the claim in the fence (a remote put_page restating private row 2 as world), so no private fence row makes the member's write refuse.
      const h = { slug: 'people/jon-example', title: 'Jon Example', claim: 'Jon keeps bees jonheldcanary', canary: 'jonheldcanary', turin: 'Jon lives in Turin' };
      await call('local', 'put_page', { slug: h.slug, content: pageText(h.title, [row(1, h.turin), row(2, h.claim, 'private')]), request_id: randomUUID() });
      for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', ['default', h.slug]))
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [r.id])), TEST_WRITE_ATTRIBUTION));
      const before = await page('writer', h.slug);
      const restated = JSON.parse(await put('writer', h.slug, pageText(h.title, [row(1, h.turin), row(2, h.claim)]), before.revision)) as { contested?: { proposal_ref: string } };
      expect(restated.contested).toBeUndefined();
      const tp = parseTrustProposalRef(await heldProposalRef(engine, 'default', h.claim))!;
      expect(await stored(h.slug)).toContain('| 2 | ' + h.claim + ' | fact | 1.0 | world |');
      const live = async () => (await facts(h.slug)).filter(f => f.fact === h.claim && !f.expired).map(f => f.visibility);
      const liveBefore = await live();
      expect(liveBefore.length).toBeGreaterThan(0);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', ['member-example']);
      // The CLI runs a checked write through the operation's handler, as main.ts does (never the MCP dispatcher).
      const cli = async (op: string, params: Record<string, unknown>) => JSON.stringify(await operationsByName[op]!.handler({ engine, config: { engine: engine.kind, embedding_disabled: true },
        sourceId: 'default', dryRun: false, remote: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext, params));
      const unwrap = (c: string) => c.includes('```text\n') ? c.slice(c.indexOf('```text\n') + 8, c.lastIndexOf('\n```')) : c;
      await withEnv({ [ENFORCED_MEMBER_ENV]: 'member-example' }, async () => {
        __resetPrivateVisibilityCacheForTests();
        const read = await enforcedRead(engine, 'get', 'get_page', { slug: h.slug, include_content: true }, { sourceId: 'default' }) as { content: string; revision: string };
        expect(read.content).not.toContain(h.canary);
        const putParams: Record<string, unknown> = { slug: h.slug, content: unwrap(read.content).replace('Something here.', 'Something else.'), expected_revision: read.revision, request_id: randomUUID() };
        await checkEnforcedWrite(engine, 'put', 'put_page', putParams, 'default');
        await cli('put_page', putParams);
        expect(await stored(h.slug)).toContain('Something else.');
        const editParams: Record<string, unknown> = { slug: h.slug, expected_revision: (await page('local', h.slug)).revision, edits: [{ old_text: '## Notes', new_text: '## More notes' }], request_id: randomUUID() };
        await checkEnforcedWrite(engine, 'edit', 'edit_page', editParams, 'default');
        const edited = await cli('edit_page', editParams);
        expect(edited).toContain('## More notes');
        expect(edited).not.toContain(h.canary);
      });
      expect(await stored(h.slug)).toContain('| 2 | ' + h.claim + ' | fact | 1.0 | world |');
      expect(await live()).toEqual(liveBefore);
      expect(await accept(tp)).toBe('accepted');
      expect(await live()).toEqual(['world']);
    }, 240_000);

    test('edit_page\'s diff leaves the held row out for the writer; the owner and the local CLI still see it', async () => {
      for (const who of ['writer', 'owner', 'local'] as const) {
        const h = await heldPage(who === 'writer' ? 'gus' : who === 'owner' ? 'hal' : 'ivy');
        const cur = await page(who, h.slug);
        const out = await call(who, 'edit_page', { slug: h.slug, expected_revision: cur.revision, edits: [{ old_text: '## Notes', new_text: '## More notes' }], request_id: randomUUID() });
        expect(out).toContain('## More notes');
        expect({ who, leaks: out.includes(h.canary) }).toEqual({ who, leaks: who !== 'writer' });
      }
    }, 240_000);
  });

  describe('GST-2891 edit_page diff on a segmented page (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    let token = '';
    const slug = 'notes/segmented-edit-example';
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      const facts = '## Facts\n\n' + renderFactsTable([row(1, 'Segment keeps bees ibexworld'), row(2, 'Segment keeps bees ibexheld')] as never) + '\n\n' + NOTES;
      await importSegmented(engine, slug, pageContent(Array.from({ length: 32_000 }, (_, i) => 'Line ' + i + ' of plain notes about the garden.').join('\n') + '\n\n' + facts));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
        "INSERT INTO facts (source_id, fact, kind, visibility, source, source_markdown_slug, row_num) VALUES ('default', $1, 'fact', 'private', 'fixture', $2, 2)",
        ['Segment keeps bees ibexheld', slug]), TEST_WRITE_ATTRIBUTION));
      const writer = await mintLegacyToken(engine, { name: 'writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      await readsUnscopedOnPurpose(engine, writer.id);
      token = writer.token;
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); }, 60_000);

    test('the writer\'s diff leaves the held row out; the local CLI\'s keeps it', async () => {
      const edit = async (remote: boolean, from: string, to: string) => {
        __resetPrivateVisibilityCacheForTests();
        const { revision } = JSON.parse((await dispatchToolCall(engine, 'get_page', { slug, body: 'none' }, { remote: false, sourceId: 'default' })).content.map(c => c.text).join('\n')) as { revision: string };
        const auth = remote ? await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) }).verifyAccessToken(token) as unknown as AuthInfo : undefined;
        const ctx = remote ? { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] } : { remote: false, sourceId: 'default' };
        return (await dispatchToolCall(engine, 'edit_page', { slug, expected_revision: revision, edits: [{ old_text: from, new_text: to }], request_id: randomUUID() }, ctx as never)).content.map(c => c.text).join('\n');
      };
      const remote = await edit(true, '## Notes', '## More notes');
      expect(remote).toContain('## More notes');
      expect(remote).not.toContain('ibexheld');
      expect(await edit(false, '## More notes', '## Notes')).toContain('ibexheld');
    }, 240_000);
  });
}
