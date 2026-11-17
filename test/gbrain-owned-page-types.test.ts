/**
 * #5881 — foresights's own outputs use page types the bundled default pack
 * (gbrain-base-v2) declares. Pre-fix the drift phase and `foresights report`
 * stamped `type: report`, which base-v2 neither declares nor aliases, so
 * `schema lint --with-db` flagged foresights's own pages as
 * `stored_type_undeclared`; the meeting-ingestion skill named no type for
 * its transcript sidecar, and agents improvised undeclared ones.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseDrift } from '../src/core/cycle/drift.ts';
import { runReport } from '../src/commands/report.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import { classifyStoredType } from '../src/core/schema-pack/type-usage.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

const ROOT = join(import.meta.dir, '..');

async function basePackKind(type: string): Promise<string> {
  const pack = await loadResolvedPackByName('gbrain-base-v2');
  return classifyStoredType(type, pack.manifest).kind;
}

describe('#5881 gbrain-owned page types are declared by gbrain-base-v2', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('the drift phase report page', async () => {
    const page = await engine.putPage('people/erin-example', { title: 'Erin', type: 'person', compiled_truth: 'Erin' });
    await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Careful operator', kind: 'take', holder: 'brain', weight: 0.6 }]);
    await engine.addTimelineEntriesBatch([{ slug: 'people/erin-example', date: '2030-01-15', source: 'meeting', summary: 'Changed roles' }]);
    await engine.setConfig('dream.drift.enabled', 'true');
    await engine.setConfig('models.drift', 'anthropic:claude-sonnet-4-6');
    const r = await runPhaseDrift(engine, {
      dryRun: false,
      cycleDate: '2030-01-20',
      auditPath: join(tmpdir(), `drift-owned-type-${process.pid}.jsonl`),
      judge: async () => ({ drifted: true, confidence: 0.9, reasoning: 'moved' }),
    });
    expect(r.status).toBe('complete');
    const report = await engine.getPage('reports/drift-2030-01-20');
    expect(report).not.toBeNull();
    expect(await basePackKind(report!.type)).toBe('canonical');
    expect(report!.frontmatter?.report_type).toBe('drift');
  }, 30_000);

  test('`foresights report` page frontmatter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-report-type-'));
    const log = console.log;
    console.log = () => {};
    try {
      await runReport(['--type', 'maintenance', '--title', 'Maintenance', '--content', 'Swept 3 pages.', '--dir', dir]);
    } finally {
      console.log = log;
    }
    const reportDir = join(dir, 'reports', 'maintenance');
    const [file] = readdirSync(reportDir);
    const parsed = parseMarkdown(readFileSync(join(reportDir, file), 'utf8'), `reports/maintenance/${file}`);
    expect(await basePackKind(parsed.type)).toBe('canonical');
    expect(parsed.frontmatter.report_type).toBe('maintenance');
    rmSync(dir, { recursive: true, force: true });
  });

  test('skills name declared types for gbrain-owned pages', async () => {
    const meeting = readFileSync(join(ROOT, 'skills/meeting-ingestion/SKILL.md'), 'utf8');
    const sidecar = /sidecar[^\n]*\n?[^\n]*`type: ([a-z-]+)`/i.exec(meeting);
    expect(sidecar).not.toBeNull();
    expect(await basePackKind(sidecar![1])).toBe('canonical');
    const reports = readFileSync(join(ROOT, 'skills/reports/SKILL.md'), 'utf8');
    const reportType = /^\s*type: ([a-z-]+)/m.exec(reports);
    expect(await basePackKind(reportType![1])).toBe('canonical');
  });
});
