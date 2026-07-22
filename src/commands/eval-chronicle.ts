// v0.42.x — Life Chronicle (#2390) `gbrain eval chronicle` (Phase A.9).
// Deterministic, brings its own in-memory PGLite (no DB, no gateway), so the
// CI fixture gate runs anywhere. Exit 0 only on a perfect score.
import { PGLiteEngine } from '../core/pglite-engine.ts';
import { runChronicleEval } from '../eval/chronicle/harness.ts';

const HELP = `Usage: gbrain eval chronicle [--json]

Deterministic Life Chronicle (#2390) feature eval. Builds a synthetic month
corpus with a known gold chronology + a planted ontology supersession + a
planted conflict, then scores the chronicle layer on: day reconstruction
(intra-day order), last-seen exact date, ontology supersession + --asof
time-travel, contradiction surfacing, and source isolation.

Exit code 0 iff every task passes.
`;

export async function runEvalChronicle(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const json = args.includes('--json');
  const engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  try {
    const result = await runChronicleEval(engine);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stderr.write(
        `[eval chronicle] ${result.passed}/${result.total} tasks passed ` +
        `(score ${(result.score * 100).toFixed(0)}%)\n`,
      );
      for (const t of result.tasks) {
        process.stderr.write(`  ${t.passed ? 'PASS' : 'FAIL'} ${t.id} — ${t.detail}\n`);
      }
    }
    return result.score === 1 ? 0 : 1;
  } finally {
    await engine.disconnect();
  }
}
