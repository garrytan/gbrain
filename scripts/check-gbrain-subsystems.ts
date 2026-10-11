import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

interface Entry {path:string;upstream_path:string;mode:string;sha256:string;upstream_sha256:string}
const root=resolve(import.meta.dir,'..');
const manifest=JSON.parse(readFileSync(resolve(root,'.upstream/gbrain-subsystems.json'),'utf8')) as {upstream:{commit:string};files:Entry[]};
const hash=(text:string)=>createHash('sha256').update(text.replace(/\r\n/g,'\n')).digest('hex');
const arg=process.argv.indexOf('--upstream');
const upstream=arg>=0?process.argv[arg+1]:undefined;
if(arg>=0&&!upstream)throw new Error('--upstream requires a checkout path');
const failures:string[]=[];
for(const entry of manifest.files){
  const path=resolve(root,entry.path);
  if(relative(root,path).startsWith('..'))throw new Error(`Invalid manifest path: ${entry.path}`);
  const local=hash(readFileSync(path,'utf8'));
  if(local!==entry.sha256)failures.push(`${entry.path}: refresh its recorded PMBrain adaptation after review`);
  if(entry.mode==='copied'&&local!==entry.upstream_sha256)failures.push(`${entry.path}: a copied module diverged from the upstream source`);
  if(upstream){
    const source=execFileSync('git',['-C',resolve(upstream),'show',`${manifest.upstream.commit}:${entry.upstream_path}`],{encoding:'utf8',maxBuffer:8*1024*1024});
    if(hash(source)!==entry.upstream_sha256)failures.push(`${entry.path}: pinned upstream source hash mismatch`);
  }
}
if(failures.length)throw new Error(failures.join('\n'));
console.log(`GBrain ${manifest.upstream.commit.slice(0,12)}: ${manifest.files.length} source mappings verified${upstream?' against the pinned upstream commit':''}.`);
