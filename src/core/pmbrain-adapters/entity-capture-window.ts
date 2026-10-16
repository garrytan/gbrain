const MAX_WINDOW_BYTES=32*1024**2;
const writers=new WeakMap<object,Promise<void>>();

export class EntityCaptureWindowDeferred extends Error {
  constructor(){super('entity_capture_window_deferred');this.name='EntityCaptureWindowDeferred';}
}

export class CaptureAdmission {
  private active=0;
  private waiting:Array<{run:()=>void;reject:(reason:unknown)=>void;signal?:AbortSignal;abort:()=>void}>=[];
  constructor(private getConcurrency:()=>number){}
  acquire(signal?:AbortSignal):Promise<()=>void>{
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const entry={signal,reject,run:()=>{
        signal?.removeEventListener('abort',entry.abort);this.active++;
        let released=false;
        resolve(()=>{if(!released){released=true;this.active--;this.flush();}});
      },abort:()=>{
        this.waiting=this.waiting.filter(value=>value!==entry);
        reject(signal?.reason??new Error('实体识别已停止'));this.flush();
      }};
      signal?.addEventListener('abort',entry.abort,{once:true});
      this.waiting.push(entry);this.flush();
    });
  }
  private flush(){
    const limit=Math.max(1,Math.min(2,Math.floor(this.getConcurrency())||1));
    while(this.active<limit&&this.waiting.length)this.waiting.shift()!.run();
  }
}

export async function withCaptureWrite<T>(engine:object,signal:AbortSignal|undefined,work:()=>Promise<T>):Promise<T>{
  const prior=writers.get(engine)??Promise.resolve();
  let release!:()=>void;
  const current=new Promise<void>(resolve=>{release=resolve;});
  writers.set(engine,current);
  try{await prior;signal?.throwIfAborted();return await work();}
  finally{release();if(writers.get(engine)===current)writers.delete(engine);}
}

export async function runCaptureWindow<T>(items:T[],work:(item:T,slot:number)=>Promise<void>,options:{getConcurrency:()=>number;sizeOf:(item:T)=>number;shouldStop:()=>boolean;signal?:AbortSignal}):Promise<void>{
  const active=new Set<Promise<void>>(),slots=[0,1];
  let cursor=0,bytes=0,failure:unknown;
  while(cursor<items.length||active.size){
    if(options.signal?.aborted)failure??=options.signal.reason??new Error('实体识别已停止');
    if(!failure&&!options.shouldStop()){
      const limit=Math.max(1,Math.min(2,Math.floor(options.getConcurrency())||1));
      while(cursor<items.length&&active.size<limit&&!options.shouldStop()&&!options.signal?.aborted){
        const item=items[cursor]!,size=options.sizeOf(item);
        if(!Number.isFinite(size)||size<0||size>MAX_WINDOW_BYTES){failure=new Error('资源保护：实体识别单份资料超过 32MB 活动输入上限，原文和任务已保留');break;}
        if(bytes+size>MAX_WINDOW_BYTES)break;
        const slot=slots.shift()!;
        cursor++;bytes+=size;
        const running=(async()=>{await work(item,slot);})().catch(error=>{failure??=error;}).finally(()=>{active.delete(running);slots.push(slot);bytes-=size;});
        active.add(running);
      }
    }
    if(active.size)await Promise.race(active);
    else break;
  }
  if(options.signal?.aborted)failure??=options.signal.reason??new Error('实体识别已停止');
  if(failure)throw failure;
}
