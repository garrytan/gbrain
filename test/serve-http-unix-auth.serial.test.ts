import { test, expect } from 'bun:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine';
import { buildServeHttpApp } from '../src/commands/serve-http';
import { listenPrivateHttp } from '../src/commands/serve-http-unix';

test.skipIf(process.platform === 'win32')('real OAuth and MCP enforce the same identity over a private socket',async()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gbrain-uds-auth-'));fs.chmodSync(root,0o700);
 const socketPath=path.join(root,'mcp.sock');
 const oldHome=process.env.GBRAIN_HOME; process.env.GBRAIN_HOME=root;
 const engine=new PGLiteEngine();
 let listener: Awaited<ReturnType<typeof listenPrivateHttp>> | undefined;
 try {
 await engine.connect({});await engine.initSchema();
 const app=express();const built=await buildServeHttpApp(app,engine,{port:3131,tokenTtl:3600,enableDcr:false,publicUrl:'http://localhost:3131',surface:'full'});
 listener=await listenPrivateHttp(app,socketPath);
 const call=(route:string,body:string,headers:Record<string,string>={})=>new Promise<{status:number,body:string,headers:http.IncomingHttpHeaders}>((resolve,reject)=>{
  const req=http.request({socketPath,path:route,method:'POST',headers:{host:'localhost:3131','content-type':'application/json',...headers}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode!,body:text,headers:res.headers}));});req.setTimeout(5000,()=>req.destroy(new Error('timeout')));req.on('error',reject);req.end(body);
 });
  const denied=await call('/mcp',JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),{accept:'application/json, text/event-stream'});expect(denied.status).toBe(401);
  const login=await call('/admin/login',JSON.stringify({token:built.bootstrapToken}));expect(login.status).toBe(200);
  const cookie=login.headers['set-cookie']![0]!.split(';')[0]!;
  const registered=await call('/admin/api/register-client',JSON.stringify({name:'isolated-uds-fixture',scopes:'read write',grantTypes:['client_credentials']}),{cookie});expect(registered.status).toBe(200);
  const client=JSON.parse(registered.body);
  const token=await call('/token',new URLSearchParams({grant_type:'client_credentials',client_id:client.clientId,client_secret:client.clientSecret,scope:'read write'}).toString(),{'content-type':'application/x-www-form-urlencoded'});expect(token.status).toBe(200);
  const auth=JSON.parse(token.body);expect(auth.scope.split(' ').sort()).toEqual(['read','write']);
  const mcp=await call('/mcp',JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'whoami',arguments:{}}}),{authorization:'Bearer '+auth.access_token,accept:'application/json, text/event-stream'});expect(mcp.status).toBe(200);
  const line=mcp.body.split('\n').find(l=>l.startsWith('data:'));const rpc=JSON.parse(line?line.slice(5):mcp.body);expect(rpc.error).toBeUndefined();const who=JSON.parse(rpc.result.content[0].text);expect(who.client_id).toBe(client.clientId);expect(who.transport).toBe('oauth');expect(who.source_id).toBe('default');
  const invalid=await call('/token',new URLSearchParams({grant_type:'client_credentials',client_id:client.clientId,client_secret:'synthetic-wrong',scope:'read write'}).toString(),{'content-type':'application/x-www-form-urlencoded'});expect([400,401]).toContain(invalid.status);
 } finally {
  try { await listener?.close(); } finally {
   try { await engine.disconnect(); } finally {
    if(oldHome===undefined)delete process.env.GBRAIN_HOME;else process.env.GBRAIN_HOME=oldHome;
    fs.rmSync(root,{recursive:true,force:true});
   }
  }
 }
},60000);
