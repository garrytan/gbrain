/**
 * GBRA-95 (N14, gbrain-evals#193): forget on a page over the single-string ceiling (PAGE_MAX_BYTES, 24 MiB).
 *
 * 1. Protects: a Markdown file over 24 MiB that carries a facts fence and a takes fence imports streamed (and an upload
 *    over 24 MiB commits) instead of being held `file_too_large` / refused `request_too_large`, with each fence region
 *    normalized and checked against withdrawals on its own (page-body/streamed-fences.ts). forget_fact then works end to
 *    end on the page: the fence row is struck in the stored body (content_hash of the reconstructed body), the fact
 *    leaves active memory, and the takes fence is untouched; a re-import (or an upload replace) of the original,
 *    unstruck bytes keeps the row struck; after purge_fact the row is gone from the stored fence and a re-import of
 *    the original bytes cannot bring it back. In the upload arm a remote (MCP) create of the page is refused
 *    `permission_denied` (remote writers change takes through the takes operations, as put_page enforces), so the
 *    trusted local writer creates it and forgets the fact (a remote forget of its owner-written rows asks the owner),
 *    and a remote replace is refused by design (the stored takes fence is hidden from remote reads), so the replace runs
 *    locally. A remote upload replace of
 *    a page whose quoted facts fences (a world-only one directly followed by one with a private row) hide a row is
 *    refused `upload_protected_content` and writes nothing.
 * 2. Fails when: the streamed importer holds a fenced body (master before GBRA-95: `fenced` set on the first
 *    `gbrain:facts:begin`, then `file_too_large`), a re-import of the stale file revives the withdrawn or purged row, a
 *    remote upload adds a takes fence, or a remote replace drops a quoted fence's private row.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The page is the smallest that takes the streamed path:
 *    PAGE_MAX_BYTES plus 64 KiB.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { runExtractFacts } from '../../src/core/cycle/extract-facts.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../../src/core/takes-fence.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MiB = 1024 ** 2;
const PART_CHARS = 3_900_000;
const FORGOTTEN = 'Prefers the aisle seat on long flights';
const KEPT = 'Walks to the office on Fridays';
const TAKE = 'Widgets will sell out by spring';
const op = (name: string) => operations.find(o => o.name === name)!;
const hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const filler = conversationBody(PAGE_MAX_BYTES + 64 * 1024, { seed: 95 });

/** A note just over the ceiling with a facts fence (two world rows) and a takes fence at its head. */
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n# ${title}\n\n${fences}\n\n${filler}\n`;
const fences = `## Facts\n\n${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${FORGOTTEN} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | ${KEPT} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
${FACTS_FENCE_END}\n\n## Takes\n\n${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | ${TAKE} | take | brain | 0.5 | 2026-07 | notes |
${TAKES_FENCE_END}`;

const rowOf = (body: string, claim: string) => body.split('\n').find(line => line.includes(claim)) ?? null;

