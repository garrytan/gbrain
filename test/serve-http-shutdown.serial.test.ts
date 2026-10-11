import {expect,test} from 'bun:test';
import {createServer,type ServerResponse} from 'node:http';
import type {BrainEngine} from '../src/core/engine.ts';
import {waitForHttpServerClose} from '../src/commands/serve-http.ts';

test('服务关闭先结束后台任务，关闭持续 HTTP 连接后释放数据库',async()=>{
 const order:string[]=[];
 let active:ServerResponse|undefined;
 const server=createServer((_request,response)=>{active=response;response.writeHead(200,{'content-type':'text/event-stream'});response.write('data: connected\n\n');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};
 const closed=waitForHttpServerClose(server,{disconnect:async()=>{order.push('database');}} as BrainEngine,async()=>{await Bun.sleep(10);order.push('tasks');});
 const response=await fetch(`http://127.0.0.1:${address.port}`);
 const reader=response.body!.getReader();await reader.read();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  process.emit('SIGTERM');
  await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('持续 HTTP 连接阻止正常关闭')),1000);})]);
  expect(order).toEqual(['tasks','database']);
  expect(server.listening).toBe(false);
 }finally{clearTimeout(timer);active?.destroy();server.closeAllConnections();await reader.cancel().catch(()=>{});await Promise.race([closed,Bun.sleep(1000)]);}
});

test('已完成的 keep-alive 请求不阻止服务关闭和数据库释放',async()=>{
 const server=createServer((_request,response)=>response.end('ok'));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};let disconnected=false;
 const closed=waitForHttpServerClose(server,{disconnect:async()=>{disconnected=true;}} as BrainEngine);
 const response=await fetch(`http://127.0.0.1:${address.port}`);expect(await response.text()).toBe('ok');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  process.emit('SIGTERM');
  await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('keep-alive 阻止正常关闭')),1000);})]);
  expect(disconnected).toBe(true);
 }finally{clearTimeout(timer);server.closeAllConnections();await Promise.race([closed,Bun.sleep(1000)]);}
});
