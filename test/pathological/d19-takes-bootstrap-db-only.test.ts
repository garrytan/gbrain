/**
 * D-19 (GBRA-131, #6982 family): the takes bootstrap reads a database-only
 * page from the database instead of requiring a file.
 *
 * Protects: on an unmanaged brain `extractTakesFromPages` treats the database
 * as the copy of record for a page in a declared `storage.db_only` directory,
 * and for every page when `sync.write_through` is off: the classifier runs on
 * the database body, the claim is appended to the page's database takes fence
 * through coordinated put_page (bound to the revision read before the
 * classifier), and no file is created or changed. A file-backed page whose
 * file is missing is still skipped (`mirror_unavailable`) before any
 * classifier call, and a file-backed page with its file still gets the claim
 * md-first in both copies on an unbound source. On a source with a canonical
 * owner (bound before the run, or bound by the run's own first put_page, as
 * PGLite does automatically) a file-backed page gets the claim through
 * put_page too, so a mixed batch never reaches the fenced md-first writer.
 * On Postgres the database-side cases bind the source first
 * (`claimWorktree`, the claim PGLite makes on its first coordinated write); on
 * Postgres a database-only page of an unbound source is skipped
 * (`owner_unavailable`) while the run's file-backed pages still get claims.
 * Fails when: the bootstrap requires a physical file before choosing the
 * database or file branch (the pre-fix path): every db_only page is skipped
 * as `mirror_unavailable`, and with write-through off the claim is appended
 * to the checkout file; or a file-backed page of a bound source takes the
 * md-first branch, whose file write is refused (writer_coordinator_required)
 * and aborts the batch.
 * Seams: `__setChatTransportForTests` (stub classifier, no paid call).
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { extractTakesFromPages } from '../../src/core/extract-takes-from-pages.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { claimWorktree, managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';

const SLUG = 'concepts/acme-example-pricing';
const BODY = `DB-BODY-MARKER: ${'Acme Example raises prices every spring and customers accept it. '.repeat(5)}`;
const CLAIM = 'Acme Example has pricing power';
let classified: string[] = [];

beforeAll(() => {
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-ant-test-d19' } });
  __setChatTransportForTests(async opts => {
    const user = opts.messages?.find((m: { role: string }) => m.role === 'user');
    classified.push(typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? ''));
    const text = JSON.stringify([{ claim: CLAIM, kind: 'take', weight: 0.7 }]);
    return { text, blocks: [{ type: 'text' as const, text }], stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic' };
  });
});

afterAll(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

interface Brain {
  engine: BrainEngine;
  root: string;
  path: string;
  file(): string | null;
  body(): Promise<string>;
  takes(): Promise<string[]>;
  writeFileFromDatabase(): Promise<string>;
  run(): ReturnType<typeof extractTakesFromPages>;
}

async function withBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>, opts: { bound?: boolean } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d19-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.setConfig('sync.repo_path', root);
        if (opts.bound ?? databaseUrl !== undefined) await claimWorktree(engine, 'default', root);
        await engine.putPage(SLUG, { type: 'concept', title: 'Acme Example pricing', compiled_truth: BODY });
        const path = join(root, `${SLUG}.md`);
        classified = [];
        await run({
          engine, root, path,
          file: () => existsSync(path) ? readFileSync(path, 'utf8') : null,
          body: async () => (await engine.executeRaw<{ compiled_truth: string }>(
            "SELECT compiled_truth FROM pages WHERE source_id = 'default' AND slug = $1", [SLUG]))[0]!.compiled_truth,
          takes: async () => (await engine.executeRaw<{ claim: string }>(
            "SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY t.row_num", [SLUG])).map(r => r.claim),
          async writeFileFromDatabase() {
            await engine.executeRaw("UPDATE pages SET source_path = $1 WHERE source_id = 'default' AND slug = $2", [`${SLUG}.md`, SLUG]);
            const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
            const bytes = serializePageToMarkdown(snapshot.page, snapshot.tags);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, bytes);
            return bytes;
          },
          run: () => extractTakesFromPages(engine, { bootstrapEnabled: true, maxPages: 10, holder: 'world' }),
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const fenceClaims = (text: string) => parseTakesFence(text).takes.map(t => t.claim);

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-19 takes bootstrap on database-only pages (${backend})`, () => {
    test('D-19 storage.db_only page with no file: the claim lands in the database fence and no file is created', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - concepts/\n');
        const r = await expectUnitNotAborted(() => b.run());
        const body = await b.body();
        expect({ extracted: r.claims_extracted, skipped: r.skipped, file: b.file(), kept: body.startsWith(BODY.trim()), fence: fenceClaims(body), takes: await b.takes(),
          classifiedDb: classified.some(c => c.includes('DB-BODY-MARKER')) })
          .toEqual({ extracted: 1, skipped: [], file: null, kept: true, fence: [CLAIM], takes: [CLAIM], classifiedDb: true });
      });
    }, 180_000);

    test('D-19 write-through off: the claim lands in the database fence and the checkout file is untouched', async () => {
      await withBrain(databaseUrl, async b => {
        const fileBefore = await b.writeFileFromDatabase();
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const r = await expectUnitNotAborted(() => b.run());
        const body = await b.body();
        expect({ extracted: r.claims_extracted, file: b.file() === fileBefore, kept: body.startsWith(BODY.trim()), fence: fenceClaims(body), takes: await b.takes() })
          .toEqual({ extracted: 1, file: true, kept: true, fence: [CLAIM], takes: [CLAIM] });
      });
    }, 180_000);

    test('D-19 file-backed page whose file is missing: still skipped mirror_unavailable before the classifier runs', async () => {
      await withBrain(databaseUrl, async b => {
        const r = await expectUnitNotAborted(() => b.run());
        expect({ extracted: r.claims_extracted, skipped: r.skipped, classified: classified.length, file: b.file(), body: await b.body(), takes: await b.takes() })
          .toEqual({ extracted: 0, skipped: [{ slug: SLUG, reason: 'mirror_unavailable' }], classified: 0, file: null, body: BODY, takes: [] });
      });
    }, 180_000);

    if (backend === 'postgres') test('D-19 Postgres, unbound source: a db_only page is skipped owner_unavailable and the run goes on', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - concepts/\n');
        await b.engine.putPage('writing/acme-example-essay', { type: 'writing', title: 'Acme Example essay', compiled_truth: BODY });
        await b.engine.executeRaw("UPDATE pages SET source_path = 'writing/acme-example-essay.md' WHERE source_id = 'default' AND slug = 'writing/acme-example-essay'");
        mkdirSync(join(b.root, 'writing'), { recursive: true });
        writeFileSync(join(b.root, 'writing/acme-example-essay.md'), `# Acme Example essay\n\n${BODY}\n`);
        const r = await expectUnitNotAborted(() => b.run());
        expect({ skipped: r.skipped, extracted: r.claims_extracted, file: b.file(), body: await b.body(),
          essay: parseTakesFence(readFileSync(join(b.root, 'writing/acme-example-essay.md'), 'utf8')).takes.map(t => t.claim) })
          .toEqual({ skipped: [{ slug: SLUG, reason: 'owner_unavailable' }], extracted: 1, file: null, body: BODY, essay: [CLAIM] });
      }, { bound: false });
    }, 180_000);

    test('D-19 control: a file-backed page with its file gets the claim md-first', async () => {
      await withBrain(databaseUrl, async b => {
        await b.writeFileFromDatabase();
        const r = await expectUnitNotAborted(() => b.run());
        expect({ extracted: r.claims_extracted, file: fenceClaims(b.file()!), fileKept: b.file()!.includes('DB-BODY-MARKER'), takes: await b.takes() })
          .toEqual({ extracted: 1, file: [CLAIM], fileKept: true, takes: [CLAIM] });
      }, { bound: false });
    }, 180_000);

    const ESSAY = 'writing/acme-example-essay';
    const essayPath = (b: Brain) => join(b.root, `${ESSAY}.md`);
    const essayTakes = async (b: Brain) => (await b.engine.executeRaw<{ claim: string }>(
      "SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY t.row_num", [ESSAY])).map(r => r.claim);

    if (backend === 'pglite') test('D-19 mixed order, unbound PGLite: after the database-only put_page binds the source, a file-backed page is routed through put_page and the batch finishes', async () => {
      await withBrain(databaseUrl, async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - concepts/\n');
        await b.engine.putPage(ESSAY, { type: 'writing', title: 'Acme Example essay', compiled_truth: BODY });
        await b.engine.executeRaw("UPDATE pages SET source_path = $1, updated_at = now() - interval '1 hour' WHERE source_id = 'default' AND slug = $2", [`${ESSAY}.md`, ESSAY]);
        const snapshot = (await b.engine.readPageSnapshot(ESSAY, { sourceId: 'default' }))!;
        const essay = serializePageToMarkdown(snapshot.page, snapshot.tags);
        mkdirSync(dirname(essayPath(b)), { recursive: true });
        writeFileSync(essayPath(b), essay);
        const r = await expectUnitNotAborted(() => b.run());
        const body = await b.body();
        expect({ extracted: r.claims_extracted, skipped: r.skipped, file: b.file(), fence: fenceClaims(body),
          essayFile: readFileSync(essayPath(b), 'utf8') === essay, essayTakes: await essayTakes(b) })
          .toEqual({ extracted: 1, skipped: [{ slug: ESSAY, reason: 'source_changed' }], file: null, fence: [CLAIM], essayFile: true, essayTakes: [] });
      }, { bound: false });
    }, 180_000);

    test('D-19 bound source: a coordinated file-backed page gets the claim through put_page in both copies', async () => {
      await withBrain(databaseUrl, async b => {
        const { operations } = await import('../../src/core/operations.ts');
        const putPage = operations.find(operation => operation.name === 'put_page')!;
        await putPage.handler({ engine: b.engine, config: { engine: b.engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as never,
          { slug: ESSAY, content: `---\ntype: writing\ntitle: Acme Example essay\n---\n\n${BODY}\n` });
        const r = await expectUnitNotAborted(() => b.run());
        const essay = readFileSync(essayPath(b), 'utf8');
        expect({ extracted: r.claims_extracted, skipped: r.skipped, essayFile: fenceClaims(essay), essayKept: essay.includes('DB-BODY-MARKER'), essayTakes: await essayTakes(b) })
          .toEqual({ extracted: 1, skipped: [{ slug: SLUG, reason: 'mirror_unavailable' }], essayFile: [CLAIM], essayKept: true, essayTakes: [CLAIM] });
      }, { bound: true });
    }, 180_000);
  });
}
