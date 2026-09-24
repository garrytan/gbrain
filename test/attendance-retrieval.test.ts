import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractLinksForSlugs, runExtract, runExtractCore } from '../src/commands/extract.ts';
import { prepareAutomaticLinks } from '../src/core/persistence/links-preparation.ts';
import { disposePersistenceConsumer, persistenceConsumerStatus } from '../src/core/persistence/service.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { extractPageLinks } from '../src/core/link-extraction.ts';
import { extractLinksFromFile, extractStaleFromDB } from '../src/commands/extract.ts';
import { operations } from '../src/core/operations.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/index.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const sourceId = 'attendance-fixture';
const person = 'people/alice-example';
const meeting = 'meetings/planning';
const positive = 'Attendees: [Alice](../people/alice-example.md)';

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`non-overridden canonical attendance lifecycle (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let root: string;
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      root = mkdtempSync(join(tmpdir(), 'gbrain-attendance-'));
      await engine.setConfig('schema_pack', 'absent-attendance-fixture');
      await engine.setConfig('dream.synthesize.session_corpus_dir', root);
    }, 120_000);
    afterAll(async () => { await close?.(); rmSync(root, { recursive: true, force: true }); });
    afterEach(async () => { await disposePersistenceConsumer(engine); });
    beforeEach(async () => {
      expect(persistenceConsumerStatus(engine).state).toBe('not_running');
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      await engine.setConfig('schema_pack', 'absent-attendance-fixture');
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      await seed(person, 'person', 'An example engineer.');
    });
    async function seed(slug: string, type: string, body: string, frontmatter: Record<string, unknown> = {}) {
      await engine.putPage(slug, { type, title: slug, compiled_truth: body, frontmatter }, { sourceId });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body || slug }], { sourceId });
      const path = join(root, `${slug}.md`);
      mkdirSync(dirname(path), { recursive: true });
      const fields = Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('');
      writeFileSync(path, `---\ntype: ${type}\ntitle: ${slug}\n${fields}---\n${body}`);
    }
    async function attendees() {
      return (await buildRelationalArm(engine, 'Who attended meetings/planning?', { sourceId })).map(row => row.slug);
    }
    async function extract(lane: string, all = false) {
      if (lane === 'db') return runExtract(engine, [all ? 'all' : 'links', '--source', 'db', '--source-id', sourceId]);
      else if (lane === 'stale') return extractStaleFromDB(engine, { sourceIdFilter: sourceId, quiet: true, dryRun: false, jsonMode: false, catchUp: true });
      else if (lane === 'fs-batch') return runExtractCore(engine, { mode: all ? 'all' : 'links', dir: root, sourceId, quiet: true });
      else if (lane === 'fs-incremental') return runExtractCore(engine, { mode: all ? 'all' : 'links', dir: root, sourceId, slugs: [meeting, person], quiet: true });
      else if (lane === 'fs-sync') return extractLinksForSlugs(engine, root, [meeting, person], { sourceId });
      else if (lane === 'prepare') {
        for (const slug of [meeting, person]) {
          const page = (await engine.getPage(slug, { sourceId }))!;
          const prepared = await prepareAutomaticLinks(engine, slug, page, sourceId);
          await engine.transaction(async tx => { await tx.lockPageKeys(prepared.pageKeys); await prepared.apply(tx); });
        }
      } else await runMaintenanceSweep(engine, { sourceId, budgetMs: 60_000, batchLimit: 20,
        capabilities: { embeddings: { available: false }, extraction: { available: false }, search: 'keyword-only', mode: 'keyless' } });
    }
    for (const lane of ['fs-sync', 'fs-incremental', 'fs-batch']) {
      test(`${lane}: ordinary meeting links keep additive filesystem handling`, async () => {
        await seed(meeting, 'meeting', '[Alice](../people/alice-example.md)');
        await extract(lane);
        expect((await engine.getLinks(meeting, { sourceId })).map(row => row.to_slug)).toEqual([person]);
        await seed(meeting, 'meeting', 'An ordinary reference was removed, with no attendance claim.');
        await extract(lane);
        expect((await engine.getLinks(meeting, { sourceId })).map(row => row.to_slug)).toEqual([person]);
      });
      test(`${lane}: unchanged DB-only attendance survives and real evidence removal retracts it`, async () => {
        await seed(meeting, 'meeting', positive);
        await extract('db');
        rmSync(join(root, `${person}.md`));
        await extract(lane);
        expect(await attendees()).toEqual([person]);
        await seed(meeting, 'meeting', 'The supported attendance evidence was removed.');
        await extract(lane);
        expect(await attendees()).toEqual([]);
      });
    }
    for (const lane of ['fs-sync', 'fs-incremental', 'fs-batch', 'prepare', 'sweep', 'db', 'stale']) {
      test(`${lane}: missing display-label slugs do not make actual attendance incomplete`, async () => {
        await seed(meeting, 'meeting', 'Attendees: [people/missing-example](../people/alice-example.md)');
        await extract(lane);
        expect(await attendees()).toEqual([person]);
      });
      for (const policy of ['explicit', 'federated-default']) test(`${lane}: ${policy} foreign attendance survives complete resolution`, async () => {
        const peer = 'attendance-peer';
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [peer]);
        const target = 'people/foreign-example';
        await engine.putPage(target, { type: 'person', title: 'Foreign example', compiled_truth: 'DB-only person.' }, { sourceId: peer });
        await engine.setConfig('link_resolution.cross_source', policy === 'explicit' ? 'true' : 'false');
        await engine.setConfig('sources.default', peer);
        if (policy === 'federated-default') await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{federated}','true'::jsonb) WHERE id=$1", [sourceId]);
        const body = `Attendees: [[${policy === 'explicit' ? `${peer}:` : ''}${target}]]`;
        try {
          await seed(meeting, 'meeting', body);
          await extract('db');
          await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, meeting]);
          await extract(lane, true);
          const rows = await engine.executeRaw<{ from_source: string; to_source: string }>(`SELECT f.source_id AS from_source,t.source_id AS to_source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND o.slug=$2 AND l.link_type='attended'`, [sourceId, meeting]);
          expect(rows).toEqual([{ from_source: peer, to_source: sourceId }]);
          await engine.setConfig('link_resolution.cross_source', 'false');
          await engine.executeRaw("UPDATE sources SET config=jsonb_set(config,'{federated}','false'::jsonb) WHERE id=$1", [sourceId]);
          await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, meeting]);
          const denied = await extract(lane, true);
          if (lane === 'fs-sync') expect((denied as { processed: string[] }).processed).not.toContain(meeting);
          expect((await engine.executeRaw('SELECT id FROM links WHERE origin_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [sourceId, meeting])).length).toBe(1);
          expect((await engine.executeRaw<{ links_extracted_at: string | null }>('SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, meeting]))[0].links_extracted_at).toBeNull();
        } finally {
          await engine.setConfig('link_resolution.cross_source', 'false');
          await engine.setConfig('sources.default', 'default');
          await engine.executeRaw('DELETE FROM sources WHERE id=$1', [peer]);
        }
      });
      test(`${lane}: unresolved attendance cannot retract owned graph or mark success`, async () => {
        await seed(meeting, 'meeting', positive);
        await extract('db');
        await seed(meeting, 'meeting', 'Attendees: [[people/missing-example]]');
        await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1 AND slug=$2', [sourceId, meeting]);
        const unresolved = await extract(lane, true);
        if (lane === 'fs-sync') expect((unresolved as { processed: string[] }).processed).not.toContain(meeting);
        expect(await attendees()).toEqual([person]);
        expect((await engine.executeRaw<{ links_extracted_at: string | null }>('SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, meeting]))[0].links_extracted_at).toBeNull();
      });
      for (const fence of ['~~~', '```']) test(`${lane}: section-nested ${fence} examples never persist attendance`, async () => {
        await seed(meeting, 'meeting', `## Attendees\n${fence}\n## Example\n${positive}\n${fence}`);
        await extract(lane);
        expect(await attendees()).toEqual([]);
      });
    }
    for (const lane of ['fs-incremental', 'fs-sync']) {
      test(`${lane}: imported hidden meetings get guarded canonical attendance`, async () => {
        const hidden = '.github/planning';
        const extractHidden = () => lane === 'fs-sync'
          ? extractLinksForSlugs(engine, root, [hidden], { sourceId })
          : runExtractCore(engine, { mode: 'links', dir: root, sourceId, slugs: [hidden], quiet: true });
        await seed(hidden, 'meeting', positive);
        await extractHidden();
        expect((await engine.getBacklinks(hidden, { sourceId })).filter(row => row.link_type === 'attended')
          .map(row => row.from_slug)).toEqual([person]);
        await seed(hidden, 'meeting', 'No attendance evidence.');
        await extractHidden();
        expect((await engine.getBacklinks(hidden, { sourceId })).filter(row => row.link_type === 'attended')).toEqual([]);
      });
    }

    test('fs-sync: an ordinary missing target does not discard later links or processed status', async () => {
      const note = 'notes/reference';
      await seed(note, 'note', '[Missing](../people/missing-example.md)\n[Alice](../people/alice-example.md)');
      writeFileSync(join(root, 'people/missing-example.md'), '---\ntype: person\n---\nNot imported.');
      const result = await extractLinksForSlugs(engine, root, [note], { sourceId });
      expect(result).toEqual({ created: 1, processed: [note] });
      expect((await engine.getLinks(note, { sourceId })).map(row => row.to_slug)).toEqual([person]);
    });

    for (const lane of ['fs-incremental', 'fs-sync']) {
      test(`${lane}: file-only meeting declarations cannot bypass the database origin type`, async () => {
        const hidden = '.github/not-a-meeting';
        await seed(hidden, 'note', positive);
        writeFileSync(join(root, `${hidden}.md`), `---\ntype: meeting\n---\n${positive}`);
        const result = lane === 'fs-sync'
          ? await extractLinksForSlugs(engine, root, [hidden], { sourceId })
          : await runExtractCore(engine, { mode: 'all', dir: root, sourceId, slugs: [hidden], quiet: true });
        expect(lane === 'fs-sync' ? (result as { processed: string[] }).processed.length
          : (result as { pages_processed: number }).pages_processed).toBe(0);
        expect((await engine.getBacklinks(hidden, { sourceId })).filter(row => row.link_type === 'attended')).toEqual([]);
        const stamp = await engine.executeRaw<{ links_extracted_at: string | null }>(
          'SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, hidden]);
        expect(stamp[0].links_extracted_at).toBeNull();
      });
    }

    for (const lane of ['db', 'stale', 'fs-batch', 'fs-incremental', 'fs-sync', 'prepare', 'sweep']) {
      test(`${lane}: display-label person slugs do not assert extra attendees`, async () => {
        await seed('people/bob-example', 'person', 'A person named only in the display label.');
        await seed(meeting, 'meeting', 'Attendees: [people/bob-example](../people/alice-example.md)');
        await extract(lane);
        expect(await attendees()).toEqual([person]);
      });
      test(`${lane}: ambiguous bare references do not assert either attendee`, async () => {
        await seed('demo-example', 'person', 'One possible person.');
        await seed('đemo-example', 'person', 'Another possible person.');
        await seed(meeting, 'meeting', 'Attendees: [[Đemo Example]]');
        await extract(lane);
        expect(await attendees()).toEqual([]);
      });
      test(`${lane}: actual extraction persists, queries and removes meeting-owned Markdown`, async () => {
        await seed(meeting, 'meeting', positive);
        await extract(lane);
        expect(await attendees()).toEqual([person]);
        const edge = (await engine.getLinks(person, { sourceId })).find(row => row.link_type === 'attended')!;
        expect(edge).toMatchObject({ from_slug: person, to_slug: meeting, link_source: 'markdown', origin_slug: meeting });
        expect((await engine.relationalFanout([person], { sourceId, direction: 'out', linkTypes: ['attended'] })).map(row => row.slug)).toContain(meeting);
        await seed(person, 'person', 'Updated person with no attendance claim.');
        await extract(lane);
        expect(await attendees()).toEqual([person]);
        await seed(meeting, 'meeting', 'No attendance evidence remains.');
        await extract(lane);
        expect(await attendees()).toEqual([]);
      });
    }
    test('local put_page and remote deferred sweep preserve the actual Markdown producer', async () => {
      const op = operations.find(op => op.name === 'put_page')!;
      const ctx = { engine, config: { engine: kind as 'pglite' | 'postgres' }, remote: false, sourceId,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await op.handler(ctx, { slug: meeting, content: `---\ntype: meeting\ntitle: Planning\n---\n${positive}` });
      expect(await attendees()).toEqual([person]);
      const snapshot = (await engine.readPageSnapshot(meeting, { sourceId }))!;
      await op.handler({ ...ctx, remote: true }, { slug: meeting, expected_revision: snapshot.revision,
        content: '---\ntype: meeting\ntitle: Planning\n---\nNo attendance evidence remains.' });
      await extract('sweep');
      expect(await attendees()).toEqual([]);
    });
    test('local put_page commits unresolved attendance content while preserving retryable graph', async () => {
      await seed(meeting, 'meeting', positive);
      await extract('db');
      const snapshot = (await engine.readPageSnapshot(meeting, { sourceId }))!;
      const body = 'Attendees: [[people/missing-example]]';
      const op = operations.find(op => op.name === 'put_page')!;
      const result = await op.handler({ engine, config: { engine: kind as 'pglite' | 'postgres' }, remote: false, sourceId,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } }, { slug: meeting, expected_revision: snapshot.revision,
        content: `---\ntype: meeting\ntitle: Planning\n---\n${body}` }) as { auto_links: { errors: number; unresolved_count: number } };
      expect((await engine.getPage(meeting, { sourceId }))?.compiled_truth).toBe(body);
      expect(result.auto_links.errors).toBe(1);
      expect(result.auto_links.unresolved_count).toBeGreaterThan(0);
      expect(await attendees()).toEqual([person]);
      const rows = await engine.executeRaw<{ stale: boolean }>('SELECT links_extracted_at IS NULL OR updated_at>links_extracted_at AS stale FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, meeting]);
      expect(rows[0].stale).toBe(true);
    });
    test('actual put_page and query operations retain and remove the supported attendee', async () => {
      const put = operations.find(op => op.name === 'put_page')!;
      const query = operations.find(op => op.name === 'query')!;
      const ctx = { engine, config: { engine: kind as 'pglite' | 'postgres' }, remote: false, sourceId,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const params = { query: 'Who attended meetings/planning?', expand: false, relational: true, limit: 10 };
      await put.handler(ctx, { slug: meeting, content: `---\ntype: meeting\ntitle: Planning\n---\n${positive}` });
      const before = await query.handler(ctx, params) as Array<{ slug: string }>;
      expect(before.map(row => row.slug)).toContain(person);
      const snapshot = (await engine.readPageSnapshot(meeting, { sourceId }))!;
      await put.handler(ctx, { slug: meeting, expected_revision: snapshot.revision,
        content: '---\ntype: meeting\ntitle: Planning\n---\nNo attendance evidence remains.' });
      const after = await query.handler(ctx, params) as Array<{ slug: string }>;
      expect(after.map(row => row.slug)).not.toContain(person);
    });
    test('canonical frontmatter and body keep distinct provenance without duplicate people', async () => {
      await seed(meeting, 'meeting', positive, { attendees: [person] });
      await runExtract(engine, ['links', '--source', 'db', '--source-id', sourceId, '--include-frontmatter']);
      expect(await attendees()).toEqual([person]);
      expect((await engine.getLinks(person, { sourceId })).map(row => [row.link_source, row.origin_slug]).sort()).toEqual([
        ['frontmatter', meeting], ['markdown', meeting],
      ]);
      await seed(meeting, 'meeting', 'No references remain.');
      await runExtract(engine, ['links', '--source', 'db', '--source-id', sourceId, '--include-frontmatter']);
      expect(await attendees()).toEqual([]);
    });
    test('ambiguous or non-person canonical frontmatter stays unresolved', async () => {
      await engine.putPage('people/peer-example', { type: 'person', title: 'Shared name', compiled_truth: 'Another person.' }, { sourceId });
      await engine.putPage(person, { type: 'person', title: 'Shared name', compiled_truth: 'A person.' }, { sourceId });
      await seed('people/company-example', 'company', 'Not a person.');
      await seed(meeting, 'meeting', 'No body links.', { attendees: ['Shared name', 'people/company-example'] });
      await runExtract(engine, ['links', '--source', 'db', '--source-id', sourceId, '--include-frontmatter']);
      expect(await engine.getBacklinks(meeting, { sourceId })).toEqual([]);
    });
    for (const lane of ['fs-sync', 'fs-incremental']) test(`${lane}: canonical frontmatter persists and removes under its meeting origin`, async () => {
      const apply = async () => lane === 'fs-sync'
        ? extractLinksForSlugs(engine, root, [meeting, person], { sourceId, includeFrontmatter: true })
        : runExtractCore(engine, { mode: 'links', dir: root, slugs: [meeting, person], sourceId, includeFrontmatter: true, quiet: true });
      await seed(meeting, 'meeting', 'No body links.', { attendees: [person] });
      await apply();
      expect(await attendees()).toEqual([person]);
      expect((await engine.getLinks(person, { sourceId }))[0]).toMatchObject({ link_source: 'frontmatter', origin_slug: meeting, origin_source_id: sourceId });
      await seed(person, 'person', 'Still no attendance claim on the person.');
      await apply();
      expect(await attendees()).toEqual([person]);
      await seed(meeting, 'meeting', 'Attendees removed.');
      await apply();
      expect(await attendees()).toEqual([]);
    });
    test('private attendees and unsealed projections remain excluded from remote retrieval', async () => {
      await seed(meeting, 'meeting', positive);
      await extract('db');
      expect(await attendees()).toEqual([person]);
      expect((await buildRelationalArm(engine, 'Who attended meetings/planning?', { sourceId, excludePrivate: true, requireSafeChunks: true })).map(row => row.slug)).toEqual([person]);
      await seed(person, 'person', 'A private attendee.', { visibility: 'private' });
      expect(await buildRelationalArm(engine, 'Who attended meetings/planning?', { sourceId, excludePrivate: true, requireSafeChunks: true })).toEqual([]);
      await engine.putPage(person, { type: 'person', title: 'Unsealed person', compiled_truth: 'An unprojected replacement.' }, { sourceId });
      expect(await buildRelationalArm(engine, 'Who attended meetings/planning?', { sourceId, requireSafeChunks: true })).toEqual([]);
    });
    test('single and batch writers round-trip Markdown origin without exposing an ungranted origin', async () => {
      await seed(meeting, 'meeting', positive);
      await extract('db');
      const original = (await engine.getLinks(person, { sourceId }))[0];
      await engine.removeLink(person, meeting, 'attended', 'markdown', { fromSourceId: sourceId, toSourceId: sourceId });
      await engine.addLink(person, meeting, original.context, 'attended', 'markdown', meeting, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      expect((await engine.getLinks(person, { sourceId }))[0]).toEqual(original);
      expect(await engine.addLinksBatch([{ from_slug: person, to_slug: meeting, link_type: 'attended', link_source: 'markdown',
        from_source_id: sourceId, to_source_id: sourceId, origin_slug: meeting, origin_source_id: sourceId }])).toBe(0);
      const hidden = 'attendance-origin';
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1) ON CONFLICT DO NOTHING', [hidden]);
      await engine.putPage('notes/hidden', { type: 'note', title: 'Hidden origin', compiled_truth: 'Independent.' }, { sourceId: hidden });
      await engine.addLink(person, meeting, 'Other origin', 'mentions', 'markdown', 'notes/hidden', undefined,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: hidden });
      expect((await engine.getLinks(person, { sourceIds: [sourceId] })).find(row => row.link_type === 'mentions')).toMatchObject({ origin_slug: null, origin_source_id: null });
    });
    test('failed filesystem attendance replacement stays retryable and preserves the last good graph', async () => {
      await seed(meeting, 'meeting', positive);
      await extract('fs-sync');
      await seed(meeting, 'meeting', 'No references remain.');
      const replace = engine.replaceDerivedLinks;
      engine.replaceDerivedLinks = async () => { throw new Error('Injected replacement failure'); };
      try {
        const result = await extractLinksForSlugs(engine, root, [meeting], { sourceId });
        expect(result.processed).toEqual([]);
        expect(await attendees()).toEqual([person]);
      } finally { engine.replaceDerivedLinks = replace; }
      expect((await extractLinksForSlugs(engine, root, [meeting], { sourceId })).processed).toEqual([meeting]);
      expect(await attendees()).toEqual([]);
    });
    for (const lane of ['fs-batch', 'fs-incremental']) test(`${lane}: failed attendance replacement does not advance its watermark`, async () => {
      const apply = () => runExtractCore(engine, { mode: 'all', dir: root, sourceId, quiet: true,
        ...(lane === 'fs-incremental' ? { slugs: [meeting, person] } : {}) });
      await seed(meeting, 'meeting', positive);
      await apply();
      await seed(meeting, 'meeting', 'No references remain.');
      const stamp = () => engine.executeRaw('SELECT links_extracted_at FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, meeting]);
      const before = await stamp();
      expect(before[0].links_extracted_at).not.toBeNull();
      const replace = engine.replaceDerivedLinks;
      engine.replaceDerivedLinks = async () => { throw new Error('Injected replacement failure'); };
      try {
        await apply();
        expect(await stamp()).toEqual(before);
        expect(await attendees()).toEqual([person]);
      } finally { engine.replaceDerivedLinks = replace; }
      await apply();
      expect(await attendees()).toEqual([]);
      expect(await stamp()).not.toEqual(before);
    });
    for (const packName of ['gbrain-base', 'company-brain']) test(`${packName}: pack_semantics_preserved`, async () => {
      await engine.setConfig('schema_pack', packName);
      await seed(meeting, 'meeting', positive, { attendees: [person] });
      await runExtract(engine, ['links', '--source', 'db', '--source-id', sourceId, '--include-frontmatter']);
      const rows = (await engine.getLinks(meeting, { sourceId })).filter(row => row.link_type === 'attended');
      expect(rows.map(row => row.link_source).sort()).toEqual(['frontmatter', 'markdown']);
      expect(rows.every(row => row.to_slug === person)).toBe(true);
      expect(await attendees()).toEqual([]);
      expect((await engine.relationalFanout([meeting], { sourceId, direction: 'out', linkTypes: ['attended'] })).map(row => row.slug)).toContain(person);
    });
    test('manual and other-origin rows survive exact meeting removal', async () => {
      await seed(meeting, 'meeting', positive);
      await seed('notes/evidence', 'note', 'Independent evidence.');
      await extract('db');
      await engine.addLink(person, meeting, 'Manual evidence', 'attended', 'manual', undefined, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
      await engine.addLink(person, meeting, 'Other origin', 'attended', 'markdown', 'notes/evidence', undefined,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      const preservedIds = () => engine.executeRaw(`SELECT id FROM links WHERE link_source='manual'
        OR origin_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug='notes/evidence') ORDER BY id`, [sourceId]);
      const before = await preservedIds();
      await seed(meeting, 'meeting', 'No references remain.');
      await extract('prepare');
      expect(await preservedIds()).toEqual(before);
      const rows = await engine.getLinks(person, { sourceId });
      expect(rows.map(row => [row.link_source, row.origin_slug]).sort()).toEqual([
        ['manual', null], ['markdown', 'notes/evidence'],
      ]);
    });
    for (const [lane, packName] of [
      ['prepare', 'absent-attendance-fixture'], ['prepare', 'gbrain-base'],
      ['sweep', 'absent-attendance-fixture'], ['fs-batch', 'absent-attendance-fixture'],
      ['fs-incremental', 'absent-attendance-fixture'], ['fs-sync', 'absent-attendance-fixture'],
    ]) test(`${lane}/${packName}: retained link identities refresh their evidence`, async () => {
      await engine.setConfig('schema_pack', packName);
      await seed(meeting, 'meeting', `${positive}\n\nRoom one.`);
      await extract(lane);
      const evidence = () => engine.executeRaw<{ id: number; context: string }>(`SELECT l.id,l.context FROM links l
        JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE l.link_type='attended' AND f.source_id=$1 AND t.source_id=$1`, [sourceId]);
      const before = await evidence();
      expect(before).toHaveLength(1);
      expect(before[0].context).toContain('Room one.');
      await seed(meeting, 'meeting', `${positive}\n\nRoom two.`);
      await extract(lane);
      const after = await evidence();
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(before[0].id);
      expect(after[0].context).toContain('Room two.');
      expect(after[0].context).not.toContain('Room one.');
    });
    for (const lane of ['fs-batch', 'fs-incremental', 'fs-sync']) test(`${lane}: unknown legacy producers survive attendance reconciliation`, async () => {
      await seed(meeting, 'meeting', positive);
      await engine.addLink(meeting, person, 'Legacy unrelated claim', 'related', 'manual', undefined, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
      await engine.executeRaw(`UPDATE links SET link_source=NULL WHERE link_type='related'
        AND from_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, meeting]);
      const legacyRows = () => engine.executeRaw(`SELECT id, context, link_type, link_source, origin_page_id FROM links
        WHERE link_type='related' AND from_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, meeting]);
      const before = await legacyRows();
      expect(before).toHaveLength(1);
      await extract(lane);
      expect(await attendees()).toEqual([person]);
      expect(await legacyRows()).toEqual(before);
      await seed(meeting, 'meeting', 'No attendance evidence remains.');
      await extract(lane);
      expect(await attendees()).toEqual([]);
      expect(await legacyRows()).toEqual(before);
    });
    test('reversed Markdown validation requires matching origin, types and captured endpoint revisions', async () => {
      await seed(meeting, 'meeting', positive);
      const snapshot = (await engine.readPageSnapshot(meeting, { sourceId }))!;
      const endpoint = (await engine.readPageSnapshot(person, { sourceId }))!;
      const origin = { slug: meeting, sourceId, expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation };
      const row = { from_slug: person, to_slug: meeting, from_source_id: sourceId, to_source_id: sourceId,
        link_type: 'attended', link_source: 'markdown', origin_slug: meeting, origin_source_id: sourceId };
      await expect(engine.replaceDerivedLinks(origin, [{ ...row, link_type: 'mentions' }])).rejects.toThrow();
      await expect(engine.replaceDerivedLinks(origin, [{ ...row, origin_source_id: 'default' }])).rejects.toThrow();
      await expect(engine.replaceDerivedLinks(origin, [row])).rejects.toThrow();
      await seed(person, 'company', 'A retyped endpoint.');
      await expect(engine.replaceDerivedLinks(origin, [row], { expectedEndpoints: [{ slug: person, sourceId, revision: endpoint.revision }] })).rejects.toThrow();
      const retyped = (await engine.readPageSnapshot(person, { sourceId }))!;
      await expect(engine.replaceDerivedLinks(origin, [row], { expectedEndpoints: [{ slug: person, sourceId, revision: retyped.revision }] })).rejects.toThrow('person endpoints');
      expect(await engine.getLinks(person, { sourceId })).toEqual([]);
    });
    test('source identities are resolved before reversing qualified Markdown', async () => {
      const other = 'attendance-other';
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [other]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [other]);
      await engine.putPage(person, { type: 'person', title: 'Foreign example', compiled_truth: 'Foreign attendee.' }, { sourceId: other });
      await seed(meeting, 'meeting', `Attendees: [[${other}:${person}]]`);
      await engine.setConfig('link_resolution.cross_source', 'true');
      try {
        await extract('db');
        const rows = await engine.executeRaw(`SELECT f.source_id from_source, t.source_id to_source, o.source_id origin_source
          FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
          JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1 AND o.slug=$2`, [sourceId, meeting]);
        expect(rows).toEqual([{ from_source: other, to_source: sourceId, origin_source: sourceId }]);
        expect(await engine.getLinks(person, { sourceId })).toEqual([]);
        expect(await engine.getLinks(person, { sourceIds: [other], requireSafeChunks: true, excludePrivate: true })).toEqual([]);
        await seed(meeting, 'meeting', 'Removed.');
        await extract('db');
        expect(await engine.executeRaw('SELECT 1 FROM links l JOIN pages o ON o.id=l.origin_page_id WHERE o.source_id=$1', [sourceId])).toEqual([]);
      } finally { await engine.setConfig('link_resolution.cross_source', 'false'); }
    });
    for (const body of [
      '[Alice](../people/alice-example.md) did not attend.',
      'Invited [Alice](../people/alice-example.md) for next month.',
      'Discussed a proposal from [Alice](../people/alice-example.md).',
      'Attendees: [Alice](../people/alice-example.md) (absent)',
      '## Attendees\n- [Alice](../people/alice-example.md) was invited',
      '```md\nAttendees: [Alice](../people/alice-example.md)\n```',
    ]) test(`DB does not promote unsupported evidence: ${body}`, async () => {
      await seed(meeting, 'meeting', body);
      await extract('db');
      expect((await engine.getLinks(meeting, { sourceId })).filter(row => row.link_type === 'attended')).toEqual([]);
      expect(await attendees()).toEqual([]);
    });
  });
}

describe('shared and filesystem canonical attendance grammar', () => {
  test('large malformed lists are bounded and never accept a valid prefix', async () => {
    const { attendanceEvidenceRanges } = await import('../src/core/link-extraction.ts');
    const started = performance.now();
    expect(attendanceEvidenceRanges(`${positive} ${'['.repeat(65_536)}`)).toEqual([]);
    expect(attendanceEvidenceRanges('Attendees: [nested[Alice](../people/alice-example.md)]')).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
  const types = new Map([[person, 'person'], ['people/company-example', 'company'], [meeting, 'meeting']]);
  const resolver = { async resolve(value: string) { return types.has(value) ? value : null; } };
  test('nonmatching constrained attendance rules preserve pack ownership and outgoing mentions', async () => {
    const pack = parseSchemaPackManifest({ api_version: 'gbrain-schema-pack-v1', name: 'constrained-attendance',
      version: '1.0.0', extends: null, page_types: [], frontmatter_links: [],
      link_types: [{ name: 'attended', inference: { page_type: 'meeting', target_type: 'person', regex: 'confirmed-attendance' } }] });
    const shared = await extractPageLinks(meeting, positive, {}, 'meeting', resolver, { pack, targetType: slug => types.get(slug) });
    expect(shared.candidates).toHaveLength(1);
    expect(shared.candidates[0]).toMatchObject({ targetSlug: person, linkType: 'mentions' });
    expect(shared.candidates[0].canonicalAttendance).not.toBe(true);
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${positive}`, `${meeting}.md`, new Set(types.keys()), { pack, pageTypes: types });
    expect(fs).toHaveLength(1);
    expect(fs[0]).toMatchObject({ from_slug: meeting, to_slug: person, link_type: 'mentions' });
    expect(fs[0].origin_slug).toBeUndefined();
  });
  test('ambiguous bare attendance names stay nonassertive without changing ordinary expansion', async () => {
    const targets = new Map([[meeting, 'meeting'], ['demo-example', 'person'], ['đemo-example', 'person']]);
    for (const body of ['Attendees: [[Đemo Example]]', 'See [[Đemo Example]]']) {
      const shared = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => targets.get(slug) });
      expect(shared.candidates.map(row => row.targetSlug).sort()).toEqual(['demo-example', 'đemo-example']);
      expect(shared.candidates.every(row => row.linkType === 'mentions' && !row.canonicalAttendance)).toBe(true);
      const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(targets.keys()), { pageTypes: targets });
      expect(fs).toHaveLength(1);
      expect(fs[0]).toMatchObject({ from_slug: meeting, to_slug: 'đemo-example', link_type: 'mentions' });
    }
    targets.delete('demo-example');
    const body = 'Attendees: [[Đemo Example]]';
    const shared = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => targets.get(slug) });
    expect(shared.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug)).toEqual(['đemo-example']);
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(targets.keys()), { pageTypes: targets });
    expect(fs[0]).toMatchObject({ from_slug: 'đemo-example', to_slug: meeting, link_type: 'attended' });
  });
  test('a canonical mention does not reverse a separate pack-owned edge to the same target', async () => {
    const pack = parseSchemaPackManifest({ api_version: 'gbrain-schema-pack-v1', name: 'mixed-attendance',
      version: '1.0.0', extends: null, page_types: [], frontmatter_links: [],
      link_types: [{ name: 'attended', inference: { regex: '\\bpresent\\b' } }] });
    const body = `present [Alice](../people/alice-example.md)\n\n${'Notes. '.repeat(100)}\n\n${positive}`;
    const shared = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { pack, targetType: slug => types.get(slug) });
    expect(shared.candidates.filter(row => row.linkType === 'attended').map(row => row.canonicalAttendance ?? false).sort()).toEqual([false, true]);
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pack, pageTypes: types });
    expect(fs.filter(row => row.link_type === 'attended').map(row => row.from_slug).sort()).toEqual([meeting, person]);
  });
  const positiveBodies = [positive, 'Attendees: [Alice](people/alice-example.md)', 'Attendees: [[people/alice-example]]',
    'Attendees: [Alice](/people/alice-example.md)', '## Attendees\n- [Alice](../people/alice-example.md)\n\n## Notes\nDiscussed work.'];
  for (const body of positiveBodies) test(body, async () => {
    const shared = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
    expect(shared.candidates.some(row => row.linkType === 'attended' && row.canonicalAttendance)).toBe(true);
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
    expect(fs.some(row => row.link_type === 'attended' && row.from_slug === person && row.origin_slug === meeting)).toBe(true);
  });
  for (const body of ['Attendees: [Company](../people/company-example.md)', 'Attendees: [Missing](../people/missing.md)',
    'Attendees: [Alice](../people/alice-example.md) maybe', 'Attendees: `not` [Alice](../people/alice-example.md)',
    '~~~md\nAttendees: [Alice](../people/alice-example.md)\n~~~', '    Attendees: [Alice](../people/alice-example.md)',
    '## Attendees\n- [Alice](../people/alice-example.md)\nNobody attended.',
    'Reference to [Alice](../people/alice-example.md).\n## Attendees\nNobody attended.']) test(`not evidence: ${body}`, async () => {
    const shared = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => types.get(slug) });
    expect(shared.candidates.some(row => row.linkType === 'attended')).toBe(false);
    const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(types.keys()), { pageTypes: types });
    expect(fs.some(row => row.link_type === 'attended')).toBe(false);
  });
});
