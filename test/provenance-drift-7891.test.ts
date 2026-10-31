/**
 * #7891 / #7918 part 1: doctor `provenance_stamp_drift` and `gbrain repair provenance`.
 *
 * 1. Protects: a page whose provenance stamps and lowering marker a remote write removed before #7892 is reported
 *    read-only by doctor; the repair previews it without writing anything, and `--apply --expect <hash> --yes` puts the
 *    stamps back, stamps the lost cap as the `trust_tier` marker (file and database on a repository brain, the database
 *    on a repo-less brain), lowers the page to it and files a `lower_page` proposal; a rerun previews nothing. The
 *    owner's own edit is listed and never written; an unattributed one only with `--include-ambiguous`. A classified
 *    page whose file would re-read above its stored tier gets that tier as its marker, and its row keeps its tier. Apply
 *    refuses without a preview hash and when the page moved after the preview.
 * 2. Fails when: the repair writes during a preview, raises any tier, writes the owner's own edit, applies a plan the
 *    preview did not show, or the doctor check misses or miscounts the damage.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set; a classic repository checkout, a repo-less brain, and a
 *    managed repository brain (the coordinator's owner page write and its Git effect). No embedding, no model calls.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withTrustPromotion, withWriteAttribution } from '../src/core/persistence/context.ts';
import type { WriteAttribution } from '../src/core/persistence/attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { analyzePageDrift } from '../src/core/trust/provenance-drift.ts';
import { provenanceStampDriftEntry } from '../src/commands/doctor/checks/provenance-stamp-drift.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { withEnv } from './helpers/with-env.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const STORED = { source_kind: 'webhook', ingested_via: 'webhook', ingested_at: '2026-01-02T03:04:05.000Z' };
const stampsOf = (fm: Record<string, unknown>) => ({ source_kind: fm.source_kind, ingested_via: fm.ingested_via, ingested_at: fm.ingested_at });
const logger = { info() {}, warn() {}, error() {} };
type Writer = 'oauth_client' | 'local_cli' | null;

for (const kind of testBackends()) {
  for (const repo of [true, false]) {
    describe(`#7891 provenance drift (${kind}, ${repo ? 'repository' : 'repo-less'} brain)`, () => {
      let engine: BrainEngine;
      let close: () => Promise<void>;
      let tmpRoot: string;
      let brainDir: string;

      beforeAll(async () => {
        if (kind === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
      }, 120_000);
      afterAll(async () => { if (kind === 'pglite') { await disposePersistenceConsumer(engine); await engine.disconnect(); } resetGateway(); });
      beforeEach(async () => {
        if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
        else { await disposePersistenceConsumer(engine); await resetPgliteState(engine as PGLiteEngine); }
        resetGateway();
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-7891-'));
        brainDir = path.join(tmpRoot, 'brain');
        fs.mkdirSync(brainDir, { recursive: true });
        if (repo) await engine.setConfig('sync.repo_path', brainDir);
        else await engine.executeRaw("DELETE FROM config WHERE key = 'sync.repo_path'");
      }, 120_000);
      afterEach(async () => {
        await disposePersistenceConsumer(engine);
        if (kind === 'postgres') await close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      });

      const inHome = <T>(run: () => Promise<T>) => withEnv({ GBRAIN_HOME: path.join(tmpRoot, 'home') }, run);
      const page = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      const fileOf = (slug: string) => path.join(brainDir, `${slug}.md`);
      const writeFile = async (slug: string) => {
        if (!repo) return;
        const snapshot = await page(slug);
        fs.mkdirSync(path.dirname(fileOf(slug)), { recursive: true });
        fs.writeFileSync(fileOf(slug), serializePageToMarkdown(snapshot.page, snapshot.tags));
      };
      const tierOf = async (slug: string) => (await engine.executeRaw<{ trust_tier: string }>(
        'SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]!.trust_tier;
      const proposals = (slug: string) => engine.executeRaw<{ action: string; proposer: string; status: string }>(
        `SELECT tp.action, tp.proposer, tp.status FROM trust_proposals tp JOIN pages p ON tp.target_table = 'pages' AND tp.target_id = p.id
          WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY tp.id`, [slug]);
      const fixtureWrite = (attribution: WriteAttribution | null, write: (tx: BrainEngine) => Promise<void>) => engine.transaction(tx =>
        attribution ? withWriteAttribution(tx, attribution, () => write(tx)) : write(tx));
      /** A page as an ingestion capture left it: stamped external, at `tier`. */
      const seed = async (slug: string, frontmatter: Record<string, unknown>, tier = 'unknown') => {
        await fixtureWrite(null, async tx => {
          await tx.putPage(slug, { type: 'note', title: 'Seeded', compiled_truth: 'Captured body', timeline: '', frontmatter,
            source_kind: 'webhook', ingested_via: 'webhook' } as never);
          await withTrustPromotion(tx, 'user_confirmed', () =>
            tx.executeRaw('UPDATE pages SET trust_tier = $1, ingested_at = $4::timestamptz WHERE source_id = $2 AND slug = $3', [tier, 'default', slug, STORED.ingested_at]));
        });
        await writeFile(slug);
      };
      /** A write as one landed before #7892: it replaced the frontmatter, made by `writer` (null: no recorded writer). */
      const rewrite = async (slug: string, frontmatter: Record<string, unknown>, writer: Writer) => {
        const attribution = writer ? { requestId: randomUUID(), principal: { kind: writer, id: 'client-example' } } as WriteAttribution : null;
        await fixtureWrite(attribution, async tx => {
          await tx.createVersion(slug, { sourceId: 'default' });
          await tx.putPage(slug, { type: 'note', title: 'Seeded', compiled_truth: 'Captured body, edited', timeline: '', frontmatter,
            source_kind: 'webhook', ingested_via: 'webhook' } as never);
          await tx.executeRaw('UPDATE pages SET ingested_at = $3::timestamptz WHERE source_id = $1 AND slug = $2', ['default', slug, STORED.ingested_at]);
        });
        await writeFile(slug);
      };
      const doctor = async () => (await provenanceStampDriftEntry.run({ engine, args: [], sourceIds: ['default'] } as unknown as DoctorContext) as Array<Record<string, any>>)[0]!;
      const run = (apply: boolean, opts: Record<string, unknown> = {}) => inHome(async () =>
        (await repairRunner(engine, { apply, logger })).run('provenance', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...opts }) as Promise<Record<string, any>>);
      const refusal = async (go: () => Promise<unknown>): Promise<OperationError> => {
        try { await go(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
        throw new Error('expected a refusal');
      };

      test('doctor and the preview report a remote write that dropped the stamps and the marker; nothing is written', async () => {
        const slug = 'inbox/remote-drop';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'oauth_client');
        const check = await doctor();
        expect(check.status).toBe('warn');
        expect(check.details.sources[0]).toMatchObject({ source_id: 'default', marker_lost: { remote: 1 }, stamps_rewritten: { remote: 1 }, pages: 1 });
        expect(check.fix.argv).toEqual(['gbrain', 'repair', 'provenance', '--source', 'default', '--json']);
        expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('provenance');

        const before = { revision: (await page(slug)).revision, tier: await tierOf(slug), file: repo ? fs.readFileSync(fileOf(slug), 'utf8') : null };
        const dry = await run(false);
        expect(dry.affected).toBe(1);
        expect(dry.listing.map((entry: Record<string, string>) => [entry.class, entry.item.split(' ')[0]])).toEqual([['remote', `default:${slug}`]]);
        expect(dry.listing[0].detail).toContain('ingested_via (none) -> webhook');
        expect(dry.apply_command).toBe(`gbrain repair provenance --source default --apply --expect ${dry.preview_hash} --yes`);
        expect({ revision: (await page(slug)).revision, tier: await tierOf(slug), file: repo ? fs.readFileSync(fileOf(slug), 'utf8') : null }).toEqual(before);
        expect(await proposals(slug)).toEqual([]);
      }, 120_000);

      test('apply restores the stamps and the marker, lowers the page, files a lower_page proposal; a rerun previews nothing', async () => {
        const slug = 'inbox/remote-restore';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'oauth_client');
        const dry = await run(false);
        await run(true, { expect: dry.preview_hash });
        const after = await page(slug);
        expect(stampsOf(after.page.frontmatter)).toEqual(STORED);
        expect(after.page.frontmatter.trust_tier).toBe('external_untrusted');
        expect(after.page.compiled_truth).toContain('Captured body, edited');
        expect(await tierOf(slug)).toBe('external_untrusted');
        expect(await proposals(slug)).toEqual([{ action: 'lower_page', proposer: 'provenance_repair', status: 'pending' }]);
        if (repo) {
          const file = parseMarkdown(fs.readFileSync(fileOf(slug), 'utf8'), slug).frontmatter;
          expect(stampsOf(file)).toEqual(STORED);
          expect(file.trust_tier).toBe('external_untrusted');
        }
        expect((await run(false)).affected).toBe(0);
        expect((await doctor()).status).toBe('ok');
      }, 120_000);

      test('apply refuses without a preview hash and when the page moved after the preview', async () => {
        const slug = 'inbox/remote-moved';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'oauth_client');
        expect((await refusal(() => run(true))).code).toBe('invalid_params');
        const dry = await run(false);
        await rewrite(slug, { source_kind: 'put_page' }, 'oauth_client');
        expect((await refusal(() => run(true, { expect: dry.preview_hash }))).code).toBe('preview_changed');
        expect(await proposals(slug)).toEqual([]);
      }, 120_000);

      test('the owner\'s own edit is listed and never written', async () => {
        const slug = 'inbox/local-drop';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'local_cli');
        expect((await doctor()).status).toBe('ok');
        const dry = await run(false);
        expect(dry.affected).toBe(0);
        expect(dry.listing.map((entry: Record<string, string>) => entry.class)).toEqual(['local']);
      }, 120_000);

      test('an unattributed write is listed ambiguous and planned only with --include-ambiguous', async () => {
        const slug = 'inbox/unattributed-drop';
        await seed(slug, STORED);
        await rewrite(slug, {}, null);
        expect((await doctor()).status).toBe('warn');
        const plain = await run(false);
        expect(plain.affected).toBe(0);
        expect(plain.listing.map((entry: Record<string, string>) => entry.class)).toEqual(['ambiguous']);
        const wide = await run(false, { includeAmbiguous: true });
        expect(wide.affected).toBe(1);
        expect(wide.preview_hash).not.toBe(plain.preview_hash);
        await run(true, { expect: wide.preview_hash, includeAmbiguous: true });
        expect(stampsOf((await page(slug)).page.frontmatter)).toEqual(STORED);
        expect(await tierOf(slug)).toBe('external_untrusted');
      }, 120_000);

      test.skipIf(!repo)('a page file holding an edit the database lacks is listed needs_review and never overwritten', async () => {
        const slug = 'inbox/unsynced-edit';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'oauth_client');
        const ready = await run(false);
        expect(ready.affected).toBe(1);
        const edited = fs.readFileSync(fileOf(slug), 'utf8').replace('Captured body, edited', 'Captured body, edited by hand in the checkout');
        fs.writeFileSync(fileOf(slug), edited);
        expect((await refusal(() => run(true, { expect: ready.preview_hash }))).code).toBe('preview_changed');
        expect(fs.readFileSync(fileOf(slug), 'utf8')).toBe(edited);
        const dry = await run(false);
        expect(dry.affected).toBe(0);
        expect(dry.listing.map((entry: Record<string, string>) => [entry.class, entry.detail])).toEqual([['needs_review', expect.stringContaining('gbrain sync first')]]);
        expect(fs.readFileSync(fileOf(slug), 'utf8')).toBe(edited);
        expect(await proposals(slug)).toEqual([]);
      }, 120_000);

      test.skipIf(!repo)('a page whose checkout cannot be written is listed needs_review, not repaired in the database alone', async () => {
        const slug = 'inbox/missing-checkout';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'oauth_client');
        await engine.setConfig('sync.repo_path', path.join(tmpRoot, 'gone'));
        const dry = await run(false);
        expect(dry.affected).toBe(0);
        expect(dry.listing.map((entry: Record<string, string>) => entry.class)).toEqual(['needs_review']);
      }, 120_000);

      test.skipIf(!repo)('a page of a clone gbrain pulls is listed needs_review, not repaired in the database alone', async () => {
        const slug = 'inbox/owned-clone';
        await seed(slug, STORED);
        await rewrite(slug, {}, 'oauth_client');
        const before = fs.readFileSync(fileOf(slug), 'utf8');
        await engine.executeRaw(`UPDATE sources SET local_path = $1, config = COALESCE(config, '{}'::jsonb) || '{"managed_clone":true}'::jsonb WHERE id = 'default'`, [brainDir]);
        try {
          const dry = await run(false);
          expect(dry.affected).toBe(0);
          expect(dry.listing.map((entry: Record<string, string>) => [entry.class, entry.detail])).toEqual([['needs_review', expect.stringContaining('url_clone')]]);
          expect(fs.readFileSync(fileOf(slug), 'utf8')).toBe(before);
        } finally {
          await engine.executeRaw(`UPDATE sources SET local_path = NULL, config = config - 'managed_clone' WHERE id = 'default'`);
        }
      }, 120_000);

      test('#7918: a classified page whose file would re-read higher gets its stored tier as the marker; the row keeps its tier', async () => {
        const slug = 'inbox/derived-unmarked';
        await seed(slug, {}, 'agent_written');
        expect((await page(slug)).page.frontmatter.trust_tier).toBeUndefined();
        const check = await doctor();
        expect(check.status).toBe('warn');
        expect(check.details.sources[0].marker_missing).toBe(1);
        const dry = await run(false);
        expect(dry.listing.map((entry: Record<string, string>) => entry.class)).toEqual(['restamp']);
        await run(true, { expect: dry.preview_hash });
        expect((await page(slug)).page.frontmatter.trust_tier).toBe('agent_written');
        if (repo) expect(parseMarkdown(fs.readFileSync(fileOf(slug), 'utf8'), slug).frontmatter.trust_tier).toBe('agent_written');
        expect(await tierOf(slug)).toBe('agent_written');
        expect((await run(false)).affected).toBe(0);
      }, 120_000);
    });
  }
}

