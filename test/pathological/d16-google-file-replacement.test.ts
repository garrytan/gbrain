/**
 * D-16 (GBRA-131, #6982).
 * Protects: unmanaged Google materialization preserves checkout-only
 * edits, including an edit after the replacement comparison, while healthy
 * contacts still import. A stale file held in page_versions is replaceable;
 * write-through off or a declared db_only prefix imports only to the database,
 * and segmented pages are held.
 * Fails when: unconditional temp-import-rename destroys an unimported file edit
 * and ignores sync.write_through or storage.db_only. Existing materialization tests cover upstream
 * changes and import failures, not divergent copies or a late editor write.
 * Seams: no production seam; real importer and engines, fake Google HTTP, an engine
 * proxy edits the file when the import transaction starts after temp creation.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../../src/core/google/google-source.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { contact, json, options, withGoogleAccount } from '../helpers/connector-fixture.ts';
import { segmentPage } from '../helpers/segmented-chunks-fixture.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, snapshotItems } from './harness.ts';

const SOURCE = 'google-example';
const BAD = 'people/alice-example';
const GOOD = 'people/bob-example';
const EDIT = '\n\nFILE-ONLY-EDIT: café, exact bytes.\r\n';
const CONFIG = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };

async function withSource(databaseUrl: string | undefined, run: (b: {
  engine: BrainEngine; root: string; path: string; file(): string;
  body(slug?: string): Promise<string>; versions(body: string): Promise<number>;
  sync(engine?: BrainEngine): ReturnType<typeof runGoogleSync>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-d16-'));
  try {
    await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [SOURCE, root, JSON.stringify(CONFIG)]);
        let generation = 0;
        const fetch = withGoogleAccount(async (url: string) => {
          if (new URL(url).pathname === '/v1/people/me/connections') return json({ connections: [
            { ...contact('c1', 'Alice Example'), organizations: [{ name: `Upstream ${generation}` }] },
            { ...contact('c2', 'Bob Example'), organizations: [{ name: `Upstream ${generation}` }] },
          ], nextSyncToken: `token-${generation}` });
          throw new Error(`Unexpected Google fixture route: ${url}`);
        }, CONFIG.g_account);
        const cfg = parseGoogleSourceConfig(CONFIG, root);
        const sync = (on = engine) => runGoogleSync(on, SOURCE, cfg, { ...options, sourceId: SOURCE }, fetch);
        expect((await sync()).failedFiles ?? 0).toBe(0);
        generation++;
        const path = join(root, `${BAD}.md`);
        const body = async (slug = BAD) => (await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', [SOURCE, slug]))[0]!.compiled_truth;
        await run({ engine, root, path, file: () => readFileSync(path, 'utf8'), body, sync,
          versions: async body => Number((await engine.executeRaw<{ n: number }>(
            'SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 AND v.compiled_truth=$3', [SOURCE, BAD, body]))[0]!.n) });
      } finally { await close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-16 Google checkout replacement (${backend})`, () => {
    test('db-newer: a file retained in history is safe to replace and both database preimages survive', async () => {
      await withSource(databaseUrl, async b => {
        const old = await b.body();
        const page = (await b.engine.getPage(BAD, { sourceId: SOURCE }))!;
        await b.engine.createVersion(BAD, { sourceId: SOURCE });
        const newer = `${old}\n\nDB-ONLY-EDIT: must survive in history.`;
        await b.engine.putPage(BAD, { ...page, compiled_truth: newer }, { sourceId: SOURCE });
        const result = await expectUnitNotAborted(() => b.sync());
        expect(result.failedFiles ?? 0).toBe(0);
        expect(await b.versions(old)).toBeGreaterThan(0);
        expect(await b.versions(newer)).toBeGreaterThan(0);
        expect(await b.body()).toContain('Upstream 1');
        expect(parseMarkdown(b.file(), `${BAD}.md`).compiled_truth).toBe(await b.body());
      });
    }, 180_000);

    test('file-newer: exact file and database bytes stay, typed holds count, siblings continue', async () => {
      await withSource(databaseUrl, async b => {
        const edited = b.file() + EDIT;
        writeFileSync(b.path, edited);
        const body = await b.body();
        const before = await snapshotItems(b.engine, SOURCE);
        for (let i = 0; i < 3; i++) {
          const result = await expectUnitNotAborted(() => b.sync());
          expect(result.failedFiles).toBe(1);
          expect(b.file()).toBe(edited);
          expect(await b.body()).toBe(body);
        }
        const hold = readGoogleState(b.root).item_holds as { items: Record<string, { code: string; state: string; message: string }> };
        expect(hold.items['contact:people/c1']).toMatchObject({ code: 'file_database_drift', state: 'held' });
        expect(hold.items['contact:people/c1']!.message).toContain(`gbrain sync --source ${SOURCE}`);
        expect(await b.body(GOOD)).toContain('Upstream 1');
        expectOthersUnchanged(before, await snapshotItems(b.engine, SOURCE), { expectProgress: [GOOD] });
      });
    }, 180_000);

    test('a real title-only edit is held without replacing either copy', async () => {
      await withSource(databaseUrl, async b => {
        const file = b.file();
        const edited = file.replace('title: "Alice Example"', 'title: "Alice Updated Example"');
        expect(edited).not.toBe(file);
        writeFileSync(b.path, edited);
        const before = { body: await b.body(), title: (await b.engine.getPage(BAD, { sourceId: SOURCE }))!.title };
        for (let i = 0; i < 3; i++) {
          const result = await expectUnitNotAborted(() => b.sync());
          expect(result.failedFiles).toBe(1);
          expect({ file: b.file(), body: await b.body(), title: (await b.engine.getPage(BAD, { sourceId: SOURCE }))!.title })
            .toEqual({ file: edited, ...before });
        }
        const hold = readGoogleState(b.root).item_holds as { items: Record<string, { code: string; state: string }> };
        expect(hold.items['contact:people/c1']).toMatchObject({ code: 'file_database_drift', state: 'held' });
        expect(await b.body(GOOD)).toContain('Upstream 1');
      });
    }, 180_000);

    test('late file edit: comparison preimage is checked again immediately before rename', async () => {
      await withSource(databaseUrl, async b => {
        const old = await b.body();
        const edited = b.file() + EDIT;
        let landed = false;
        const racing = new Proxy(b.engine, { get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'transaction') return (...args: unknown[]) => {
            if (!landed && existsSync(`${b.path}.tmp`)) { landed = true; writeFileSync(b.path, edited); }
            return value.apply(target, args);
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const result = await expectUnitNotAborted(() => b.sync(racing));
        expect(landed).toBe(true);
        expect(b.file()).toBe(edited);
        expect(result.failedFiles).toBe(1);
        expect(await b.versions(old)).toBeGreaterThan(0);
        expect(await b.body()).toBe(old.replace('Upstream 0', 'Upstream 1'));
        expect(await b.body(GOOD)).toContain('Upstream 1');
        expect(existsSync(`${b.path}.tmp`)).toBe(false);
      });
    }, 180_000);

    test('late database edit: the importer holds or versions the exact newer body, never loses it', async () => {
      await withSource(databaseUrl, async b => {
        const old = await b.body();
        const late = `${old}\n\nLATE-DB-EDIT: keep this exact paragraph.`;
        const file = b.file();
        let landed = false;
        const racing = new Proxy(b.engine, { get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop === 'transaction') return async (...args: unknown[]) => {
            if (!landed && existsSync(`${b.path}.tmp`)) {
              landed = true;
              const page = (await b.engine.getPage(BAD, { sourceId: SOURCE }))!;
              await b.engine.createVersion(BAD, { sourceId: SOURCE });
              await b.engine.putPage(BAD, { ...page, compiled_truth: late }, { sourceId: SOURCE });
            }
            return value.apply(target, args);
          };
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const result = await expectUnitNotAborted(() => b.sync(racing));
        expect(landed).toBe(true);
        expect({ retained: (await b.body()) === late || await b.versions(late) > 0 }).toEqual({ retained: true });
        expect(await b.versions(old)).toBeGreaterThan(0);
        expect(result.failedFiles).toBe(1);
        expect(b.file()).toBe(file);
        expect(await b.body(GOOD)).toContain('Upstream 1');
      });
    }, 180_000);

    test('write-through off: database imports continue without writing a divergent or absent file', async () => {
      await withSource(databaseUrl, async b => {
        await b.engine.setConfig('sync.write_through', 'false');
        _resetWriteThroughCacheForTest();
        const edited = b.file() + EDIT;
        writeFileSync(b.path, edited);
        const old = await b.body();
        const goodPath = join(b.root, `${GOOD}.md`);
        rmSync(goodPath);
        const result = await expectUnitNotAborted(() => b.sync());
        expect(result.failedFiles ?? 0).toBe(0);
        expect(b.file()).toBe(edited);
        expect(existsSync(goodPath)).toBe(false);
        expect(await b.body()).toContain('Upstream 1');
        expect(await b.body(GOOD)).toContain('Upstream 1');
        expect(await b.versions(old)).toBeGreaterThan(0);
        expect(existsSync(`${b.path}.tmp`)).toBe(false);
      });
    }, 180_000);

    for (const divergent of [false, true]) {
      test(`declared db_only prefix: ${divergent ? 'divergent' : 'agreeing'} file stays exact and absent sibling stays absent`, async () => {
        await withSource(databaseUrl, async b => {
          writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - people/\n');
          const file = b.file() + (divergent ? EDIT : '');
          writeFileSync(b.path, file);
          const old = await b.body();
          const sibling = await b.body(GOOD);
          const goodPath = join(b.root, `${GOOD}.md`);
          rmSync(goodPath);
          const result = await expectUnitNotAborted(() => b.sync());
          expect({ file: b.file(), siblingFile: existsSync(goodPath), body: await b.body(), sibling: await b.body(GOOD) })
            .toEqual({ file, siblingFile: false, body: old.replace('Upstream 0', 'Upstream 1'), sibling: sibling.replace('Upstream 0', 'Upstream 1') });
          expect(result.failedFiles ?? 0).toBe(0);
          expect(await b.versions(old)).toBeGreaterThan(0);
          expect(existsSync(`${b.path}.tmp`)).toBe(false);
          expect(existsSync(`${goodPath}.tmp`)).toBe(false);
        });
      }, 180_000);
    }

    test('segmented pages hold without changing either copy; agreeing inline controls import', async () => {
      await withSource(databaseUrl, async b => {
        const original = await b.body();
        const segmented = await segmentPage(b.engine, BAD, { sourceId: SOURCE, generation: 1, bodyBytes: Buffer.byteLength(original),
          occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: [{ text: original }] }] });
        const segments = await materializeSegmentedBody(b.engine, segmented.pageId, SOURCE);
        const file = b.file();
        const body = await b.body();
        const result = await expectUnitNotAborted(() => b.sync());
        expect(result.failedFiles).toBe(1);
        expect(b.file()).toBe(file);
        expect(await b.body()).toBe(body);
        expect(await materializeSegmentedBody(b.engine, segmented.pageId, SOURCE)).toEqual(segments);
        expect(await b.body(GOOD)).toContain('Upstream 1');
        expect(parseMarkdown(readFileSync(join(b.root, `${GOOD}.md`), 'utf8'), `${GOOD}.md`).compiled_truth).toBe(await b.body(GOOD));
      });
    }, 180_000);
  });
}
