import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
const root = mkdtempSync(join(tmpdir(), 'gbrain-semantic-pages-'));
const sourceId = 'semantic-pages-test';
let ctx: OperationContext;
const submit = (operation: string, params: Record<string, unknown>) => submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } });
beforeAll(async () => {
  engine=new PGLiteEngine();
  ctx={engine,config:{engine:'pglite'},sourceId,remote:false,dryRun:false,logger:{info(){},warn(){},error(){}}};
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId,root]);
  await submit('put_page', { slug: 'page', content: '---\ntype: note\ntitle: Example\n---\nStable prose\n' });
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

test('concurrent semantic tag mutations preserve every accepted tag and coherent file snapshot', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => submit('add_tag', { slug: 'page', tag: `tag-${i}` })));
  expect(results.every(result => result.state === 'committed')).toBe(true);
  const snapshot = (await engine.readPageSnapshot('page', { sourceId }))!;
  expect(snapshot.tags).toEqual(Array.from({ length: 6 }, (_, i) => `tag-${i}`));
  expect(snapshot.page.compiled_truth).toContain('Stable prose');
  for (const tag of snapshot.tags) expect(readFileSync(join(root,'page.md'),'utf8')).toContain(tag);
  const revision = snapshot.revision;
  const replay = await submit('add_tag', { slug: 'page', tag: 'tag-0' });
  expect(replay.revision).toBe(revision);
});

test('timeline replay is an exact no-op in Markdown, revision, versions and structured rows', async () => {
  const params = { slug: 'page', date: '2026-09-15', summary: 'Example milestone', detail: 'Example detail', source: 'example-source' };
  await submit('add_timeline_entry', params);
  const before = (await engine.readPageSnapshot('page', { sourceId }))!;
  const file = join(root,'page.md');
  const bytes = readFileSync(file,'utf8');
  const modified = statSync(file).mtimeMs;
  const versions = await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id]);
  const replay = await submit('add_timeline_entry', params);
  expect(replay.status).toBe('skipped');
  expect((await engine.readPageSnapshot('page', { sourceId }))!.revision).toBe(before.revision);
  expect(readFileSync(file,'utf8')).toBe(bytes);
  expect(statSync(file).mtimeMs).toBe(modified);
  expect(await engine.executeRaw('SELECT id FROM page_versions WHERE page_id=$1', [before.page.id])).toEqual(versions);
  expect(await engine.getTimeline('page', { sourceId })).toHaveLength(1);
});

test('concurrent takes append, supersession and resolution publish one canonical row set', async () => {
  const added = await Promise.all(Array.from({ length: 4 }, (_, i) => submit('takes_add', {
    slug:'page',claim:`Example belief ${i}`,kind:'take',holder:'world',weight:0.6,
  })));
  expect(new Set(added.map(result=>result.row_num)).size).toBe(4);
  const superseded=await submit('takes_supersede',{slug:'page',row_num:added[0].row_num,claim:'Updated example belief'});
  const request_id=randomUUID();
  const resolve={slug:'page',row_num:superseded.new_row,quality:'correct',evidence:'Example evidence',request_id};
  const committed=await submit('takes_resolve',resolve);
  const before=(await engine.readPageSnapshot('page',{sourceId}))!;
  const result=await submit('takes_resolve',resolve);
  expect(result.revision).toBe(committed.revision);
  expect((await engine.readPageSnapshot('page',{sourceId}))!.revision).toBe(before.revision);
  const rows=await engine.executeRaw<{ row_num:number; active:boolean; resolved_quality:string|null }>('SELECT row_num,active,resolved_quality FROM takes WHERE page_id=$1 ORDER BY row_num',[before.page.id]);
  expect(rows).toHaveLength(5);
  expect(rows.find(row=>row.row_num===Number(superseded.old_row))!.active).toBe(false);
  expect(rows.find(row=>row.row_num===Number(superseded.new_row))!.resolved_quality).toBe('correct');
  expect((await engine.getChunks('page',{sourceId})).map(chunk=>chunk.chunk_text).join('\n')).not.toContain('Example belief');
});

test('canonical replacement and revert restore facts, takes and timeline from complete versions', async () => {
  const fact = (rowNum:number,claim:string) => renderFactsTable([{rowNum,claim,kind:'fact',confidence:1,
    visibility:'world',notability:'medium',active:true}]);
  const take = (rowNum:number,claim:string) => renderTakesFence([{rowNum,claim,kind:'take',holder:'world',weight:0.7,active:true}]);
  const content=`---\ntitle: Projection example\ntype: note\n---\nFirst body\n${fact(1,'First fact')}\n${take(1,'First take')}\n\n<!-- timeline -->\n\n## Timeline\n- **2026-09-15** | manual — First event\n${fact(2,'Second fact')}\n${take(2,'Second take')}`;
  await submit('put_page',{slug:'projections',content});
  const before=(await engine.readPageSnapshot('projections',{sourceId}))!;
  expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL',[sourceId,'projections'])).toHaveLength(2);
  expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1',[before.page.id])).toHaveLength(2);
  await submit('put_page',{slug:'projections',content:'---\ntitle: Replacement\ntype: note\n---\nReplacement body',expected_revision:before.revision});
  expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL',[sourceId,'projections'])).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1',[before.page.id])).toHaveLength(0);
  expect(await engine.getTimeline('projections',{sourceId})).toHaveLength(0);
  const [version]=await engine.executeRaw<{id:number}>('SELECT id FROM page_versions WHERE page_id=$1 AND knowledge_revision=$2::uuid',[before.page.id,before.revision]);
  const current=(await engine.readPageSnapshot('projections',{sourceId}))!;
  await submit('revert_version',{slug:'projections',version_id:version.id,expected_revision:current.revision});
  const restored=(await engine.readPageSnapshot('projections',{sourceId}))!;
  expect(serializePageToMarkdown(restored.page,restored.tags)).toBe(serializePageToMarkdown(before.page,before.tags));
  expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL',[sourceId,'projections'])).toHaveLength(2);
  expect(await engine.executeRaw('SELECT id FROM takes WHERE page_id=$1',[before.page.id])).toHaveLength(2);
  expect(await engine.getTimeline('projections',{sourceId})).toHaveLength(1);
  const invalid=content.replace('Second fact','Conflicting fact').replace('| 2 | Conflicting fact','| 1 | Conflicting fact');
  await expect(submit('put_page',{slug:'projections',content:invalid,expected_revision:restored.revision})).rejects.toMatchObject({code:'invalid_params'});
  expect((await engine.readPageSnapshot('projections',{sourceId}))!.revision).toBe(restored.revision);
});

test('timeline detail citations remain in canonical bytes and replay without phantom events', async () => {
  const params={slug:'page',date:'2026-09-16',summary:'Cited milestone',detail:'First detail\nSee [Source: example, 2026-09-14] evidence',source:'manual'};
  await submit('add_timeline_entry',params);
  const before=(await engine.readPageSnapshot('page',{sourceId}))!;
  expect(before.page.timeline).toContain('See [Source: example, 2026-09-14] evidence');
  const rows=await engine.getTimeline('page',{sourceId});
  expect(rows.filter(row=>row.summary==='Cited milestone')).toHaveLength(1);
  expect(rows.some(row=>String(row.date).startsWith('2026-09-14'))).toBe(false);
  expect((await submit('add_timeline_entry',params)).revision).toBe(before.revision);
});
