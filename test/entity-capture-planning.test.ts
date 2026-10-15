import { expect,test } from 'bun:test';
import { captureScopeKey,captureChunkKey,planCaptureBodies,compileCaptureContract,sourceTimelineDates } from '../src/core/pmbrain-adapters/entity-capture-plan.ts';
import { readIngestContract,locateIngestSkillsDir } from '../src/core/pmbrain-adapters/entity-ingest-workflow.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const identity={sourceId:'vault',slug:'notes/a',pageId:1,sourceIncarnation:'one',title:'资料',model:'mimo:test',contract:'contract-one'};

test('实体分块凭据跟随实际输入，页内位置和其他段落变化不影响命中',()=>{
  const scope=captureScopeKey(identity);
  const body='未变化的段落';
  expect(captureChunkKey(scope,body)).toBe(captureChunkKey(captureScopeKey({...identity}),body));
  for(const change of [{sourceId:'other'},{pageId:2},{sourceIncarnation:'two'},{title:'新标题'},{model:'other:model'},{contract:'contract-two'}]){
    expect(captureChunkKey(captureScopeKey({...identity,...change}),body)).not.toBe(captureChunkKey(scope,body));
  }
  expect(captureChunkKey(scope,body+'新增事实')).not.toBe(captureChunkKey(scope,body));
});

test('变化一段或前插一段时，既有成功分块仍按正文命中且全篇有覆盖',()=>{
  const body=Array.from({length:2400},(_,i)=>`${i}号记录内容。`).join('');
  const first=[...planCaptureBodies(body,[])];
  expect(first.length).toBeGreaterThan(2);
  for(const changed of ['新增开头。'+body,body.slice(0,1500)+'明确新增事实。'+body.slice(1500)]){
    const next=[...planCaptureBodies(changed,first.map(item=>item.body))];
    expect(next.filter(item=>item.reused).length).toBeGreaterThanOrEqual(first.length-1);
    expect(next.filter(item=>!item.reused).length).toBe(1);
    const coverage=new Uint8Array(changed.length);
    for(const item of next){
      expect(item.body).toBe(changed.slice(item.start,item.start+item.body.length));
      expect(item.body.length).toBeLessThanOrEqual(8000);
      coverage.fill(1,item.start,item.start+item.body.length);
    }
    expect(coverage.every(value=>value===1)).toBe(true);
  }
});

test('重复正文的规划有上限，旧分块删掉后不能误算成功',()=>{
  const body='可重复的资料。'.repeat(5000);
  const original=[...planCaptureBodies(body,[])];
  const next=[...planCaptureBodies(body,original.map(item=>item.body))];
  expect(next.length).toBeLessThanOrEqual(original.length+1);
  expect(next.every(item=>item.reused)).toBe(true);
  expect([...planCaptureBodies('全新正文',original.map(item=>item.body))]).toEqual([{body:'全新正文',start:0,reused:false}]);
});

test('实体专用契约保留出处、回链、状态、查重与主体归档，去掉媒体流程',()=>{
  const directory=locateIngestSkillsDir()!;
  const sources=['ingest/SKILL.md','_brain-filing-rules.md','conventions/quality.md'].map(path=>readFileSync(join(directory,path),'utf8'));
  const compact=compileCaptureContract(sources);
  expect(compact.length).toBeLessThan(readIngestContract().length/2);
  for(const rule of ['[Source:','Back-link all entities','Timeline merge','Notability Gate','PRIMARY SUBJECT','State sections','Source precedence'])expect(compact).toContain(rule);
  expect(compact).not.toContain('Videos & Podcasts');
  expect(compact).not.toContain('upload-raw <file>');
});

test('时间线候选只包含原文中的真实完整日期，不把月份补成一号',()=>{
  expect(sourceTimelineDates('2017年5月，2026-02，2026年2月30日。')).toEqual([]);
  expect(sourceTimelineDates('2026年1月9日确认，2026-01-09重复，2024年2月29日完成。')).toEqual(['2024-02-29','2026-01-09']);
  expect(sourceTimelineDates('1789年7月14日，0004-02-29，2400-02-29，2500-02-29。')).toEqual(['0004-02-29','1789-07-14','2400-02-29']);
});
