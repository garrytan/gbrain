import { expect, test, spyOn } from 'bun:test';
import { MaintenanceWriteWait } from '../src/core/persistence/maintenance-wait.ts';
import * as concepts from '../src/core/cycle/synthesize-concepts.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';

test('concept wait is three minutes while unrelated maintenance keeps thirty seconds', () => {
  expect(concepts.CONCEPT_PUBLISH_WAIT_MS).toBe(180_000);
  expect(new MaintenanceWriteWait().ms()).toBe(30_000);
  expect(new MaintenanceWriteWait(null, Date.now, concepts.CONCEPT_PUBLISH_WAIT_MS).ms()).toBe(180_000);
});
test('a longer wait remains capped by the deadline and stops later waits after pending', () => {
  let now=1_000;
  const bounded=new MaintenanceWriteWait(46_000,()=>now,concepts.CONCEPT_PUBLISH_WAIT_MS);
  expect(bounded.ms()).toBe(45_000);now=46_001;expect(bounded.ms()).toBe(0);
  const wait=new MaintenanceWriteWait(null,Date.now,concepts.CONCEPT_PUBLISH_WAIT_MS);
  wait.observe({state:'committed'} as WriteRequest);expect(wait.ms()).toBe(180_000);
  wait.observe({state:'running'} as WriteRequest);expect(wait.ms()).toBe(0);
});
test('invalid waits cannot create unbounded publication work', () => {
  for(const ms of [0,-1,NaN,Infinity,300_001,1.5])expect(()=>new MaintenanceWriteWait(null,Date.now,ms)).toThrow('maintenance_publish_wait_invalid');
});

import * as maintenance from '../src/core/persistence/prepared-maintenance.ts';
test('the actual phase installs the longer wait before any model work', async () => {
  const stopped=new Error('phase-preflight-observed');
  const preflight=spyOn(maintenance,'maintenancePreflight').mockRejectedValue(stopped);
  let chats=0;
  try {
    const engine={getConfig:async()=>null,executeRaw:async()=>[],readPageSnapshot:async()=>null} as never;
    const atoms=[0,1].map(i=>({slug:'atoms/wait-'+i,title:'Evidence '+i,body:'Evidence body',concept_refs:['bounded-wait']}));
    await expect(concepts.runPhaseSynthesizeConcepts(engine,{_atoms:atoms,_chat:(async()=>{chats++;throw new Error('unexpected-model');}) as never})).rejects.toBe(stopped);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(preflight.mock.calls[0]![3]).toEqual({publishWaitMs:180_000});
    expect(chats).toBe(0);
  } finally {preflight.mockRestore();}
});
