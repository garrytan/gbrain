// #5449 harness worker: imports many large pages through PGLiteEngine.transaction
// (via importFromContent) into one long-lived PGLite store and appends one JSON
// progress line per committed page. The external supervisor owns wedge detection.
import { appendFileSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';

const [dataDir, progressPath, countArg, startArg, pageKbArg] = process.argv.slice(2);
const count = Number(countArg ?? 3000);
const start = Number(startArg ?? 0);
const pageKb = Number(pageKbArg ?? 40);
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-harness' } });
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: dataDir } as never);
await engine.initSchema();

const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
let seed = start + 1;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
function body(i: number): string {
  const out: string[] = [];
  let size = 0;
  while (size < pageKb * 1024) {
    const sentence = Array.from({ length: 12 }, () => `${words[rand() % words.length]}${rand() % 9973}`).join(' ') + '.';
    out.push(sentence); size += sentence.length + 1;
    if (out.length % 8 === 0) out.push('\n');
  }
  return `---\ntype: note\ntitle: Harness page ${i}\n---\n# Page ${i}\n\n${out.join(' ')}\n`;
}
async function walSinceRedo(): Promise<{ since_redo: number; lsn: string }> {
  const rows = await engine.executeRaw<{ since_redo: string; lsn: string }>(
    `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::text AS since_redo, pg_current_wal_lsn()::text AS lsn FROM pg_control_checkpoint()`);
  return { since_redo: Number(rows[0]!.since_redo), lsn: rows[0]!.lsn };
}
for (let i = start; i < start + count; i++) {
  const t0 = performance.now();
  await importFromContent(engine, `harness/page-${i}`, body(i), { noEmbed: true });
  const wal = await walSinceRedo();
  appendFileSync(progressPath, JSON.stringify({ i, ms: Math.round(performance.now() - t0), ...wal, at: Date.now() }) + '\n');
}
await engine.disconnect();
appendFileSync(progressPath, JSON.stringify({ done: true, at: Date.now() }) + '\n');
