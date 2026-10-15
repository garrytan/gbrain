import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import type { BrainEngine } from '../src/core/engine';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';
import { selectEntityCaptureCandidates } from '../src/core/cycle/capture-entities';
import { pendingCaptureCandidates, publishCaptureManifest } from '../src/core/pmbrain-adapters/entity-capture-manifest';
import {resetPgliteState} from './helpers/reset-pglite.ts';
import {createHash} from 'node:crypto';

const previous = process.env.PMBRAIN_HOME;
const home = mkdtempSync(join(tmpdir(), 'pmbrain-capture-manifest-'));
const url = process.env.PMBRAIN_RELATION_TEST_DATABASE_URL;
let engine: BrainEngine;
beforeAll(async () => {
  process.env.PMBRAIN_HOME = home;
  if (url) assertSafeE2eDatabaseUrl(url);
  engine = url ? new PostgresEngine() : new PGLiteEngine();
  await engine.connect(url ? { database_url: url } : {});
  await engine.initSchema();
  await resetPgliteState(engine as PGLiteEngine);
}, 60000);
afterAll(async () => {
  await engine.disconnect();
  if (previous === undefined) delete process.env.PMBRAIN_HOME;
  else process.env.PMBRAIN_HOME = previous;
  rmSync(home, { recursive: true, force: true });
}, 60000);

test('有效处理清单只检查元数据，不读取未变化正文；来源、目标或图谱改变都会失效', async () => {
  await engine.putPage('notes/manifest', { type: 'note', title: '原文', compiled_truth: '团队采用三纪早会体系，持续检查计划与风险。' });
  await engine.putPage('concepts/manifest', { type: 'concept', title: '三纪早会体系', compiled_truth: '团队采用三纪早会体系。' });
  const source = (await selectEntityCaptureCandidates(engine, 'default', { metadataOnly: true, slugs: ['notes/manifest'] }))[0]!;
  const options = { model: 'test:model', contract: 'existing contract' };
  await publishCaptureManifest(engine, source, [{ slug: 'concepts/manifest', sourceId: 'default' }], 1, options);
  const getPage = engine.getPage;
  engine.getPage = async () => { throw new Error('不应读取正文'); };
  try { expect(await pendingCaptureCandidates(engine, [source], options)).toEqual([]); }
  finally { engine.getPage = getPage; }
  expect(await pendingCaptureCandidates(engine, [source], { ...options, model: 'changed:model' })).toHaveLength(1);
  await engine.putPage('concepts/manifest', { type: 'concept', title: '三纪早会体系', compiled_truth: '用户修改后的实体事实。' });
  expect(await pendingCaptureCandidates(engine, [source], options)).toHaveLength(1);
  await publishCaptureManifest(engine, source, [{ slug: 'concepts/manifest', sourceId: 'default' }], 1, options);
  expect(await pendingCaptureCandidates(engine, [source], options)).toEqual([]);
  const warning={sourcePage:'concepts/manifest',sourceId:'default',target:'missing',reason:'证据不足'};
  await publishCaptureManifest(engine,source,[{slug:'concepts/manifest',sourceId:'default'}],1,{...options,unresolved:[warning]});
  const warnings:unknown[]=[];
  expect(await pendingCaptureCandidates(engine,[source],{...options,onCached:(_page,manifest)=>warnings.push(...(manifest.unresolved??[]))})).toEqual([]);
  expect(warnings).toEqual([warning]);
  const [target]=await engine.executeRaw<{id:number;revision:string}>("SELECT id,knowledge_revision::text revision FROM pages WHERE slug='concepts/manifest' AND source_id='default'");
  const proof={id:target!.id,revision:target!.revision,title:'三纪早会体系',type:'concept',aliases:'[]',lines:[createHash('sha256').update('用户修改后的实体事实。').digest('hex')]};
  await publishCaptureManifest(engine,source,[{slug:'concepts/manifest',sourceId:'default'}],1,{...options,proofs:[proof]});
  await engine.putPage('concepts/manifest',{type:'concept',title:'三纪早会体系',compiled_truth:'用户修改后的实体事实。\n其他资料补充的新事实。'});
  await engine.putPage('notes/other-manifest',{type:'note',title:'另一资料',compiled_truth:'另一份资料使用三纪早会体系，不改变原资料的事实凭据。'});
  await engine.addLinksBatch([{from_slug:'notes/other-manifest',to_slug:'concepts/manifest',link_type:'mentions',from_source_id:'default',to_source_id:'default'}]);
  engine.getPage=async()=>{throw new Error('追加其他资料事实不应重读原文');};
  try{expect(await pendingCaptureCandidates(engine,[source],options)).toEqual([]);}finally{engine.getPage=getPage;}
  await engine.putPage('concepts/manifest',{type:'concept',title:'三纪早会体系',compiled_truth:'原有事实已被用户删除，需要重新确认。'});
  expect(await pendingCaptureCandidates(engine,[source],options)).toHaveLength(1);
  await publishCaptureManifest(engine,source,[{slug:'concepts/manifest',sourceId:'default'}],1,options);
  await engine.addLinksBatch([{ from_slug: source.slug, to_slug: 'concepts/manifest', link_type: 'mentions', context: '三纪早会体系', from_source_id: 'default', to_source_id: 'default' }]);
  expect(await pendingCaptureCandidates(engine, [source], options)).toHaveLength(1);
  await publishCaptureManifest(engine, source, [{ slug: 'concepts/manifest', sourceId: 'default' }], 1, options);
  await engine.executeRaw("UPDATE links SET link_source='manual' WHERE from_page_id=$1",[source.pageId]);
  expect(await pendingCaptureCandidates(engine,[source],options)).toHaveLength(1);
  await publishCaptureManifest(engine,source,[{slug:'concepts/manifest',sourceId:'default'}],1,options);
  await engine.executeRaw("UPDATE links SET link_kind='typed_ner' WHERE from_page_id=$1",[source.pageId]);
  expect(await pendingCaptureCandidates(engine,[source],options)).toHaveLength(1);
  await publishCaptureManifest(engine,source,[{slug:'concepts/manifest',sourceId:'default'}],1,options);
  await engine.executeRaw("UPDATE links SET origin_page_id=$1 WHERE from_page_id=$1",[source.pageId]);
  expect(await pendingCaptureCandidates(engine,[source],options)).toHaveLength(1);
  await publishCaptureManifest(engine,source,[{slug:'concepts/manifest',sourceId:'default'}],1,options);
  await engine.putPage(source.slug, { type: 'note', title: '原文', compiled_truth: '原文的内容已经修改，需要重新检查变化。' });
  const changed = (await selectEntityCaptureCandidates(engine, 'default', { metadataOnly: true, slugs: [source.slug] }))[0]!;
  expect(await pendingCaptureCandidates(engine, [changed], options)).toHaveLength(1);
});

test('候选用稳定游标分页，不重复或漏掉同时间更新的页面', async () => {
  for (let index = 0; index < 7; index++) await engine.putPage(`notes/paged-${index}`, { type: 'note', title: '分页原文', compiled_truth: '这是一份需要按稳定身份分页检查的原始资料。' });
  const seen: Array<number | string | undefined> = [];
  let afterPageId = 0;
  for (;;) {
    const batch = await selectEntityCaptureCandidates(engine, 'default', { metadataOnly: true, afterPageId, limit: 3 });
    if (!batch.length) break;
    seen.push(...batch.map(page => page.pageId));
    afterPageId = Number(batch.at(-1)!.pageId);
  }
  expect(seen.length).toBeGreaterThanOrEqual(8);
  expect(new Set(seen).size).toBe(seen.length);
});
