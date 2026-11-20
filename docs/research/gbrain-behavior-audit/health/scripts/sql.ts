// usage: HOME=<h> GBRAIN_HOME=<h> bun sql.ts '<sql>'
import { createEngine } from '/code/garrytan/gbrain/src/core/engine-factory.ts';
const H = process.env.GBRAIN_HOME!;
const cfg: any = { engine: 'pglite', database_path: `${H}/.gbrain/brain.pglite` };
const e = await createEngine(cfg);
await e.connect(cfg);
for (const q of process.argv.slice(2)) { const r = await e.executeRaw(q, []); console.log(JSON.stringify(r)); }
await e.disconnect();
process.exit(0);
