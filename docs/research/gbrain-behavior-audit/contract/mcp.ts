// usage: bun mcp.ts <HOME> '<json array of [tool, args]>'
import { spawn } from "child_process";
const H = process.argv[2];
const calls = JSON.parse(process.argv[3]);
const env: any = { ...process.env, HOME: H, GBRAIN_HOME: H, GBRAIN_SELF_UPGRADE_MODE: "off", GBRAIN_SKIP_STARTUP_HOOKS: "1", GBRAIN_SWEEP: "0", TZ: "UTC" };
for (const k of ["DATABASE_URL","GBRAIN_DATABASE_URL","OPENAI_API_KEY","OPENAI_API_KEY__OPEN_AI_KEY","ANTHROPIC_API_KEY","VOYAGE_API_KEY"]) delete env[k];
const p = spawn("/home/ubuntu/.bun/bin/bun", ["run", "/code/garrytan/gbrain/src/cli.ts", "serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const pending = new Map<number, (v: any) => void>();
let stderr = "";
p.stderr.on("data", d => { stderr += d; });
p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } } catch { console.log("NONJSON stdout:", line.slice(0, 200)); } } });
let id = 0;
function rpc(method: string, params: any): Promise<any> { const myid = ++id; return new Promise(r => { pending.set(myid, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myid, method, params }) + "\n"); }); }
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit", version: "1" } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
for (const [tool, args] of calls) {
  if (tool === "__list") { const r = await rpc("tools/list", {}); console.log(JSON.stringify(r.result.tools.map((t: any) => t.name))); continue; }
  if (tool === "__schema") { const r = await rpc("tools/list", {}); console.log(JSON.stringify(r.result.tools.find((t: any) => t.name === args), null, 1)); continue; }
  const r = await rpc("tools/call", { name: tool, arguments: args });
  console.log(`### ${tool} ${JSON.stringify(args)}`);
  if (r.error) console.log("RPC ERROR", JSON.stringify(r.error));
  else { console.log("isError=", r.result.isError); for (const c of r.result.content) console.log(c.type === "text" ? c.text.slice(0, +(process.env.MAXC || 2500)) : c); if (r.result._meta) console.log("_meta", JSON.stringify(r.result._meta).slice(0, 600)); }
}
p.kill(); if (process.env.SHOWERR) console.log("STDERR:", stderr.slice(0, 2000));
process.exit(0);
