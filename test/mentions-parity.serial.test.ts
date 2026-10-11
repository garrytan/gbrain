import {expect,test} from 'bun:test';
import type {BrainEngine} from '../src/core/engine.ts';
import {PGLiteEngine} from '../src/core/pglite-engine.ts';
import {PostgresEngine} from '../src/core/postgres-engine.ts';
import {setCliOptions} from '../src/core/cli-options.ts';
import {extractStaleFromDB} from '../src/commands/extract-stale.ts';
import {assertSafeE2eDatabaseUrl} from './helpers/db-guard.ts';
import {resetMentionBrain,page,mentionLinks,sweep} from './helpers/mention-brain.ts';
async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  const put = (slug: string, type: string, title: string, body: string) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await put('crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO\nOwner: Dana Example');
  await put('crm/124', 'crm', 'CRM record: Quormiro Labs', 'Account code: QULA');
  await put('people/dana', 'person', 'Dana Example', 'Account owner.');
  for (let i = 0; i < 14; i++) await put(`tickets/t${String(i).padStart(2, '0')}`, 'ticket', `Ticket ${i}`, `Customer: QUCO\nStatus: ${i === 3 ? 'Open' : 'Closed'}`);
  await put('meetings/m1', 'meeting', 'Meeting: QULA renewal prep', 'Quormiro asked about Dana Example.');
  await put('notes/lower', 'note', 'Lowercase', 'quco is not a code here');
  // Distinct referrer dates: both engines order the newest-first page identically,
  // independent of how many writes share one clock tick.
  await engine.executeRaw(
    `UPDATE pages SET effective_date = TIMESTAMPTZ '2026-01-01T00:00:00Z' + (substring(slug from 10)::int * INTERVAL '1 day')
      WHERE slug LIKE 'tickets/t%'`);
}

async function snapshot(engine: BrainEngine) {
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null,  });
  const sweep = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  const links = await engine.executeRaw<{ f: string; t: string }>(
    `SELECT f.slug AS f, t.slug AS t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions' ORDER BY 1, 2`);
  const aliases = await engine.executeRaw<{ slug: string; alias_norm: string; origin: string; case_sensitive: boolean }>(
    'SELECT slug, alias_norm, origin, case_sensitive FROM page_aliases ORDER BY slug, origin, alias_norm');
  const columns = await engine.executeRaw<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'page_aliases' ORDER BY column_name`);
  return {
    mentions: { state: sweep.mentions?.state, remaining: sweep.mentions?.remaining },
    links: links.map(r => `${r.f}->${r.t}`),
    aliases: aliases.map(r => `${r.slug}:${r.origin}:${r.alias_norm}:${r.case_sensitive}`),
    columns: columns.map(r => r.column_name),
  };
}


test('both engines produce the same incremental index, aliases and mention relationships',async()=>{
 const pglite=new PGLiteEngine();await pglite.connect({});await pglite.initSchema();
 try{
  await seed(pglite);const expected=await snapshot(pglite);
  expect(expected.mentions).toEqual({state:'complete',remaining:0});expect(expected.links).toHaveLength(17);
  expect(expected.links).toContain('meetings/m1->crm/124');expect(expected.links).not.toContain('notes/lower->crm/123');
  expect(expected.columns).toEqual(expect.arrayContaining(['origin','case_sensitive','alias_text']));
  const url=process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
  if(url){assertSafeE2eDatabaseUrl(url);const pg=new PostgresEngine();await pg.connect({database_url:url});
   try{await pg.initSchema();await resetMentionBrain(pg);await seed(pg);expect(await snapshot(pg)).toEqual(expected);}finally{await pg.disconnect();}
  }
 }finally{await pglite.disconnect();}
},120_000);

test('Chinese stopwords are configurable and catalog fingerprints reopen affected pages',async()=>{
 const engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();await engine.setConfig('schema_pack','gbrain-base-v2');
 try{
  await page(engine,'companies/platform','company','平台','虚构公司');await page(engine,'notes/input','note','资料','平台发布了资料。');
  await sweep(engine);expect(await mentionLinks(engine)).toEqual([]);
  await engine.setConfig('mentions.chinese_stopwords','[]');await sweep(engine);
  expect(await mentionLinks(engine)).toEqual(['notes/input -> companies/platform']);
  await engine.setConfig('mentions.chinese_stopwords','["平台"]');await sweep(engine);expect(await mentionLinks(engine)).toEqual([]);
 }finally{await engine.disconnect();}
},60_000);
