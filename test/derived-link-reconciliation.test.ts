import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadLinkPageMetadata, makeIndexedLinkResolver, reconcileSourceLinks } from '../src/core/link-reconciliation.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { readCommittedBlob } from '../src/core/company-brain/revision.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const pack = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1', name: 'synthetic-reconcile', version: '1.0.0', extends: null,
  page_types: [],
  link_types: [
    { name: 'competes_with', inference: { page_type: 'competitor', target_type: 'company', regex: 'competes with' } },
    { name: 'attended', inference: { page_type: 'meeting', target_type: 'person' } },
    { name: 'owned_by' },
  ],
  frontmatter_links: [
    { page_type: 'decision', fields: ['owner'], link_type: 'owned_by' },
    { page_type: 'meeting', fields: ['attendees'], link_type: 'attended' },
  ],
});
const sourceId = 'graph-primary';
const otherSource = 'graph-other';

for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])]) {
  describe(`derived link reconciliation (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    beforeEach(async () => {
      for (const source of [sourceId, otherSource]) {
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [source]);
      }
    });
    afterAll(async () => { await close?.(); });

    async function seed(slug: string, type: string, body = '', frontmatter: Record<string, unknown> = {}, source = sourceId) {
      await engine.putPage(slug, { type, title: slug.split('/').at(-1)!, compiled_truth: body, frontmatter }, { sourceId: source });
    }
    async function graph() {
      return engine.executeRaw<{ from_slug: string; to_slug: string; from_source: string; to_source: string;
        link_type: string; link_source: string; origin_slug: string | null; origin_source: string | null }>(
        `SELECT f.slug from_slug,t.slug to_slug,f.source_id from_source,t.source_id to_source,
         l.link_type,l.link_source,o.slug origin_slug,o.source_id origin_source
         FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
         LEFT JOIN pages o ON o.id=l.origin_page_id
         WHERE f.source_id=$1 OR t.source_id=$1 ORDER BY f.slug,t.slug,l.link_type,l.link_source`, [sourceId]);
    }
    async function origin(slug: string) {
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
      return { slug, sourceId, expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation };
    }

    test('full-source scans resolve new targets and retype unchanged origins without N+1 target reads', async () => {
      await seed('rivals/rival-example', 'competitor', 'competes with [[organizations/company-example]].');
      let result = await reconcileSourceLinks(engine, sourceId, { pack });
      expect(result.ok).toBe(true);
      expect(result.unresolved.some(ref => ref.target === 'organizations/company-example')).toBe(true);
      expect(await graph()).toHaveLength(0);
      const before = await origin('rivals/rival-example');
      await seed('organizations/company-example', 'company');
      const originalGetPage = engine.getPage;
      engine.getPage = async () => { throw new Error('Per-reference getPage is forbidden'); };
      try {
        result = await reconcileSourceLinks(engine, sourceId, { pack });
      } finally { engine.getPage = originalGetPage; }
      expect(result.ok).toBe(true);
      expect((await graph()).map(row => row.link_type)).toEqual(['competes_with']);
      await seed('organizations/company-example', 'decision');
      result = await reconcileSourceLinks(engine, sourceId, { pack });
      expect(result.ok).toBe(true);
      expect((await graph()).map(row => row.link_type)).toEqual(['mentions']);
      expect((await origin('rivals/rival-example')).expectedRevision).toBe(before.expectedRevision);
      await engine.deletePage('organizations/company-example', { sourceId });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).unresolved).toHaveLength(1);
      expect(await graph()).toHaveLength(0);
      await seed('organizations/company-example', 'company');
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      expect((await graph()).map(row => row.link_type)).toEqual(['competes_with']);
    });

    test('Markdown replacement keeps the same edge identity as legacy batch writers', async () => {
      await seed('notes/reference', 'note');
      await seed('people/target', 'person');
      for (const producer of ['markdown', 'wikilink-resolved']) {
        const link = { from_slug: 'notes/reference', to_slug: 'people/target', link_type: 'mentions',
          link_source: producer, from_source_id: sourceId, to_source_id: sourceId };
        await engine.replaceDerivedLinks(await origin('notes/reference'), [link]);
        expect(await engine.addLinksBatch([link])).toBe(0);
        expect(await graph()).toHaveLength(1);
        expect((await graph())[0].origin_slug).toBeNull();
      }
    });

    test('owner replacement removes old derived edges, preserves manual rows, and is replay-safe', async () => {
      await seed('members/alice-example', 'person');
      await seed('members/bob-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      await engine.addLink('choices/choice', 'members/alice-example', 'manual evidence', 'owned_by', 'manual', undefined, undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      await seed('choices/choice', 'decision', '', { owner: 'members/bob-example' });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      const rows = await graph();
      expect(rows.map(row => [row.to_slug, row.link_source])).toEqual([
        ['members/alice-example', 'manual'], ['members/bob-example', 'frontmatter'],
      ]);
      expect(rows[1].origin_slug).toBe('choices/choice');
      expect(rows[1].origin_source).toBe(sourceId);
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      expect(await graph()).toEqual(rows);
    });

    test('profile meeting direction has no inverse edge and decisions never become attendees', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision');
      await seed('sessions/weekly', 'meeting', 'See [[choices/choice]].', { attendees: ['members/alice-example'] });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      expect((await graph()).map(row => [row.from_slug, row.to_slug, row.link_type])).toEqual([
        ['sessions/weekly', 'choices/choice', 'mentions'], ['sessions/weekly', 'members/alice-example', 'attended'],
      ]);
    });

    test('duplicate slugs never borrow target types or origins from another source', async () => {
      await seed('organizations/shared', 'person');
      await seed('organizations/shared', 'company', '', {}, otherSource);
      await seed('rivals/rival-example', 'competitor', 'competes with [[organizations/shared]] and [[graph-other:organizations/shared]].');
      await seed('rivals/rival-example', 'competitor', 'competes with [[organizations/shared]].', {}, otherSource);
      expect((await reconcileSourceLinks(engine, otherSource, { pack })).ok).toBe(true);
      const result = await reconcileSourceLinks(engine, sourceId, { pack });
      expect(result.ok).toBe(true);
      expect(result.unresolved).toEqual([{ originSlug: 'rivals/rival-example', target: 'graph-other:organizations/shared', reason: 'cross_source' }]);
      expect((await graph()).map(row => [row.from_source, row.to_source, row.link_type])).toEqual([[sourceId, sourceId, 'mentions']]);
      const foreign = await engine.executeRaw(`SELECT l.link_type FROM links l JOIN pages o ON o.id=COALESCE(l.origin_page_id,l.from_page_id) WHERE o.source_id=$1`, [otherSource]);
      expect(foreign).toEqual([{ link_type: 'competes_with' }]);
    });

    test('explicit same-source frontmatter qualifications resolve without permitting foreign fallback', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: '[[graph-primary:members/alice-example]]' });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      expect((await graph()).map(row => [row.to_slug, row.to_source, row.link_type])).toEqual([
        ['members/alice-example', sourceId, 'owned_by'],
      ]);
      await seed('choices/choice', 'decision', '', { owner: '[[graph-primary:members/missing-example]]' });
      const result = await reconcileSourceLinks(engine, sourceId, { pack });
      expect(result.unresolved[0].reason).toBe('missing_target');
      expect(await graph()).toHaveLength(0);
    });

    test('inspection and reconciliation agree on aliases, basenames, ambiguity and unsupported bare Markdown', async () => {
      const profile = await loadResolvedPackByName('company-brain');
      const root = mkdtempSync(join(tmpdir(), 'company-reference-parity-'));
      const markdown = (type: string, title: string, metadata = '', body = '') =>
        `---\ntype: ${type}\ntitle: ${title}\n${metadata}---\n${body}\n`;
      const files = {
        'people/operator-key.md': markdown('person', 'Different Person Title', 'aliases: [Duty owner, Common name]\n'),
        'people/peer-key.md': markdown('person', 'Another Person', 'aliases: [Common name]\n'),
        'customers/by-alias.md': markdown('customer', 'Alias Account', 'owner: Duty owner\n'),
        'customers/by-basename.md': markdown('customer', 'Basename Account', 'owner: operator-key\n'),
        'customers/by-title.md': markdown('customer', 'Title Account', 'owner: Different Person Title\n'),
        'customers/ambiguous.md': markdown('customer', 'Ambiguous Account', 'owner: Common name\n'),
        'customers/bare-body.md': markdown('customer', 'Body Account', '', 'See [[operator-key]] and [[Duty owner]].'),
        'customers/foreign.md': markdown('customer', 'Foreign Account', 'owner: Offsource alias\n'),
        'decisions/old.md': markdown('decision', 'Historical Decision'),
        'meetings/constrained.md': markdown('meeting', 'Constrained Meeting', 'attendees: ["[[decisions/old]]"]\n'),
      };
      try {
        for (const [path, content] of Object.entries(files)) {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), content);
        }
        const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args],
          { stdio: 'pipe' });
        await makeGitFixture(root); git('add', '.'); git('commit', '-qm', 'Create synthetic reference parity fixture');
        const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain', pack: profile });
        expect(plan.ready).toBe(true);
        const references = (path: string) => plan.manifest.find(entry => entry.path === path)!.page!.references;
        for (const path of ['by-alias', 'by-basename', 'by-title']) {
          expect(references(`customers/${path}.md`)).toMatchObject([
            { kind: 'frontmatter', resolution: 'resolved', resolved_slug: 'people/operator-key', link_type: 'owned_by' },
          ]);
        }
        expect(references('customers/ambiguous.md')[0].resolution).toBe('ambiguous');
        expect(references('customers/bare-body.md').map(ref => ref.resolution)).toEqual(['unresolved', 'unresolved']);
        expect(references('customers/foreign.md')[0].resolution).toBe('unresolved');
        expect(references('meetings/constrained.md')[0].resolution).toBe('unresolved');
        expect(plan.findings.some(item => item.code === 'target_type_mismatch')).toBe(true);
        for (const entry of plan.manifest) {
          if (entry.disposition !== 'included') continue;
          const parsed = parseMarkdown((await readCommittedBlob(plan.revision!, entry)).toString('utf8'), entry.path, { activePack: profile.manifest });
          await engine.putPage(entry.page!.slug, { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth,
            timeline: parsed.timeline, frontmatter: parsed.frontmatter }, { sourceId });
        }
        await seed('people/offsource', 'person', '', { aliases: ['Offsource alias'] }, otherSource);
        await seed('people/operator-key', 'decision', '', { aliases: ['Duty owner'] }, otherSource);
        const resolver = makeIndexedLinkResolver(await loadLinkPageMetadata(engine), sourceId);
        expect(await resolver.resolve('Duty owner')).toBe('people/operator-key');
        expect(await resolver.resolve('Offsource alias')).toBeNull();
        expect(await resolver.resolve(`${otherSource}:people/operator-key`)).toBeNull();
        expect(await resolver.resolve('Common name')).toBeNull();
        const result = await reconcileSourceLinks(engine, sourceId, { pack: profile.manifest });
        expect(result.ok).toBe(true);
        expect((await graph()).map(row => [row.from_slug, row.to_slug, row.link_type])).toEqual([
          ['customers/by-alias', 'people/operator-key', 'owned_by'],
          ['customers/by-basename', 'people/operator-key', 'owned_by'],
          ['customers/by-title', 'people/operator-key', 'owned_by'],
        ]);
        expect(result.unresolved.some(ref => ref.originSlug === 'customers/ambiguous')).toBe(true);
        expect(result.unresolved.some(ref => ref.originSlug === 'customers/foreign')).toBe(true);
        expect(result.unresolved.some(ref => ref.originSlug === 'meetings/constrained' && ref.reason === 'target_type_mismatch')).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test('failed insert rolls back deletion and returns failure without a freshness stamp', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      const before = await graph();
      const original = engine.addLinksBatch;
      engine.addLinksBatch = async () => { throw new Error('Private injected write failure'); };
      try {
        const result = await reconcileSourceLinks(engine, sourceId, { pack });
        expect(result.ok).toBe(false);
        expect(result.complete).toBe(false);
        expect(result.pagesProcessed).toBe(0);
        expect(result.failures).toEqual([{ originSlug: 'choices/choice', code: 'graph_write_failed' }]);
        expect(JSON.stringify(result)).not.toContain('Private');
      } finally { engine.addLinksBatch = original; }
      expect(await graph()).toEqual(before);
      const stamps = await engine.executeRaw(`SELECT links_extracted_at FROM pages WHERE source_id=$1`, [sourceId]);
      expect(stamps.every(row => row.links_extracted_at === null)).toBe(true);
    });

    test('origin revision and target revision changes refuse replacement', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      await reconcileSourceLinks(engine, sourceId, { pack });
      const captured = await origin('choices/choice');
      const before = await graph();
      await seed('choices/choice', 'decision', 'new body', { owner: 'members/alice-example' });
      await expect(engine.replaceDerivedLinks(captured, [])).rejects.toMatchObject({ code: 'revision_conflict' });
      expect(await graph()).toEqual(before);
      const target = (await engine.readPageSnapshot('members/alice-example', { sourceId }))!;
      await seed('members/alice-example', 'company');
      await expect(engine.replaceDerivedLinks(await origin('choices/choice'), [{
        from_slug: 'choices/choice', to_slug: 'members/alice-example', link_type: 'owned_by', link_source: 'frontmatter',
      }], { expectedEndpoints: [{ slug: 'members/alice-example', sourceId, revision: target.revision }] })).rejects.toThrow('endpoint changed');
      expect(await graph()).toEqual(before);
    });

    test('a missing endpoint cannot silently delete the previously consistent graph', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      const before = await graph();
      await expect(engine.replaceDerivedLinks(await origin('choices/choice'), [{
        from_slug: 'choices/choice', to_slug: 'members/missing-example', link_type: 'owned_by', link_source: 'frontmatter',
      }])).rejects.toThrow('endpoint');
      expect(await graph()).toEqual(before);
    });

    test('unattributable frontmatter fails closed; legacy outgoing markdown is safely replaced', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision');
      const scope = { fromSourceId: sourceId, toSourceId: sourceId };
      await engine.addLink('choices/choice', 'members/alice-example', '', 'mentions', 'markdown', undefined, undefined, scope);
      const replaced = await engine.replaceDerivedLinks(await origin('choices/choice'), []);
      expect(replaced.removed).toBe(1);
      await engine.addLink('members/alice-example', 'choices/choice', '', 'attended', 'frontmatter', undefined, undefined, scope);
      const before = await graph();
      const result = await reconcileSourceLinks(engine, sourceId, { pack });
      expect(result.ok).toBe(false);
      expect(result.failures[0].code).toBe('derived_link_provenance_required');
      expect(await graph()).toEqual(before);
    });

    test('incoming derived rows belong to their origin, not their from-page', async () => {
      await seed('members/alice-example', 'person');
      await seed('sessions/weekly', 'meeting');
      await seed('sessions/other', 'meeting');
      for (const slug of ['sessions/weekly', 'sessions/other']) {
        await engine.addLink('members/alice-example', slug, '', 'attended', 'frontmatter', slug, 'attendees',
          { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      }
      expect((await engine.replaceDerivedLinks(await origin('sessions/weekly'), [])).removed).toBe(1);
      expect((await graph()).map(row => row.origin_slug)).toEqual(['sessions/other']);
    });

    test('bounded resume commits only successful origins and rejects recreated sources', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      const first = await reconcileSourceLinks(engine, sourceId, { pack, limit: 1 });
      expect(first.ok).toBe(true);
      expect(first.complete).toBe(false);
      expect(first.pagesProcessed).toBe(1);
      const second = await reconcileSourceLinks(engine, sourceId, { pack, afterSlug: first.nextAfterSlug, limit: 1 });
      expect(second.ok).toBe(true);
      expect(second.complete).toBe(true);
      const oldSource = (await origin('choices/choice')).sourceIncarnation;
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [sourceId]);
      const refused = await reconcileSourceLinks(engine, sourceId, { pack, expectedSourceIncarnation: oldSource });
      expect(refused.ok).toBe(false);
      expect(refused.failures).toEqual([{ code: 'source_identity_changed' }]);
    });

    test('bounded cursors use one ordering for punctuation and Unicode on both engines', async () => {
      const slugs = ['notes/a-b', 'notes/a/b', 'notes/aa', 'notes/β', 'notes/中'];
      for (const slug of slugs) await seed(slug, 'note');
      const visited: string[] = [];
      let afterSlug: string | undefined;
      for (let i = 0; i < slugs.length; i++) {
        const result = await reconcileSourceLinks(engine, sourceId, { pack, afterSlug, limit: 1 });
        expect(result.ok).toBe(true);
        expect(result.pagesProcessed).toBe(1);
        visited.push(result.nextAfterSlug!);
        afterSlug = result.nextAfterSlug;
        expect(result.complete).toBe(i === slugs.length - 1);
      }
      expect(visited).toEqual([...slugs].sort());
    });
  });
}