for (const kind of testBackends()) {
  const databaseUrl = kind === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#7891 provenance drift (${kind}, managed repository brain)`, () => {
    test('apply publishes the restore through the coordinator: the file and the row carry the restored stamps and marker', () => managedBrain(async ({ engine, ctx, root }) => {
      const slug = 'inbox/managed-restore';
      await operationsByName.put_page.handler(ctx, { slug, content: '---\ntitle: Seeded\ntype: note\n---\nCaptured body\n' });
      await settleManagedGitEffects(engine);
      const seeded = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      await operationsByName.put_page.handler(ctx, { slug, content: '---\ntitle: Seeded\ntype: note\n---\nCaptured body, edited\n', expected_revision: seeded.revision });
      await settleManagedGitEffects(engine);
      // The history a pre-#7892 remote write left (managed writes now server-own the stamps, so the fixture writes it):
      // the archived version carries the capture's stamps and names a remote principal; the live row and file carry none.
      await withManagedFixtureWrite(engine, ['default'], async tx => {
        await tx.executeRaw(`UPDATE page_versions SET frontmatter = $2::jsonb, archived_write_request_id = NULL, archived_principal_kind = 'oauth_client'
          WHERE id = (SELECT max(v.id) FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = 'default' AND p.slug = $1)`, [slug, JSON.stringify(STORED)]);
        await tx.executeRaw(`UPDATE pages SET frontmatter = '{}'::jsonb, source_kind = 'webhook', ingested_via = 'webhook', ingested_at = $2::timestamptz
          WHERE source_id = 'default' AND slug = $1`, [slug, STORED.ingested_at]);
      });
      const live = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
      fs.writeFileSync(path.join(root, `${slug}.md`), serializePageToMarkdown(live.page, live.tags));
      const repair = (apply: boolean, expect?: string) => (async () => (await repairRunner(engine, { apply, logger }))
        .run('provenance', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', ...(expect ? { expect } : {}) }))() as Promise<Record<string, any>>;
      const dry = await repair(false);
      expect(dry.listing.map((entry: Record<string, string>) => entry.class)).toEqual(['remote']);
      const fileBefore = fs.readFileSync(path.join(root, `${slug}.md`), 'utf8');
      expect(fs.readFileSync(path.join(root, `${slug}.md`), 'utf8')).toBe(fileBefore);
      await repair(true, dry.preview_hash);
      await settleManagedGitEffects(engine);
      const row = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.frontmatter;
      const file = parseMarkdown(fs.readFileSync(path.join(root, `${slug}.md`), 'utf8'), slug).frontmatter;
      expect(stampsOf(row)).toEqual(STORED);
      expect(stampsOf(file)).toEqual(STORED);
      expect(row.trust_tier).toBe('external_untrusted');
      expect(file.trust_tier).toBe('external_untrusted');
      expect((await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id = $1 AND slug = $2', ['default', slug]))[0]!.trust_tier).toBe('external_untrusted');
      expect((await repair(false)).affected).toBe(0);
    }, { databaseUrl }), 120_000);
  });
}

// Value: protects=the verdict rules (restore target, later local edits, lower-only planning); fails_when=a rule raises a tier or restores over an owner edit; why_new=the engine cases above seed one shape each; seam=none; no_claim=SQL reads (covered above)
describe('#7891 analyzePageDrift', () => {
  const snap = (frontmatter: Record<string, unknown>, writer: 'remote' | 'local' | 'unattributed' = 'local') => ({ frontmatter, writer, request_id: null });
  const columns = { source_kind: null, ingested_via: null, ingested_at: null };

  test('a stamp a remote write removed is restored from the snapshot before it, and the page is lowered to its cap', () => {
    const verdict = analyzePageDrift({ chain: [snap({ ingested_via: 'webhook' }), snap({}, 'remote')], stored: 'unknown', columns })!;
    expect(verdict).toMatchObject({ class: 'remote', marker_lost: true, stamps_rewritten: true });
    expect(verdict.restore).toMatchObject({ stamps: { ingested_via: 'webhook' }, marker: 'external_untrusted', tier: 'external_untrusted' });
  });
  test('a later local edit of the same stamp makes the page needs_review, with no planned write', () => {
    const verdict = analyzePageDrift({ chain: [snap({ ingested_via: 'webhook' }), snap({}, 'remote'), snap({ ingested_via: 'manual' }, 'local')], stored: 'unknown', columns })!;
    expect(verdict.class).toBe('needs_review');
    expect(verdict.restore).toBeUndefined();
  });
  test('the trusted column wins over the history, and the plan never lifts a cap the live page has', () => {
    const verdict = analyzePageDrift({ chain: [snap({ source_kind: 'webhook' }), snap({ source_kind: 'put_page' }, 'remote')], stored: 'agent_written',
      columns: { ...columns, source_kind: 'email' } })!;
    expect(verdict.restore!.stamps).toEqual({ source_kind: 'email' });
    expect(verdict.restore!.tier).toBe('external_untrusted');
  });
  test('a remote write that only lowered a stamp keeps the live cap', () => {
    const verdict = analyzePageDrift({ chain: [snap({ source_kind: 'manual' }), snap({ source_kind: 'webhook' }, 'remote')], stored: 'unknown', columns })!;
    expect(verdict.restore!.frontmatter.trust_tier).toBe('external_untrusted');
  });
  test('an unchanged history reports nothing', () => {
    expect(analyzePageDrift({ chain: [snap({ ingested_via: 'webhook' }), snap({ ingested_via: 'webhook' }, 'remote')], stored: 'unknown', columns })).toBeNull();
  });
});
