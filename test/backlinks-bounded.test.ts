import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBacklinkGaps, findBacklinkGapsBounded } from '../src/commands/backlinks.ts';
import { runLintCore } from '../src/commands/lint.ts';

test('有界反向链接检查保留旧结果，正文缓存不超过预算，扫描期间可停止且不改资料', async () => {
  const root=mkdtempSync(join(tmpdir(),'bounded-backlinks-'));
  try {
    mkdirSync(join(root,'people'));mkdirSync(join(root,'meetings'));
    for(let i=0;i<40;i++){
      writeFileSync(join(root,'people',`person-${i}.md`),`# Person ${i}\n`+'正文'.repeat(1200));
      writeFileSync(join(root,'meetings',`meeting-${i}.md`),`# Meeting ${i}\n[Person](../people/person-${i}.md)\n`);
    }
    const before=readFileSync(join(root,'people','person-0.md'));
    let pages=0;let peak=0;
    const result=await findBacklinkGapsBounded(root,{cacheBytes:8192,onProgress:row=>{pages=row.processed;peak=Math.max(peak,row.cachedBytes);}});
    expect(result).toEqual(findBacklinkGaps(root));expect(result).toHaveLength(40);
    expect(pages).toBe(80);expect(peak).toBeLessThanOrEqual(8192);
    const abort=new AbortController();
    await expect(findBacklinkGapsBounded(root,{signal:abort.signal,onProgress:row=>{if(row.processed===3)abort.abort(new Error('停止扫描'));}})).rejects.toThrow('停止扫描');
    expect(readFileSync(join(root,'people','person-0.md'))).toEqual(before);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('lint 逐页让出执行机会，取消后不继续扫描或写入',async()=>{
  const root=mkdtempSync(join(tmpdir(),'bounded-lint-'));
  try{
    for(let i=0;i<100;i++)writeFileSync(join(root,`page-${i}.md`),'# 合成资料\n\n正文。');
    const abort=new AbortController();let ticked=false;
    const timer=setTimeout(()=>{ticked=true;abort.abort(new Error('取消检查'));},0);
    await expect(runLintCore({target:root,fix:false,dryRun:true,contentSanity:{},signal:abort.signal})).rejects.toThrow('取消检查');
    clearTimeout(timer);expect(ticked).toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
});
