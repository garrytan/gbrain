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
