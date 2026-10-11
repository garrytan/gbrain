import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {mentionBrain,resetMentionBrain} from './helpers/mention-brain.ts';
import {readRelationSnapshot,replaceDerivedLinks} from '../src/core/pmbrain-adapters/relation-writer.ts';
import {reconcileSourceLinks} from '../src/core/link-reconciliation.ts';
import {parseSchemaPackManifest} from '../src/core/schema-pack/manifest-v1.ts';
const pack=parseSchemaPackManifest({api_version:'gbrain-schema-pack-v1',name:'synthetic-reconcile',version:'1.0.0',extends:null,page_types:[],link_types:[{name:'owned_by'}],frontmatter_links:[{page_type:'decision',fields:['owner'],link_type:'owned_by'}]});
const sourceId='graph-primary';
async function rejection(operation:Promise<unknown>):Promise<unknown>{
 try{await operation;}catch(error){return error;}
 throw new Error('Expected operation to reject');
}
let engine:BrainEngine;
beforeAll(async()=>{engine=await mentionBrain();},120_000);
afterAll(async()=>{await engine.disconnect();});
beforeEach(async()=>{await resetMentionBrain(engine);await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)',[sourceId]);});
async function seed(slug:string,type:string,body='',frontmatter:Record<string,unknown>={}){await engine.putPage(slug,{type:type as never,title:slug.split('/').at(-1)!,compiled_truth:body,frontmatter},{sourceId});}
async function graph(){return engine.executeRaw<{from_slug:string;to_slug:string;from_source:string;to_source:string;link_type:string;link_source:string;origin_slug:string|null;origin_source:string|null}>(`SELECT f.slug from_slug,t.slug to_slug,f.source_id from_source,t.source_id to_source,l.link_type,l.link_source,o.slug origin_slug,o.source_id origin_source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id LEFT JOIN pages o ON o.id=l.origin_page_id WHERE f.source_id=$1 OR t.source_id=$1 ORDER BY f.slug,t.slug,l.link_type,l.link_source`,[sourceId]);}
async function origin(slug:string){const snapshot=(await readRelationSnapshot(engine,slug,sourceId))!;return{slug,sourceId,expectedRevision:snapshot.revision,sourceIncarnation:snapshot.sourceIncarnation};}
describe('upstream producer-scoped relationship replacement through the PMBrain adapter',()=>{
    test('reversed basename attendance requires the same origin, revision and person guards as Markdown attendance', async () => {
      await seed('meetings/planning', 'meeting');
      await seed('people/alice-example', 'person');
      const scope = await origin('meetings/planning');
      const person = (await readRelationSnapshot(engine,'people/alice-example',sourceId))!;
      const row = { from_slug: person.page.slug, to_slug: scope.slug, link_type: 'attended', link_source: 'wikilink-resolved',
        from_source_id: sourceId, to_source_id: sourceId, origin_slug: scope.slug, origin_source_id: sourceId };
      expect(String(await rejection(replaceDerivedLinks(engine, scope, [row])))).toContain('revision-bound person endpoints');
      expect(await graph()).toEqual([]);
      const expectedEndpoints = [{ slug: person.page.slug, sourceId, revision: person.revision }];
      expect(await replaceDerivedLinks(engine, scope, [row], { expectedEndpoints })).toEqual({ created: 1, removed: 0 });
      await seed(person.page.slug, 'company');
      const changed = (await readRelationSnapshot(engine,person.page.slug,sourceId))!;
      expect(String(await rejection(replaceDerivedLinks(engine, scope, [row], { expectedEndpoints })))).toContain('changed after type resolution');
      expect(String(await rejection(replaceDerivedLinks(engine, scope, [row], { expectedEndpoints: [{ ...expectedEndpoints[0], revision: changed.revision }] })))).toContain('person endpoints');
    });
    test('retained frontmatter identities update and clear evidence metadata', async () => {
      await seed('meetings/planning', 'meeting');
      await seed('people/alice-example', 'person');
      const scope = await origin('meetings/planning');
      const row = { from_slug: scope.slug, to_slug: 'people/alice-example', link_type: 'attended',
        link_source: 'frontmatter', from_source_id: sourceId, to_source_id: sourceId,
        origin_slug: scope.slug, origin_source_id: sourceId, context: 'Original evidence', origin_field: 'attendees' };
      await replaceDerivedLinks(engine, scope, [row], { preserveExisting: true });
      const evidence = () => engine.executeRaw<{ id: number; context: string; origin_field: string | null }>(
        `SELECT id,context,origin_field FROM links WHERE origin_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`,
        [sourceId, scope.slug]);
      const before = await evidence();
      expect(before).toHaveLength(1);
      expect(await replaceDerivedLinks(engine, scope, [{ ...row, context: 'Updated evidence', origin_field: 'participants' }],
        { preserveExisting: true })).toEqual({ created: 0, removed: 0 });
      expect(await evidence()).toEqual([{ id: before[0].id, context: 'Updated evidence', origin_field: 'participants' }]);
      expect(await replaceDerivedLinks(engine, scope, [{ ...row, context: undefined, origin_field: undefined }],
        { preserveExisting: true })).toEqual({ created: 0, removed: 0 });
      expect(await evidence()).toEqual([{ id: before[0].id, context: '', origin_field: null }]);
    });
    test('preserving replacement rolls back deleted and updated evidence when insertion fails', async () => {
      await seed('meetings/planning', 'meeting');
      for (const name of ['alice', 'bob', 'charlie']) await seed(`people/${name}-example`, 'person');
      const scope = await origin('meetings/planning');
      const row = (name: string, context: string) => ({ from_slug: scope.slug, to_slug: `people/${name}-example`,
        link_type: 'attended', link_source: 'frontmatter', from_source_id: sourceId, to_source_id: sourceId,
        origin_slug: scope.slug, origin_source_id: sourceId, origin_field: 'attendees', context });
      await replaceDerivedLinks(engine, scope, [row('alice', 'Original evidence'), row('bob', 'Removed evidence')], { preserveExisting: true });
      const evidence = () => engine.executeRaw(`SELECT * FROM links WHERE origin_page_id=(SELECT id FROM pages
        WHERE source_id=$1 AND slug=$2) ORDER BY id`, [sourceId, scope.slug]);
      const before = await evidence();
      const add = engine.addLinksBatch;
      engine.addLinksBatch = async () => { throw new Error('Injected insertion failure'); };
      try {
        expect(String(await rejection(replaceDerivedLinks(engine, scope, [row('alice', 'Updated evidence'), row('charlie', 'New evidence')],
          { preserveExisting: true })))).toContain('Injected insertion failure');
      } finally { engine.addLinksBatch = add; }
      expect(await evidence()).toEqual(before);
    });
    test('Markdown replacement keeps the same edge identity as legacy batch writers', async () => {
      await seed('notes/reference', 'note');
      await seed('people/target', 'person');
      for (const producer of ['markdown', 'wikilink-resolved']) {
        const link = { from_slug: 'notes/reference', to_slug: 'people/target', link_type: 'mentions',
          link_source: producer, from_source_id: sourceId, to_source_id: sourceId };
        await replaceDerivedLinks(engine, await origin('notes/reference'), [link]);
        expect(await engine.addLinksBatch([link])).toBe(0);
        expect(await graph()).toHaveLength(1);
        expect((await graph())[0].origin_slug).toBeNull();
      }
    });
    test('an unrecognized link producer is named in the rejection', async () => {
      await seed('notes/reference', 'note');
      await seed('people/target', 'person');
      const link = { from_slug: 'notes/reference', to_slug: 'people/target', link_type: 'mentions',
        link_source: 'made-up-producer', from_source_id: sourceId, to_source_id: sourceId };
      expect(String(await rejection(replaceDerivedLinks(engine, await origin('notes/reference'), [link])))).toContain('(got: "made-up-producer", allowed: markdown, wikilink-resolved, frontmatter)');
      expect(await graph()).toHaveLength(0);
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
    test('origin revision and target revision changes refuse replacement', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      await reconcileSourceLinks(engine, sourceId, { pack });
      const captured = await origin('choices/choice');
      const before = await graph();
      await seed('choices/choice', 'decision', 'new body', { owner: 'members/alice-example' });
      expect(await rejection(replaceDerivedLinks(engine, captured, []))).toMatchObject({ code: 'revision_conflict' });
      expect(await graph()).toEqual(before);
      const target = (await readRelationSnapshot(engine,'members/alice-example',sourceId))!;
      await seed('members/alice-example', 'company');
      expect(String(await rejection(replaceDerivedLinks(engine, await origin('choices/choice'), [{
        from_slug: 'choices/choice', to_slug: 'members/alice-example', link_type: 'owned_by', link_source: 'frontmatter',
      }], { expectedEndpoints: [{ slug: 'members/alice-example', sourceId, revision: target.revision }] })))).toContain('endpoint changed');
      expect(await graph()).toEqual(before);
    });
    test('a missing endpoint cannot silently delete the previously consistent graph', async () => {
      await seed('members/alice-example', 'person');
      await seed('choices/choice', 'decision', '', { owner: 'members/alice-example' });
      expect((await reconcileSourceLinks(engine, sourceId, { pack })).ok).toBe(true);
      const before = await graph();
      expect(String(await rejection(replaceDerivedLinks(engine, await origin('choices/choice'), [{
        from_slug: 'choices/choice', to_slug: 'members/missing-example', link_type: 'owned_by', link_source: 'frontmatter',
      }])))).toContain('endpoint');
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
      expect((await replaceDerivedLinks(engine, await origin('sessions/weekly'), [])).removed).toBe(1);
      expect((await graph()).map(row => row.origin_slug)).toEqual(['sessions/other']);
    });
});
