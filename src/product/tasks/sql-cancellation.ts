import type { BrainEngine } from '../../core/engine.ts';
import { databaseRequestContext } from '../database/request-context.ts';

export function withSqlCancellation(engine:BrainEngine,signal:AbortSignal):BrainEngine {
  if(engine.kind!=='postgres')return engine;
  const wrapped=new WeakMap<object,any>();
  const track=(pending:any)=>{
    if(typeof pending?.cancel!=='function')return pending;
    const cancel=()=>{try{void Promise.resolve(pending.cancel()).catch(()=>{});}catch{}};
    const context=databaseRequestContext();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let started=false;
    const start=()=>{
      if(started)return;started=true;
      if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
      if(context){timer=setTimeout(()=>{cancel();context.onTimeout(new Error(`数据库请求超时：Postgres SQL，${context.timeoutMs??60000} 毫秒内未完成`));},context.timeoutMs??60000);timer.unref();}
    };
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);};
    return new Proxy(pending,{get(target,key){
      if(['then','catch','finally'].includes(String(key)))return (...args:unknown[])=>{
        start();return target[key](...args).finally(finish);
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  };
  const sql=(connection:any):any=>{
    if(wrapped.has(connection))return wrapped.get(connection);
    const proxy=new Proxy(connection,{
      apply(target,_this,args){return track(Reflect.apply(target,target,args));},
      get(target,key){
        const value=Reflect.get(target,key);
        if(key==='unsafe')return (...args:unknown[])=>track(value.apply(target,args));
        if(key==='begin')return (...args:any[])=>{
          const callback=args.at(-1);
          return value.apply(target,[...args.slice(0,-1),(tx:any)=>callback(sql(tx))]);
        };
        if(key==='reserve')return async()=>sql(await value.call(target));
        return typeof value==='function'?value.bind(target):value;
      },
    });
    wrapped.set(connection,proxy);return proxy;
  };
  return new Proxy(engine,{get(target,key,receiver){
    if(key==='transaction')return (fn:(tx:BrainEngine)=>Promise<unknown>)=>target.transaction(tx=>fn(withSqlCancellation(tx,signal)));
    if(key==='sql')return sql(Reflect.get(target,key,target));
    if(key==='_sql'){
      const value=Reflect.get(target,key,target);
      const descriptor=Object.getOwnPropertyDescriptor(target,key);
      return value && descriptor?.writable!==false?sql(value):value;
    }
    return Reflect.get(target,key,receiver);
  }});
}
