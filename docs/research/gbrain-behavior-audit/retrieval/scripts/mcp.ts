// usage: bun mcp.ts <brainHome> <tool> '<json args>' [<tool> '<json>' ...]
import { spawn } from 'bun';
const [home, ...rest] = process.argv.slice(2);
const calls: [string, any][] = [];
for (let i = 0; i < rest.length; i += 2) calls.push([rest[i], JSON.parse(rest[i + 1])]);
const env: Record<string, string> = { ...process.env as any, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', TZ: 'UTC' };
for (const k of ['DATABASE_URL','GBRAIN_DATABASE_URL','OPENAI_API_KEY','OPENAI_API_KEY__OPEN_AI_KEY','ANTHROPIC_API_KEY','VOYAGE_API_KEY']) delete env[k];
const p = spawn(['/home/ubuntu/.bun/bin/bun', 'run', '/code/garrytan/gbrain/src/cli.ts', 'serve'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
let buf = ''; const waiters = new Map<number, (v: any) => void>();
(async () => { const dec = new TextDecoder(); for await (const c of p.stdout) { buf += dec.decode(c); let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)!(m); waiters.delete(m.id); } } catch {} } } })();
let id = 0;
function rpc(method: string, params: any) { const myId = ++id; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n'); p.stdin.flush(); return new Promise<any>(r => waiters.set(myId, r)); }
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audit', version: '0' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
for (const [tool, args] of calls) {
  const r = await rpc('tools/call', { name: tool, arguments: args });
  console.log(`=== ${tool} ${JSON.stringify(args)}`);
  console.log(JSON.stringify(r.result ?? r.error, null, 1));
}
p.kill(); process.exit(0);
