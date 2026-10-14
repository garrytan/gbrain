import { expect, test } from 'bun:test';
import { SidecarResourceMonitor, resourcePressure, readSidecarResources, parseWindowsResourceSample } from '../src/main/sidecar/resource-monitor.js';

const rawSample={bytes:100*1024**2,availableBytes:12*1024**3,commitLimitBytes:32*1024**3,committedBytes:16*1024**3,startedAt:new Date().toISOString()};
function parseSample(value:unknown){return parseWindowsResourceSample(JSON.stringify(value));}

test('内存余量在阈值附近波动时维持降速，持续恢复十五秒后只恢复一次',async()=>{
  const actions:string[]=[];let now=0;let available=500*1024**2;
  const monitor=new SidecarResourceMonitor(12345,async(_message,_sample,action)=>{actions.push(action);},{
    intervalMs:60000,now:()=>now,read:async()=>({bytes:100*1024**2,availableBytes:available,totalBytes:8*1024**3,commitHeadroomBytes:8*1024**3}),
  });
  try{
    await (monitor as any).tick();
    for(let index=0;index<10;index++){now+=1000;available=index%2?500*1024**2:3*1024**3;await (monitor as any).tick();}
    expect(actions).toEqual(['adjust']);
    available=3*1024**3;now+=1000;await (monitor as any).tick();
    now+=14999;await (monitor as any).tick();expect(actions).toEqual(['adjust']);
    now+=1;await (monitor as any).tick();expect(actions).toEqual(['adjust','adjust']);
    available=0;now+=1;await (monitor as any).tick();expect(actions.at(-1)).toBe('drain');
  }finally{monitor.stop();}
});

test('缺失或异常的 Windows 计数器不能作为零余量，真实零余量仍触发保护',()=>{
  for(const invalid of [
    {...rawSample,availableBytes:null},
    {...rawSample,commitLimitBytes:null},
    {...rawSample,committedBytes:null},
    {...rawSample,commitLimitBytes:0,committedBytes:0},
    {...rawSample,availableBytes:-1},
    {...rawSample,committedBytes:-1},
    {...rawSample,availableBytes:'0'},
    {...rawSample,bytes:null},
    {...rawSample,commitLimitBytes:undefined},
  ])expect(()=>parseSample(invalid)).toThrow('内存采样数据无效');
  expect(resourcePressure(parseSample(rawSample))).toBeNull();
  const exhausted=parseSample({...rawSample,committedBytes:rawSample.commitLimitBytes});
  expect(exhausted.commitHeadroomBytes).toBe(0);
  expect(resourcePressure(exhausted)).toContain('提交余量 0 MB');
  expect(resourcePressure(parseSample({...rawSample,availableBytes:0}))).toContain('可用物理内存 0 MB');
});

test('Windows 采样缺失只记录诊断，下一次真实提交耗尽才停止后台任务并保留普通服务',async()=>{
  let reads=0;let failures=0;const actions:string[]=[];const messages:string[]=[];
  const monitor=new SidecarResourceMonitor(12345,async(message,_sample,action)=>{actions.push(action);messages.push(message);},{
    intervalMs:10,read:async()=>parseSample(++reads===1?{...rawSample,committedBytes:null}:{...rawSample,committedBytes:rawSample.commitLimitBytes}),
    onError:()=>{failures++;},
  });
  try{monitor.start();await Bun.sleep(80);}finally{monitor.stop();}
  expect(failures).toBe(1);expect(actions).toEqual(['drain']);
  expect(messages[0]).toContain('系统提交余量不足 256MB');
  expect(messages[0]).toContain('可用物理内存 12288 MB');
});

test('当前 Windows 受控进程的真实采样包含有效物理和提交余量',async()=>{
  if(process.platform!=='win32')return;
  const sample=await readSidecarResources(process.pid);
  expect(sample).not.toBeNull();
  expect(sample!.bytes).toBeGreaterThan(0);
  expect(sample!.availableBytes).toBeGreaterThanOrEqual(0);
  expect(sample!.commitHeadroomBytes).toBeGreaterThanOrEqual(0);
  expect(sample!.totalBytes).toBeGreaterThan(0);
  expect(Number.isFinite(Date.parse(sample!.startedAt!))).toBe(true);
},15000);

test('受控进程正常退出后返回空采样，不误报为监控失败',async()=>{
  const child=Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdout:'ignore',stderr:'ignore'});
  await child.exited;
  expect(await readSidecarResources(child.pid)).toBeNull();
},10000);

test('使用提交内存识别换页风险，系统余量不足也停止，不只检查物理驻留内存',()=>{
  expect(resourcePressure({bytes:3*1024**3,totalBytes:8*1024**3,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3})).toContain('工作集');
  expect(resourcePressure({bytes:2218*1024**2,totalBytes:32*1024**3,availableBytes:14*1024**3,commitHeadroomBytes:40*1024**3})).toBeNull();
  expect(resourcePressure({bytes:100*1024**2,availableBytes:500*1024**2,commitHeadroomBytes:10*1024**3})).toContain('系统');
  expect(resourcePressure({bytes:100*1024**2,availableBytes:10*1024**3,commitHeadroomBytes:500*1024**2})).toContain('系统');
  expect(resourcePressure({bytes:100*1024**2,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3})).toBeNull();
});

test('监控请求不重叠，停止后迟到采样不能终止进程，只触发一次保护',async()=>{
  let release!:(value:any)=>void;let reads=0;let stops=0;
  const monitor=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
  monitor.start();await Bun.sleep(60);expect(reads).toBe(1);monitor.stop();
  release({bytes:5*1024**3,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3});
  await Bun.sleep(40);expect(stops).toBe(0);expect(reads).toBe(1);
  const active=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>({bytes:5*1024**3,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3})});
  active.start();await Bun.sleep(60);active.stop();expect(stops).toBe(1);
});

test('采样失败只记录诊断，不终止服务，创建时间改变时不触碰复用的 PID',async()=>{
  let failures=0;let stops=0;
  const failed=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>{failures++;throw new Error('模拟 WMI 不可用');}});
  failed.start();await Bun.sleep(100);failed.stop();expect(failures).toBeGreaterThanOrEqual(3);expect(stops).toBe(0);
  let reads=0;const time=new Date().toISOString();
  const reused=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>({bytes:++reads===1?100:5*1024**3,availableBytes:10*1024**3,startedAt:reads===1?time:new Date(Date.parse(time)+1000).toISOString()})});
  reused.start();await Bun.sleep(100);reused.stop();expect(reads).toBe(2);expect(stops).toBe(0);
});

test('软压力保持采样并在恢复后正常运行，只有连续真实耗尽 30 秒才紧急退出',async()=>{
  let pressure=true;let recoveryNow=0;const actions:string[]=[];
  const soft=new SidecarResourceMonitor(12345,async(_message,_sample,action)=>{actions.push(action);},{intervalMs:10,now:()=>recoveryNow+=15000,read:async()=>({bytes:pressure?9*1024**3:1*1024**3,totalBytes:32*1024**3,availableBytes:10*1024**3})});
  soft.start();await Bun.sleep(40);pressure=false;await Bun.sleep(40);soft.stop();
  expect(actions).toEqual(['adjust','adjust']);
  let now=0;actions.length=0;
  const critical=new SidecarResourceMonitor(12345,async(_message,_sample,action)=>{actions.push(action);},{intervalMs:10,now:()=>now+=15000,read:async()=>({bytes:1*1024**3,totalBytes:32*1024**3,availableBytes:100*1024**2})});
  critical.start();await Bun.sleep(80);critical.stop();expect(actions).toEqual(['drain','emergency']);
});
