import { expect,test } from 'bun:test';
import { runCaptureWindow,withCaptureWrite,CaptureAdmission } from '../src/core/pmbrain-adapters/entity-capture-window.ts';

test('五百项工作只保留两个活动项，调低窗口后不再领取第二项',async()=>{
  let active=0,peak=0,limit=2,completed=0;
  await runCaptureWindow(Array.from({length:500},(_,i)=>i),async()=>{
    active++;peak=Math.max(peak,active);
    await Promise.resolve();completed++;active--;if(completed===2)limit=1;
  },{getConcurrency:()=>limit,sizeOf:()=>1024,shouldStop:()=>false});
  expect(peak).toBe(2);expect(completed).toBe(500);expect(active).toBe(0);
});

test('活动输入字节到上限时等待释放，错误和取消会等待已有工作退出',async()=>{
  let active=0,peak=0,completed=0;
  await runCaptureWindow([1,2,3,4],async()=>{active++;peak=Math.max(peak,active);await Bun.sleep(5);active--;completed++;},{getConcurrency:()=>2,sizeOf:()=>20*1024**2,shouldStop:()=>false});
  expect(peak).toBe(1);expect(completed).toBe(4);
  const abort=new AbortController();let started=0;
  await expect(runCaptureWindow([1,2,3,4],async()=>{started++;abort.abort(new Error('operator stop'));await Bun.sleep(5);},{getConcurrency:()=>2,sizeOf:()=>1,shouldStop:()=>false,signal:abort.signal})).rejects.toThrow('operator stop');
  expect(started).toBe(1);
});

test('两个请求共用一个提交通道，等待期间取消的写入不能执行',async()=>{
  const engine={};let active=0,peak=0,writes=0;
  await Promise.all([1,2].map(()=>withCaptureWrite(engine,undefined,async()=>{active++;peak=Math.max(peak,active);await Bun.sleep(10);writes++;active--;})));
  expect(peak).toBe(1);expect(writes).toBe(2);
  const abort=new AbortController();
  const first=withCaptureWrite(engine,undefined,async()=>{await Bun.sleep(10);abort.abort(new Error('stopped'));});
  const second=withCaptureWrite(engine,abort.signal,async()=>{writes++;});
  await first;await expect(second).rejects.toThrow('stopped');expect(writes).toBe(2);
});

test('压力到来后等待在途请求退出，余下长文分块也遵守单请求',async()=>{
  let limit=2,claimed=false;
  const admission=new CaptureAdmission(()=>limit);
  const first=await admission.acquire(),second=await admission.acquire();
  limit=1;first();
  const next=admission.acquire().then(release=>{claimed=true;return release;});
  await Promise.resolve();expect(claimed).toBe(false);
  second();const release=await next;expect(claimed).toBe(true);release();
});
