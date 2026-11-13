import {test, expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {assertPrivateSocketParent, listenPrivateHttp, closePrivateHttpSafely} from '../src/commands/serve-http-unix';

function fixture() {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'gbrain-uds-'));
  fs.chmodSync(root,0o700); return {root,socket:path.join(root,'mcp.sock'),clean:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function request(socketPath:string,headers:Record<string,string>={}) {
  return new Promise<{status:number,body:string}>((resolve,reject)=>{
    const req=http.request({socketPath,path:'/token',method:'POST',headers},res=>{
      let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body}));
    }); req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('timeout')));req.end();
  });
}

test.skipIf(process.platform === 'win32')('same app auth stays mandatory, one local IP rate bucket, private permissions, cleanup',async()=>{
 const f=fixture();const app=express();app.set('trust proxy','loopback');
 const seen:string[]=[];
 app.use((req,_res,next)=>{seen.push(req.ip!);next();});
 app.use(rateLimit({windowMs:60000,max:2,standardHeaders:true,legacyHeaders:false}));
 app.post('/token',(req,res)=>res.status(req.headers.authorization==='Bearer synthetic-only'?200:401).json({ok:req.headers.authorization==='Bearer synthetic-only'}));
 const s=await listenPrivateHttp(app,f.socket);
 try {
  expect(fs.statSync(f.socket).mode & 0o777).toBe(0o600);
  expect((await request(f.socket)).status).toBe(401);
  expect((await request(f.socket,{authorization:'Bearer synthetic-only','x-forwarded-for':'203.0.113.10'})).status).toBe(200);
  expect((await request(f.socket,{authorization:'Bearer synthetic-only','x-forwarded-for':'203.0.113.11'})).status).toBe(429);
  expect(seen).toEqual(['127.0.0.1','127.0.0.1','127.0.0.1']);
 }finally{await s.close();await s.close();expect(fs.existsSync(f.socket)).toBe(false);f.clean();}
});
test.skipIf(process.platform === 'win32')('refuses unsafe parents, relative path and preexisting file without removal',async()=>{
 const f=fixture();try{
 expect(()=>assertPrivateSocketParent('relative.sock')).toThrow();
 fs.chmodSync(f.root,0o755);expect(()=>assertPrivateSocketParent(f.socket)).toThrow();fs.chmodSync(f.root,0o700);
 fs.writeFileSync(f.socket,'preserve');await expect(listenPrivateHttp((_q,r)=>r.end(),f.socket)).rejects.toThrow('private_http_path_exists');
 expect(fs.readFileSync(f.socket,'utf8')).toBe('preserve');
 }finally{f.clean();}
});
test.skipIf(process.platform === 'win32')('refuses a symlink parent',()=>{const f=fixture();try{
 const real=path.join(f.root,'real');fs.mkdirSync(real,{mode:0o700});const link=path.join(f.root,'link');fs.symlinkSync(real,link);
 expect(()=>assertPrivateSocketParent(path.join(link,'mcp.sock'))).toThrow();
 }finally{f.clean();}});
test.skipIf(process.platform === 'win32')('rejects occupied socket without disturbing original listener',async()=>{const f=fixture();const a=await listenPrivateHttp((_q,r)=>r.end('original'),f.socket);try{
 await expect(listenPrivateHttp((_q,r)=>r.end('new'),f.socket)).rejects.toThrow();
 expect((await request(f.socket)).body).toBe('original');
 }finally{await a.close();f.clean();}});
test.skipIf(process.platform === 'win32')('close terminates active requests before resolving',async()=>{const f=fixture();let admitted!:()=>void;const entered=new Promise<void>(r=>admitted=r);const a=await listenPrivateHttp(()=>admitted(),f.socket);
 try{const pending=request(f.socket).catch(e=>({error:e.code??e.message}));await entered;await a.close();expect('error' in await pending).toBe(true);expect(a.server.listening).toBe(false);}
 finally{await a.close();f.clean();}});

test('optional socket close errors remain observable without blocking later cleanup',async()=>{
 const order:string[]=[];
 await closePrivateHttpSafely({close:async()=>{order.push('socket');throw new Error('private_http_close_timeout');}},()=>order.push('warning'));
 order.push('engine');order.push('ipc');
 expect(order).toEqual(['socket','warning','engine','ipc']);
 await closePrivateHttpSafely(null);
});

test.skipIf(process.platform !== 'win32')('rejects unsupported Windows transport explicitly', () => {
 expect(() => assertPrivateSocketParent(path.resolve('private.sock'))).toThrow('private_http_requires_absolute_unix_path');
});
