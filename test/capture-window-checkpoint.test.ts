import {expect,test} from 'bun:test';
import {mergeCaptureWindow} from '../src/product/tasks/capture-window.ts';
import type {PhaseResult} from '../src/core/cycle.ts';

test('同一任务跨窗口累计费用、Token 与结果，保留最后剩余数及旧窗口警告',()=>{
  const phase=(details:Record<string,unknown>):PhaseResult=>({phase:'capture_entities',status:'warn',duration_ms:100,summary:'本批结果',details});
  const prior=phase({input_tokens:10,output_tokens:5,cost_cny:.1,pages_processed:1,chunks_processed:1,written_slugs:['default:people/a'],unresolved_references:[{reason:'evidence'}],window_deferred:true});
  const current=phase({input_tokens:20,output_tokens:6,cost_cny:.2,pages_processed:2,chunks_processed:2,written_slugs:['default:people/a','default:people/b'],pages_remaining:0,stop_reason:'completed',window_deferred:false});
  current.status='ok';
  const result=mergeCaptureWindow(prior,current);
  expect(result.details.input_tokens).toBe(30);expect(result.details.output_tokens).toBe(11);expect(result.details.cost_cny).toBeCloseTo(.3);
  expect(result.details.written_slugs).toEqual(['default:people/a','default:people/b']);
  expect(result.details.pages_processed).toBe(3);expect(result.details.pages_remaining).toBe(0);
  expect(result.details.window_deferred).toBe(false);expect(result.status).toBe('warn');expect(result.duration_ms).toBe(200);
});
