/** Owned test child only. Payload comes from the synthetic disk-PGLite fixture. */
import {writeSync} from 'node:fs';
import {PGLiteEngine} from '../../src/core/pglite-engine.ts';
import {refreshWorktree,type RefreshBoundary} from '../../src/core/persistence/worktree-refresh.ts';
const p=JSON.parse(process.env.GBRAIN_TEST_CASE_CHILD!);
const e=new PGLiteEngine();await e.connect(p.database);
await refreshWorktree(e,p.source,{caseRecovery:p.preview,hooks:{boundary(point:RefreshBoundary){
 if(point===p.stage){writeSync(1,`CASE_CHILD_KILL ${point}\n`);process.kill(process.pid,'SIGKILL');}
}}});
throw new Error('Expected crash boundary was not reached');
