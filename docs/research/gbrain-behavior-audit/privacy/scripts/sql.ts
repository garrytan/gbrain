// Usage: HOME=<brain home> GBRAIN_HOME=<same> bun sql.ts "<sql>"
import { loadConfig } from '/code/garrytan/gbrain/src/core/config.ts';
import { createEngine } from '/code/garrytan/gbrain/src/core/engine-factory.ts';
const cfg = loadConfig()!;
const engine = await createEngine(cfg as any);
await engine.connect(cfg as any);
try {
  const rows = await engine.executeRaw(process.argv[2]!, []);
  console.log(JSON.stringify(rows, null, 0));
} finally { await engine.disconnect(); }
