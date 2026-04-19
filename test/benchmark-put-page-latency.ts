/**
 * put_page latency benchmark — does Step B's auto-timeline measurably slow writes?
 *
 * Seeds 10 target pages, then runs 200 put_page OPERATION calls (not
 * engine.putPage directly) with varied content: half carry 3 timeline
 * entries, half carry none. Records wall-clock latency of each call,
 * reports p50/p95/p99 + total timeline entries written.
 *
 * Run on this branch + on master; numbers are directly comparable since
 * PGLite is in-process and the only variable is the operation handler.
 *
 * Usage: bun run test/benchmark-put-page-latency.ts
 *        bun run test/benchmark-put-page-latency.ts --json
 */

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

const N_WRITES = 200;
const N_TARGETS = 10;

async function main() {
  const jsonMode = process.argv.includes('--json');

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed target pages so auto-link has something to resolve against
  for (let i = 0; i < N_TARGETS; i++) {
    await engine.putPage(`people/target-${i}`, {
      type: 'person',
      title: `Target ${i}`,
      compiled_truth: '',
      timeline: '',
      frontmatter: {},
    });
  }

  const ctx: OperationContext = {
    engine,
    config: { engine: 'pglite' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
  };

  const putOp = operationsByName['put_page'];
  if (!putOp) throw new Error('put_page operation not found');

  const latenciesMs: number[] = [];
  let timelineEntriesWritten = 0;

  for (let i = 0; i < N_WRITES; i++) {
    const hasTimeline = i % 2 === 0;
    const slug = `notes/bench-${i}`;
    const targetIdx = i % N_TARGETS;

    const body = [
      `---`,
      `type: concept`,
      `title: Bench ${i}`,
      `---`,
      ``,
      `Met with [Target ${targetIdx}](people/target-${targetIdx}) about scaling.`,
      ``,
      ...(hasTimeline ? [
        `## Timeline`,
        ``,
        `- **2026-03-01** | Kickoff`,
        `- **2026-03-15** | Draft shipped`,
        `- **2026-04-02** | Final review`,
      ] : []),
    ].join('\n');

    const t0 = performance.now();
    const result: any = await putOp.handler(ctx, { slug, content: body });
    const dt = performance.now() - t0;
    latenciesMs.push(dt);
    if (result?.auto_timeline?.created) {
      timelineEntriesWritten += result.auto_timeline.created;
    }
  }

  await engine.disconnect();

  latenciesMs.sort((a, b) => a - b);
  const p = (pct: number) => latenciesMs[Math.min(latenciesMs.length - 1, Math.floor(latenciesMs.length * pct))];
  const mean = latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length;

  const report = {
    n_writes: N_WRITES,
    n_targets: N_TARGETS,
    timeline_entries_written: timelineEntriesWritten,
    latency_ms: {
      mean: round(mean),
      p50: round(p(0.50)),
      p95: round(p(0.95)),
      p99: round(p(0.99)),
      max: round(latenciesMs[latenciesMs.length - 1]),
    },
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`put_page latency benchmark`);
    console.log(`  writes:                 ${report.n_writes}`);
    console.log(`  target pages seeded:    ${report.n_targets}`);
    console.log(`  timeline entries added: ${report.timeline_entries_written}`);
    console.log(`  mean:  ${report.latency_ms.mean} ms`);
    console.log(`  p50:   ${report.latency_ms.p50} ms`);
    console.log(`  p95:   ${report.latency_ms.p95} ms`);
    console.log(`  p99:   ${report.latency_ms.p99} ms`);
    console.log(`  max:   ${report.latency_ms.max} ms`);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