for (const kind of testBackends()) {
  describe(`forget on a fenced page over the single-string ceiling (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let cli: LocalRegistration;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-streamed-fences-'));
    const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

    const ctx = (remote: boolean): OperationContext => ({
      engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default',
      ...(remote ? { transport: 'http', inboundFrameBytes: 4 * MiB, auth: { token: 'fixture', clientId: 'fence-upload', principal: { kind: 'oauth_client', id: 'fence-upload' },
        scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] } } : {}) } as unknown as OperationContext);
    /** One operation; a local call runs as the registered CLI writer. A write still pending after one wait is replayed with its request_id. */
    const call = async (name: string, params: Record<string, unknown>, remote: boolean) => withEnv(env, async () => {
      const run = () => op(name).handler(ctx(remote), params) as Promise<Record<string, any>>;
      for (let attempt = 0; ; attempt++) {
        try { return remote ? await run() : await withVerifiedLocalRegistration(engine, cli, run); }
        catch (error) { if (!(error instanceof OperationError) || error.code !== 'write_pending' || attempt > 40) throw error; }
      }
    });
    const upload = async (text: string, slug: string, remote: boolean, over: Record<string, unknown> = {}) => {
      const session = await call('begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: hex(text), request_id: randomUUID(), ...over }, remote);
      for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
        const piece = text.slice(at, at + PART_CHARS);
        await call('upload_page_part', { upload_id: session.upload_id, part, text: piece, part_sha256: hex(piece) }, remote);
      }
      return call('commit_page_upload', { upload_id: session.upload_id, wait_ms: 30_000 }, remote);
    };
    const importFile = async (slug: string, text: string) => withEnv(env, async () => {
      const path = join(home, `${slug.replace('/', '-')}.md`);
      writeFileSync(path, text);
      return importFromFile(engine, path, `${slug}.md`, { sourceId: 'default', noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
    });
    const factRows = async (slug: string) => engine.executeRaw<{ id: number; fact: string; active: boolean }>(
      'SELECT id, fact, expired_at IS NULL AS active FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY id', ['default', slug]);
    const reconcile = async (slug: string) => withEnv(env, () => runExtractFacts(engine, { sourceId: 'default', slugs: [slug] }));
    /** The stored body read back from its segments, after checking the page row's content_hash is that body's. */
    const storedTruth = async (slug: string) => {
      const { page: row, body, hash } = await reconstructedPage(engine, slug);
      expect(row.body_storage).toBe('segmented');
      expect(row.content_hash).toBe(hash);
      return body.compiled_truth;
    };
    const forgottenFact = async (slug: string) => {
      await reconcile(slug);
      const rows = await factRows(slug);
      expect(rows.filter(row => row.active).map(row => row.fact).sort()).toEqual([KEPT, FORGOTTEN].sort());
      return Number(rows.find(row => row.fact === FORGOTTEN)!.id);
    };
    /** Forgotten: struck in the stored fence and inactive in the facts table, even after the fence is reconciled again. */
    const expectWithdrawn = async (slug: string) => {
      const truth = await storedTruth(slug);
      expect(rowOf(truth, FORGOTTEN)).toMatch(new RegExp(`^\\| 1 \\| ~~${FORGOTTEN}~~ \\|.*\\| forgotten: `));
      expect(rowOf(truth, KEPT)).toStartWith(`| 2 | ${KEPT} |`);
      expect(rowOf(truth, TAKE)).toStartWith(`| 1 | ${TAKE} |`);
      await reconcile(slug);
      expect((await factRows(slug)).filter(row => row.active).map(row => row.fact)).toEqual([KEPT]);
    };
    /** Effect passes on this host until the source's withdrawal mirror and Git effects settle (purge refuses while one is open). */
    const settle = () => waitFor(async () => {
      const [open] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_effects
        WHERE source_id='default' AND kind IN ('withdrawal-mirror','git') AND (state NOT IN ('committed','failed') OR recovery IS NOT NULL)`);
      if (!open!.n) return true;
      await withEnv(env, async () => {
        await engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id='default' AND state='queued'`);
        await runPersistenceEffects(engine, { engine: kind, embedding_disabled: true } as never, { hostId: localHostId(), limit: 20 });
      });
      return false;
    }, { timeoutMs: 120_000, intervalMs: 100, label: 'the withdrawal mirror and Git effects settled' });
    const purge = async (id: number) => {
      await settle();
      const dry = await call('purge_fact', { id, dry_run: true }, false);
      const done = await call('purge_fact', { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() }, false);
      expect(done.state).toBe('committed');
    };
    /** Purged: no row of the claim in the stored fence, the other rows kept, and no fact row of it. */
    const expectPurged = async (slug: string) => {
      const truth = await storedTruth(slug);
      expect(truth.toLowerCase()).not.toContain(FORGOTTEN.toLowerCase());
      expect(rowOf(truth, KEPT)).toStartWith(`| 2 | ${KEPT} |`);
      expect(rowOf(truth, TAKE)).toStartWith(`| 1 | ${TAKE} |`);
      await reconcile(slug);
      expect((await factRows(slug)).map(row => row.fact)).not.toContain(FORGOTTEN);
    };

    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.setConfig('write_gate.agent_mode', 'off');
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
        VALUES('fence-upload','fixture-hash','fence-upload','read write','default') ON CONFLICT (client_id) DO NOTHING`);
      cli = await registerLocalWriter(engine, 'cli');
    }), 120_000);
    afterAll(async () => {
      await withEnv(env, async () => { await disposePersistenceConsumer(engine); await close(); });
      rmSync(home, { recursive: true, force: true });
    });

    test('import: the fenced file imports streamed; forget strikes the row; re-import and purge keep it out', async () => {
      const slug = 'notes/fenced-import';
      const text = page('Fenced import');
      expect(Buffer.byteLength(text)).toBeGreaterThan(PAGE_MAX_BYTES);
      const imported = await importFile(slug, text);
      expect({ status: imported.status, refusal: imported.refusal?.code ?? null }).toEqual({ status: 'imported', refusal: null });
      const truth = await storedTruth(slug);
      expect(rowOf(truth, FORGOTTEN)).toStartWith(`| 1 | ${FORGOTTEN} |`);

      const id = await forgottenFact(slug);
      expect((await call('forget_fact', { id, request_id: randomUUID() }, false)).status).not.toBe('error');
      await expectWithdrawn(slug);

      expect((await importFile(slug, text)).refusal).toBeUndefined();
      await expectWithdrawn(slug);

      await purge(id);
      await expectPurged(slug);
      expect((await importFile(slug, text)).refusal).toBeUndefined();
      await expectPurged(slug);
    }, 1_800_000);

    test('upload (remote create refused over MCP, local create, forget and replace): the withdrawal survives the replace and the purge', async () => {
      const slug = 'notes/fenced-upload';
      const text = page('Fenced upload');
      const remoteCreate = await upload(text, slug, true).then(() => null, (error: unknown) => error as OperationError);
      expect(remoteCreate?.code).toBe('permission_denied');
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
      const created = await upload(text, slug, false);
      expect({ state: created.state, status: created.status }).toEqual({ state: 'committed', status: 'created_or_updated' });
      expect(rowOf(await storedTruth(slug), FORGOTTEN)).toStartWith(`| 1 | ${FORGOTTEN} |`);
      // The takes fence remote reads hide stays: a remote put_page cannot replace the page without carrying it over.
      const before = await storedTruth(slug);
      const refused = await call('put_page', { slug, content: '---\ntitle: Fenced upload\ntype: note\n---\n\nA short body.\n', allow_shrink: true,
        expected_revision: (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision, request_id: randomUUID() }, true)
        .then(() => null, (error: unknown) => error as OperationError);
      expect(refused?.code).toBe('page_body_segmented');
      expect(await storedTruth(slug)).toBe(before);

      const id = await forgottenFact(slug);
      // Owner-written rows: a remote forget asks the owner to confirm (forget_requires_owner), so the forget runs locally.
      await call('forget_fact', { id, request_id: randomUUID() }, false);
      await expectWithdrawn(slug);

      const revision = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
      const replaced = await upload(text, slug, false, { mode: 'replace', expected_revision: await revision() });
      expect(replaced.state).toBe('committed');
      await expectWithdrawn(slug);

      await purge(id);
      await expectPurged(slug);
      expect((await upload(text, slug, false, { mode: 'replace', expected_revision: await revision() })).state).toBe('committed');
      await expectPurged(slug);
    }, 1_800_000);

    test('a remote upload replace of a page whose quoted facts fence holds a private row is refused and writes nothing', async () => {
      const slug = 'notes/quoted-private';
      const quoted = `An example of two fences:\n\n\`\`\`\n${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Reads on the train | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n${FACTS_FENCE_END}${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | ${KEPT} | preference | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FACTS_FENCE_END}\n\`\`\`\n`;
      expect((await importFile(slug, `---\ntitle: Quoted private\ntype: note\n---\n\n${quoted}\n${filler.slice(0, 2 * MiB)}\n`)).status).toBe('imported');
      const before = await storedTruth(slug);
      const replacement = `---\ntitle: Quoted private\ntype: note\n---\n\n${filler}\n`;
      const refused = await upload(replacement, slug, true, { mode: 'replace', expected_revision: (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision })
        .then(() => null, (error: unknown) => error as OperationError);
      expect(refused?.code).toBe('upload_protected_content');
      expect(await storedTruth(slug)).toBe(before);
    }, 1_800_000);
  });
}
