import {expect,test} from 'bun:test';
import {memoryPressure} from '../shared/memory-budget.ts';

test('资源充足时正常 2GB 工作集不被当作故障，预算随主机容量调整',()=>{
  const healthy=memoryPressure({bytes:2218*1024**2,totalBytes:32*1024**3,availableBytes:14*1024**3,commitHeadroomBytes:40*1024**3});
  expect(healthy.level).toBe('normal');expect(healthy.budgetBytes).toBe(8*1024**3);
  expect(memoryPressure({bytes:3*1024**3,totalBytes:8*1024**3,availableBytes:4*1024**3}).level).toBe('constrained');
});

test('软压力降低工作量，真正系统内存或提交余量耗尽才触发紧急保护',()=>{
  expect(memoryPressure({bytes:9*1024**3,totalBytes:32*1024**3,availableBytes:12*1024**3}).level).toBe('constrained');
  expect(memoryPressure({bytes:1*1024**3,totalBytes:32*1024**3,availableBytes:600*1024**2}).level).toBe('constrained');
  expect(memoryPressure({bytes:1*1024**3,totalBytes:32*1024**3,availableBytes:200*1024**2}).level).toBe('critical');
  expect(memoryPressure({bytes:1*1024**3,totalBytes:32*1024**3,availableBytes:12*1024**3,commitHeadroomBytes:200*1024**2}).level).toBe('critical');
});

test('物理内存充足但提交余量耗尽时，提示实际触发项和两项实测值',()=>{
  const pressure=memoryPressure({bytes:1024**3,totalBytes:32*1024**3,availableBytes:12*1024**3,commitHeadroomBytes:200*1024**2});
  expect(pressure.level).toBe('critical');
  expect(pressure.reason).toContain('系统提交余量不足 256MB');
  expect(pressure.reason).toContain('可用物理内存 12288 MB');
  expect(pressure.reason).toContain('提交余量 200 MB');
  expect(pressure.reason).toContain('虚拟内存');
  expect(pressure.reason).not.toContain('或提交');
});

test('物理内存耗尽和两项同时耗尽分别说明，真实零余量仍保护，256MB 边界不提前停止',()=>{
  const physical=memoryPressure({bytes:1024**3,availableBytes:0,commitHeadroomBytes:12*1024**3});
  expect(physical.level).toBe('critical');
  expect(physical.reason).toContain('系统可用物理内存不足 256MB');
  expect(physical.reason).toContain('可用物理内存 0 MB');
  expect(physical.reason).toContain('提交余量 12288 MB');
  const both=memoryPressure({bytes:1024**3,availableBytes:100*1024**2,commitHeadroomBytes:200*1024**2});
  expect(both.reason).toContain('系统可用物理内存和提交余量均不足 256MB');
  expect(memoryPressure({bytes:1024**3,availableBytes:256*1024**2,commitHeadroomBytes:256*1024**2}).level).toBe('constrained');
  expect(memoryPressure({bytes:1024**3,availableBytes:200*1024**2}).reason).not.toContain('提交余量');
});
