/**
 * Tests for `gbrain graph-query` command.
 *
 * Validates direction (in/out/both) and link_type filters via the underlying
 * traversePaths engine method (which is exercised in pglite-engine.test.ts);
 * here we assert the CLI output renders correctly.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runGraphQuery } from '../src/commands/graph-query.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  return (async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: unknown) => {
      lines.push(String(msg));
    };
    try {
      await fn();
    } finally {
      console.log = orig;
    }
    return lines;
  })();
}

describe('graph-query command', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', timeline: '' });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', timeline: '' });
    await engine.putPage('people/carol', { type: 'person', title: 'Carol', compiled_truth: '', timeline: '' });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', timeline: '' });
    await engine.putPage('meetings/standup', { type: 'meeting', title: 'Standup', compiled_truth: '', timeline: '' });
    await engine.addLink('meetings/standup', 'people/alice', '', 'attended');
    await engine.addLink('meetings/standup', 'people/bob', '', 'attended');
    await engine.addLink('meetings/standup', 'people/carol', '', 'attended');
    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.addLink('people/bob', 'companies/acme', '', 'invested_in');
  });

  test('default direction (out) traverses outgoing edges', async () => {
    const lines = await captureStdout(async () => {
      await runGraphQuery(engine, ['meetings/standup', '--depth', '1']);
    });
    const joined = lines.join('\n');
    expect(joined).toContain('meetings/standup');
    expect(joined).toContain('people/alice');
    expect(joined).toContain('people/bob');
    expect(joined).toContain('people/carol');
    expect(joined).toContain('attended');
  });

  test('--type attended filter (per-edge)', async () => {
    const lines = await captureStdout(async () => {
      await runGraphQuery(engine, ['meetings/standup', '--type', 'attended', '--depth', '1']);
    });
    const joined = lines.join('\n');
    // All edges shown should be attended
    const edgeLines = lines.filter(l => l.includes('--'));
    expect(edgeLines.length).toBeGreaterThan(0);
    expect(edgeLines.every(l => l.includes('attended'))).toBe(true);
    expect(joined).toContain('people/alice');
  });

  test('--direction in: incoming edges', async () => {
    const lines = await captureStdout(async () => {
      await runGraphQuery(engine, ['companies/acme', '--direction', 'in', '--depth', '1']);
    });
    const joined = lines.join('\n');
    // Should show people who link TO acme
    expect(joined).toContain('companies/acme');
    expect(joined).toContain('people/alice');
    expect(joined).toContain('people/bob');
  });

  test('--type works_at --direction in: only works_at edges in', async () => {
    const lines = await captureStdout(async () => {
      await runGraphQuery(engine, ['companies/acme', '--type', 'works_at', '--direction', 'in', '--depth', '1']);
    });
    const joined = lines.join('\n');
    expect(joined).toContain('people/alice');
    // Bob is invested_in, not works_at — should not appear
    expect(joined).not.toContain('people/bob');
  });

  test('non-existent slug emits "no edges found"', async () => {
    const lines = await captureStdout(async () => {
      await runGraphQuery(engine, ['does/not-exist']);
    });
    const joined = lines.join('\n');
    expect(joined.toLowerCase()).toContain('no edges found');
  });
});
