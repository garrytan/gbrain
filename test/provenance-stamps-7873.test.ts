/**
 * #7873: provenance stamps (source_kind / ingested_via / ingested_at) are server-owned on every caller-content
 * write a remote caller makes, and removing a page's own lowering marker never raises it when it is re-derived.
 *
 * 1. Protects: a remote edit_page, put_page (with or without a repository) and capture cannot write, change or drop
 *    provenance stamps in the page file or the stored frontmatter; an edit that only forges stamps is a no-op; on an
 *    unclassified page (stored tier unknown) a remote edit that strips a lowering marker (an ingested_via: webhook
 *    stamp, a third-party transcript_import) stamps the trust marker at the stripped marker's tier, so a later sync
 *    (ownerPageTrust over the file) or the trust backfill (frontmatter caps) does not raise the page.
 * 2. Fails when: a remote caller's stamp reaches the file or the database, or a re-derive after a remote edit
 *    yields a higher tier than the page's own markers allowed before the edit.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set; repository and repo-less brains (no embedding, no
 *    model calls).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import { frontmatterTrustCaps, ownerPageTrust } from '../src/core/trust/channel.ts';
import { minTrust } from '../src/core/trust/tier.ts';
import { withEnv } from './helpers/with-env.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const STORED = { source_kind: 'webhook', ingested_via: 'webhook', ingested_at: '2026-01-02T03:04:05.000Z' };
const FORGED = { source_kind: 'put_page', ingested_via: 'put_page', ingested_at: '2020-01-01T00:00:00.000Z' };
const stampsOf = (fm: Record<string, unknown>) => ({ source_kind: fm.source_kind, ingested_via: fm.ingested_via, ingested_at: fm.ingested_at });
const lowest = (fm: Record<string, unknown>) => { const caps = frontmatterTrustCaps(fm); return caps.length ? minTrust(caps[0]!, ...caps.slice(1)) : null; };

for (const kind of testBackends()) {
  for (const repo of [true, false]) {
    describe(`#7873 provenance stamps (${kind}, ${repo ? 'repository' : 'repo-less'} brain)`, () => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      let tmpRoot: string;
      let brainDir: string;
      let registration: LocalRegistration | null = null;

      beforeAll(async () => {
        if (kind === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      }, 120_000);
      afterAll(async () => { if (kind === 'pglite') { await disposePersistenceConsumer(engine); await engine.disconnect(); } resetGateway(); });
      beforeEach(async () => {
        if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        else { await disposePersistenceConsumer(engine); await resetPgliteState(engine as PGLiteEngine); }
        resetGateway();
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-7873-'));
        brainDir = path.join(tmpRoot, 'brain');
        fs.mkdirSync(brainDir, { recursive: true });
        if (repo) await engine.setConfig('sync.repo_path', brainDir);
        else await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'");
        // Postgres writes through to a repository only from a bound source, through a verified local writer.
        registration = null;
        if (repo && kind === 'postgres') {
          registration = await withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, async () => {
            await claimWorktree(engine, 'default', brainDir);
            return registerLocalWriter(engine, 'stdio', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['inbox'] });
          });
        }
      }, 120_000);
      afterEach(async () => {
        await disposePersistenceConsumer(engine);
        if (kind === 'postgres') await close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      });

      const ctx = (remote = true) => ({ engine, config: { engine: kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} },
        dryRun: false, remote, sourceId: 'default' }) as unknown as OperationContext;
      const call = (name: string, params: Record<string, unknown>, c = ctx()) =>
        withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, () => {
          const run = () => operations.find(o => o.name === name)!.handler(c, params);
          return registration ? withVerifiedLocalRegistration(engine, registration, run) : run();
        }) as Promise<Record<string, any>>;
      const fileFrontmatter = (slug: string) => parseMarkdown(fs.readFileSync(path.join(brainDir, `${slug}.md`), 'utf8'), slug).frontmatter;
      const page = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      /** A page as an ingestion capture left it: stamped external, and unclassified (stored tier unknown) or classified. */
      const seed = async (slug: string, frontmatter: Record<string, unknown>, tier: string) => {
        const write = async (tx: BrainEngine) => {
          await tx.putPage(slug, { type: 'note', title: 'Seeded', compiled_truth: 'Captured body', timeline: '', frontmatter,
            source_kind: 'webhook', ingested_via: 'webhook' } as never);
          await tx.executeRaw('UPDATE pages SET trust_tier = $1, ingested_at = $4::timestamptz WHERE source_id = $2 AND slug = $3', [tier, 'default', slug, STORED.ingested_at]);
        };
        await (repo && kind === 'postgres' ? withManagedFixtureWrite(engine, ['default'], write) : write(engine));
        const snapshot = await page(slug);
        if (repo) {
          fs.mkdirSync(path.dirname(path.join(brainDir, slug)), { recursive: true });
          fs.writeFileSync(path.join(brainDir, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
        }
        return snapshot;
      };
      const read = (slug: string) => call('get_page', { slug, include_content: true }) as Promise<{ content: string; revision: string }>;
      const edit = async (slug: string, pairs: Array<[string, string]>) => {
        const current = await read(slug);
        return call('edit_page', { slug, expected_revision: current.revision, edits: pairs.map(([old_text, new_text]) => ({ old_text, new_text })) });
      };
      const forgeAll = (): Array<[string, string]> => [['source_kind: webhook', `source_kind: ${FORGED.source_kind}`],
        ['ingested_via: webhook', `ingested_via: ${FORGED.ingested_via}`], [`ingested_at: '${STORED.ingested_at}'`, `ingested_at: '${FORGED.ingested_at}'`]];

      test('a remote edit_page keeps the stored stamps in the file and the database, and the page does not re-derive higher', async () => {
        const slug = 'inbox/edit-stamps';
        const before = await seed(slug, STORED, 'unknown');
        const prior = ownerPageTrust({ frontmatter: before.page.frontmatter, channel: 'sync' }).tier;
        expect(prior).toBe('external_untrusted');
        expect((await read(slug)).content).toContain(`ingested_at: '${STORED.ingested_at}'`);
        const result = await edit(slug, [...forgeAll(), ['Captured body', 'Captured body, edited']]);
        expect(result.noop).toBe(false);
        const after = await page(slug);
        expect(after.page.compiled_truth).toContain('edited');
        expect(stampsOf(after.page.frontmatter)).toEqual(STORED);
        expect(lowest(after.page.frontmatter)).toBe('external_untrusted');
        if (repo) {
          const file = fileFrontmatter(slug);
          expect(stampsOf(file)).toEqual(STORED);
          expect(ownerPageTrust({ frontmatter: file, channel: 'sync' }).tier).toBe(prior);
        }
      });

      test('a remote edit_page that only forges stamps is a no-op', async () => {
        const slug = 'inbox/edit-noop';
        const before = await seed(slug, STORED, 'external_untrusted');
        const result = await edit(slug, forgeAll());
        expect(result.noop).toBe(true);
        expect((await page(slug)).revision).toBe(before.revision);
        if (repo) expect(stampsOf(fileFrontmatter(slug))).toEqual(STORED);
      });

      test('a remote edit_page that drops a stamp from an unclassified page stamps the marker at the dropped stamp\'s tier', async () => {
        const slug = 'inbox/edit-drop';
        await seed(slug, { ingested_via: 'webhook' }, 'unknown');
        await edit(slug, [['ingested_via: webhook\n', ''], ['Captured body', 'Captured body, edited']]);
        const after = await page(slug);
        expect(after.page.frontmatter.ingested_via).toBe('webhook');
        expect(after.page.frontmatter.trust_tier).toBe('external_untrusted');
        if (repo) expect(ownerPageTrust({ frontmatter: fileFrontmatter(slug), channel: 'sync' }).tier).toBe('external_untrusted');
      });

      test('a remote edit_page that drops a stored stamp is tiered as the page it publishes, not below the gate', async () => {
        const slug = 'inbox/edit-drop-tier';
        await seed(slug, { ingested_via: 'webhook' }, 'unknown');
        await edit(slug, [['ingested_via: webhook\n', ''], ['Captured body', 'Captured body, edited']]);
        const [row] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]);
        expect(row!.trust_tier).toBe('external_untrusted');
      });

      test('a remote edit_page that strips another lowering marker from an unclassified page does not raise it on re-derive', async () => {
        const slug = 'inbox/edit-transcript';
        const before = await seed(slug, { transcript_import: { harness: 'third-party-example' } }, 'unknown');
        expect(lowest(before.page.frontmatter)).toBe('external_untrusted');
        const current = await read(slug);
        const stripped = serializePageToMarkdown({ ...before.page, frontmatter: {}, compiled_truth: 'Captured body, edited' }, before.tags);
        await call('put_page', { slug, content: stripped, expected_revision: current.revision });
        const after = await page(slug);
        expect(after.page.frontmatter.trust_tier).toBe('external_untrusted');
        expect(lowest(after.page.frontmatter)).toBe('external_untrusted');
        if (repo) expect(ownerPageTrust({ frontmatter: fileFrontmatter(slug), channel: 'sync' }).tier).toBe('external_untrusted');
      });

      test('a remote put_page cannot change the stamps of an existing page', async () => {
        const slug = 'inbox/put-existing';
        const before = await seed(slug, STORED, 'external_untrusted');
        const current = await read(slug);
        const forged = serializePageToMarkdown({ ...before.page, frontmatter: FORGED, compiled_truth: 'Captured body, replaced' }, before.tags);
        await call('put_page', { slug, content: forged, expected_revision: current.revision });
        const after = await page(slug);
        expect(after.page.compiled_truth).toContain('replaced');
        expect(stampsOf(after.page.frontmatter)).toEqual(STORED);
        if (repo) expect(stampsOf(fileFrontmatter(slug))).toEqual(STORED);
      });

      // Value: protects=remote append_page on an unclassified captured page keeps stored stamps and the lowering marker; fails_when=append re-derives the page higher or drops stamps; why_new=prior rows cover edit_page/put_page/capture only; seam=none; no_claim=segmented splice path (inline page only)
      test('a remote append_page keeps the stored stamps and does not raise an unclassified page', async () => {
        const slug = 'inbox/append-stamps';
        await seed(slug, STORED, 'unknown');
        await call('append_page', { slug, text: 'Appended line', request_id: crypto.randomUUID(), expected_revision: (await read(slug)).revision });
        const after = await page(slug);
        expect(after.page.compiled_truth).toContain('Appended line');
        expect(stampsOf(after.page.frontmatter)).toEqual(STORED);
        expect(lowest(after.page.frontmatter)).toBe('external_untrusted');
        if (repo) expect(stampsOf(fileFrontmatter(slug))).toEqual(STORED);
      });

      // Value: protects=a local (remote=false) edit_page can still change provenance stamps as before #7873; fails_when=the server-owned stamp rule is applied to local callers; why_new=every other row is remote=true; seam=none; no_claim=managed local put_page (put-page-provenance covers it)
      test.skipIf(repo)('a local edit_page keeps its old behaviour and can change stamps on a repo-less brain', async () => {
        const slug = 'inbox/local-edit';
        await seed(slug, STORED, 'external_untrusted');
        const current = await read(slug);
        await call('edit_page', { slug, expected_revision: current.revision, edits: forgeAll().map(([old_text, new_text]) => ({ old_text, new_text })) }, ctx(false));
        expect(stampsOf((await page(slug)).page.frontmatter)).toEqual(FORGED);
      });

      test('a remote put_page and capture of a new page cannot supply stamps', async () => {
        const content = `---\ntitle: New page\nsource_kind: forged-kind\ningested_via: forged-channel\ningested_at: '${FORGED.ingested_at}'\n---\n\nFresh body`;
        await call('put_page', { slug: 'inbox/put-new', content });
        await call('capture', { slug: 'inbox/capture-new', content });
        for (const slug of ['inbox/put-new', 'inbox/capture-new']) {
          const stored = (await page(slug)).page.frontmatter;
          expect(JSON.stringify(stampsOf(stored))).not.toContain('forged');
          expect(stored.ingested_at).not.toBe(FORGED.ingested_at);
          if (repo) expect(JSON.stringify(stampsOf(fileFrontmatter(slug)))).not.toContain('forged');
        }
      });
    });
  }
}
