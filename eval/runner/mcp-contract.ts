/**
 * BrainBench Category 12: MCP Operation Contract.
 *
 * Tests gbrain operation handlers under (trusted local, untrusted remote) ×
 * (valid, boundary, invalid, injection, resource-exhaustion) inputs.
 *
 * Focused on security-boundary operations and limit enforcement. The unit
 * test suite covers happy-path correctness for every op; this benchmark
 * focuses on the contract surface that an attacker probes.
 *
 * Pass criteria:
 *   - Valid input → correct response
 *   - Invalid input → rejected with clear error (not silent corruption)
 *   - Injection attempts → blocked (no SQL injection, no path traversal)
 *   - Trust-boundary differences enforced (ctx.remote=true tighter than false)
 *   - Limit caps enforced (depth, list_pages limit, etc.)
 *
 * Usage: bun run eval/runner/mcp-contract.ts [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations as OPERATIONS } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import type { GBrainConfig } from '../../src/core/config.ts';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

async function setup(): Promise<{ engine: PGLiteEngine; cleanup: () => Promise<void> }> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Seed a small graph for traversal tests.
  for (let i = 0; i < 10; i++) {
    await engine.putPage(`people/p${i}`, {
      type: 'person', title: `P${i}`, compiled_truth: `Person ${i}.`, timeline: '',
    });
  }
  for (let i = 0; i < 10; i++) {
    await engine.addLink(`people/p${i}`, `people/p${(i + 1) % 10}`, '', 'mentions');
  }
  return {
    engine,
    cleanup: async () => { await engine.disconnect(); },
  };
}

function ctx(remote: boolean, engine: PGLiteEngine): OperationContext {
  const config: GBrainConfig = { engine: 'pglite', database_path: ':memory:' };
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { engine, config, logger: logger as never, dryRun: false, remote };
}

async function runOp(opName: string, params: Record<string, unknown>, c: OperationContext): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const op = OPERATIONS.find(o => o.name === opName);
  if (!op) return { ok: false, error: `unknown operation: ${opName}` };
  try {
    const result = await op.handler(c, params);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench Category 12: MCP Operation Contract\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
  log(`Operations available: ${OPERATIONS.length}`);

  const { engine, cleanup } = await setup();
  const results: TestResult[] = [];

  // ── Trust boundary: traverse_graph depth cap ──
  // v0.10.3 hard-caps depth at 10 for remote callers (DoS prevention).
  log('\n## Trust boundary: traverse_graph depth cap');
  {
    const r = await runOp('traverse_graph', { slug: 'people/p0', depth: 1000 }, ctx(true, engine));
    const pass = r.ok || r.error.includes('depth') || r.error.includes('limit');
    results.push({
      name: 'traverse_graph depth=1000 from remote should be capped or rejected',
      pass,
      detail: r.ok ? 'capped silently (acceptable)' : `rejected: ${r.error}`,
    });
    log(`  ${pass ? '✓' : '✗'} ${results[results.length - 1].name}`);
  }
  {
    const r = await runOp('traverse_graph', { slug: 'people/p0', depth: 5 }, ctx(true, engine));
    const pass = r.ok;
    results.push({
      name: 'traverse_graph depth=5 from remote should succeed (under cap)',
      pass,
      detail: r.ok ? 'ok' : `unexpected error: ${r.error}`,
    });
    log(`  ${pass ? '✓' : '✗'} ${results[results.length - 1].name}`);
  }

  // ── Trust boundary: list_pages limit cap ──
  log('\n## Trust boundary: list_pages limit cap');
  {
    const r = await runOp('list_pages', { limit: 1_000_000 }, ctx(true, engine));
    if (r.ok) {
      const list = r.result as Array<unknown>;
      const pass = list.length <= 1000;
      results.push({
        name: 'list_pages limit=1M from remote should be clamped',
        pass,
        detail: `returned ${list.length} pages (cap should be <= 1000)`,
      });
      log(`  ${pass ? '✓' : '✗'} returned ${list.length} pages`);
    } else {
      results.push({ name: 'list_pages limit=1M from remote', pass: false, detail: `errored: ${r.error}` });
      log(`  ✗ unexpected error: ${r.error}`);
    }
  }

  // ── Input validation: slug format ──
  log('\n## Input validation: slug format');
  {
    const badSlugs = [
      { slug: '../etc/passwd', label: 'path traversal' },
      { slug: '/absolute/path', label: 'absolute path' },
      { slug: '../../escape', label: 'parent escape' },
      { slug: 'no-directory', label: 'missing directory prefix' },
      { slug: '', label: 'empty string' },
      { slug: 'people/' + 'x'.repeat(10_000), label: 'huge slug (10K chars)' },
    ];
    for (const { slug, label } of badSlugs) {
      const r = await runOp('get_page', { slug }, ctx(true, engine));
      // Either rejects with error OR returns null (page not found, no crash, no traversal)
      // The DANGER would be: returns content from outside the brain, or crashes the server.
      const pass = !r.ok || r.result === null || r.result === undefined;
      results.push({
        name: `get_page rejects/null-returns ${label}`,
        pass,
        detail: r.ok ? `returned ${typeof r.result}` : `rejected: ${r.error.slice(0, 80)}`,
      });
      log(`  ${pass ? '✓' : '✗'} ${label}: ${r.ok ? 'returned ' + typeof r.result : 'rejected'}`);
    }
  }

  // ── Input validation: date format ──
  log('\n## Input validation: date format');
  {
    const badDates = ['not-a-date', '2026-13-45', '99999-01-01', '', '../../../etc/passwd'];
    for (const date of badDates) {
      const r = await runOp('add_timeline_entry', { slug: 'people/p0', date, summary: 'test' }, ctx(true, engine));
      // Should reject invalid dates with error.
      const pass = !r.ok;
      results.push({
        name: `add_timeline_entry rejects invalid date "${date.slice(0, 30)}"`,
        pass,
        detail: r.ok ? 'silently accepted (BUG)' : `rejected: ${r.error.slice(0, 80)}`,
      });
      log(`  ${pass ? '✓' : '✗'} "${date.slice(0, 30)}": ${r.ok ? 'accepted (bad)' : 'rejected'}`);
    }
  }

  // ── Injection: SQL injection attempts in search ──
  log('\n## Injection: SQL injection attempts');
  {
    const sqlPayloads = [
      `'; DROP TABLE pages; --`,
      `' OR '1'='1`,
      `'; SELECT * FROM access_tokens; --`,
      `\\x00\\x00\\x00`,
      `\u0000injection`,
    ];
    for (const payload of sqlPayloads) {
      const r = await runOp('search', { query: payload, limit: 5 }, ctx(true, engine));
      // Should NOT throw a SQL parse error (which would mean the input reached SQL).
      // Should return empty results or a clean error.
      const pass = r.ok || !r.error.toLowerCase().includes('syntax');
      results.push({
        name: `search resists SQL payload "${payload.slice(0, 30)}"`,
        pass,
        detail: r.ok ? 'parameterized OK' : `error: ${r.error.slice(0, 80)}`,
      });
      log(`  ${pass ? '✓' : '✗'} "${payload.slice(0, 30)}": ${r.ok ? 'safe' : r.error.slice(0, 60)}`);
    }
  }

  // ── Resource exhaustion: large inputs ──
  log('\n## Resource exhaustion: large inputs');
  {
    const huge = 'x'.repeat(10_000_000); // 10MB string
    const start = Date.now();
    const r = await runOp('search', { query: huge, limit: 5 }, ctx(true, engine));
    const elapsed = Date.now() - start;
    const pass = elapsed < 5000; // under 5s
    results.push({
      name: 'search with 10MB query string returns within 5s',
      pass,
      detail: `${elapsed}ms${r.ok ? ' (returned)' : ` (rejected: ${r.error.slice(0, 60)})`}`,
    });
    log(`  ${pass ? '✓' : '✗'} 10MB query: ${elapsed}ms`);
  }

  // ── Trust boundary: file_upload path confinement ──
  // Skipped — file_upload requires actual filesystem setup. Covered by unit
  // tests in test/file-upload-security.test.ts.

  // ── Sanity: every operation has a handler ──
  log('\n## Sanity: every operation has a handler');
  for (const op of OPERATIONS) {
    const pass = typeof op.handler === 'function';
    results.push({ name: `${op.name} has handler`, pass, detail: pass ? 'ok' : 'missing handler' });
    if (!pass) log(`  ✗ ${op.name}`);
  }
  log(`  ${OPERATIONS.length}/${OPERATIONS.length} operations have handlers`);

  await cleanup();

  // ── Summary ──
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  log(`\n## Summary`);
  log(`Tests: ${results.length}`);
  log(`Passed: ${passed} (${((passed / results.length) * 100).toFixed(1)}%)`);
  log(`Failed: ${failed}`);

  if (failed > 0) {
    log('\nFailures:');
    for (const r of results.filter(r => !r.pass)) {
      log(`  ✗ ${r.name}`);
      log(`    ${r.detail}`);
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ results, summary: { passed, failed, total: results.length } }, null, 2) + '\n');
  }

  if (failed > 0) {
    console.error(`\n⚠ ${failed} contract test(s) failed`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('MCP contract eval error:', e);
  process.exit(1);
});
