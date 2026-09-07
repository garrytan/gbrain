/**
 * Tests for `doctorReportRemote()` — the focused thin-client doctor that
 * powers the run_doctor MCP op.
 *
 * Strategy: build a fresh PGLite engine + initSchema, run the report, assert
 * all 5 checks present + healthy. Uses the canonical PGLite test pattern
 * (beforeAll + afterAll, not beforeEach) per CLAUDE.md test-isolation rules.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { doctorReportRemote, computeDoctorReport, type DoctorReport, type Check } from '../src/commands/doctor.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let priorHome: string | undefined;

beforeAll(async () => {
  // v0.37.10.0: doctorReportRemote reads from ~/.gbrain audit files
  // (reranker_health, sync_failures, etc.). Without isolation, host state
  // leaks into the test and makes the assertion non-deterministic. Pin
  // GBRAIN_HOME to a tempdir so audit reads return empty.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-remote-'));
  priorHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpHome;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (priorHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('doctorReportRemote', () => {
  test('runs all 5 checks on a fresh PGLite brain', async () => {
    const report = await doctorReportRemote(engine);
    expect(report.schema_version).toBe(2);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    const names = report.checks.map(c => c.name);
    expect(names).toContain('connection');
    expect(names).toContain('schema_version');
    expect(names).toContain('brain_score');
    expect(names).toContain('sync_failures');
    expect(names).toContain('queue_health');
  });

  test('connection check passes against a healthy engine', async () => {
    const report = await doctorReportRemote(engine);
    const conn = report.checks.find(c => c.name === 'connection');
    expect(conn).toBeDefined();
    expect(conn!.status).toBe('ok');
    expect(conn!.message).toContain('Connected');
  });

  test('schema_version check shows the latest version', async () => {
    const report = await doctorReportRemote(engine);
    const sv = report.checks.find(c => c.name === 'schema_version');
    expect(sv).toBeDefined();
    // Fresh PGLite at LATEST_VERSION → status ok with "(latest)"
    expect(sv!.status).toBe('ok');
    expect(sv!.message.toLowerCase()).toContain('latest');
  });

  test('queue_health is informational on PGLite', async () => {
    const report = await doctorReportRemote(engine);
    const q = report.checks.find(c => c.name === 'queue_health');
    expect(q).toBeDefined();
    expect(q!.status).toBe('ok');
    // PGLite-specific message
    expect(q!.message).toContain('PGLite');
  });

  test('extract_atoms_backlog is on the remote surface: ok on a fresh brain, message never leaks GBRAIN_HOME (#4576)', async () => {
    const report = await doctorReportRemote(engine);
    const check = report.checks.find(c => c.name === 'extract_atoms_backlog');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('no pages awaiting atom extraction');
    // The thin-client message is read by remote callers — never a server path.
    expect(check!.message).not.toContain(tmpHome);
    expect(JSON.stringify(check!.details ?? {})).not.toContain(tmpHome);
    expect((check!.details as Record<string, unknown>).backlog).toBe(0);
  });

  test('full report on healthy brain is "healthy" status', async () => {
    const report = await doctorReportRemote(engine);
    expect(report.status).toMatch(/healthy|warnings/);
    expect(report.health_score).toBeGreaterThanOrEqual(70);
  });
});

describe('computeDoctorReport — score + status math', () => {
  function check(status: Check['status']): Check {
    return { name: `check-${status}`, status, message: '' };
  }

  test('all-ok → healthy + 100', () => {
    const r = computeDoctorReport([check('ok'), check('ok'), check('ok')]);
    expect(r.status).toBe('healthy');
    expect(r.health_score).toBe(100);
  });

  test('one warn → warnings + score - 5', () => {
    const r = computeDoctorReport([check('ok'), check('warn'), check('ok')]);
    expect(r.status).toBe('warnings');
    expect(r.health_score).toBe(95);
  });

  test('one fail → unhealthy + score - 20', () => {
    const r = computeDoctorReport([check('ok'), check('fail'), check('ok')]);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(80);
  });

  test('mix of fail + warn → unhealthy (fail dominates)', () => {
    const r = computeDoctorReport([check('warn'), check('fail'), check('warn')]);
    expect(r.status).toBe('unhealthy');
    expect(r.health_score).toBe(70);
  });

  test('score floor at 0', () => {
    const fails: Check[] = [];
    for (let i = 0; i < 10; i++) fails.push(check('fail'));
    const r = computeDoctorReport(fails);
    expect(r.health_score).toBe(0);
  });

  test('schema_version is always 2', () => {
    const r: DoctorReport = computeDoctorReport([check('ok')]);
    expect(r.schema_version).toBe(2);
  });
});

// #4592 — the thin-client doctor report is an admin-scope aggregate on the same
// trust boundary as get_stats/get_health: a source-scoped remote grant must not
// read the brain-wide page count back out of the `connection` check (the same
// subtraction leak, one op over). Seeded AFTER the fresh-brain suite above so
// those assertions keep their empty brain.
describe('doctorReportRemote — source scope (#4592)', () => {
  const SRCA = 'scopesrca';
  const SRCB = 'scopesrcb';
  const message = (r: DoctorReport, name: string) => r.checks.find(c => c.name === name)!.message;
  const put = (sourceId: string, slug: string) =>
    engine.putPage(slug, { title: slug, type: 'note', compiled_truth: `# ${slug}\n\nbody\n` }, { sourceId });

  beforeAll(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('${SRCA}', '${SRCA}'), ('${SRCB}', '${SRCB}') ON CONFLICT (id) DO NOTHING`,
    );
    await put(SRCA, 'notes/alpha');
    await put(SRCA, 'notes/beta');
    await put(SRCB, 'notes/gamma');
  });

  test('sourceIds confines the connection page count instead of reporting brain-wide', async () => {
    const report = await doctorReportRemote(engine, { sourceIds: [SRCA] });
    expect(message(report, 'connection')).toBe('Connected, 2 pages');
  });

  test('run_doctor threads a remote federated grant into the count', async () => {
    const ctx = {
      engine,
      remote: true,
      auth: { token: 't', clientId: 'c', scopes: ['admin'], allowedSources: [SRCB] },
    } as unknown as OperationContext;
    const report = await operationsByName.run_doctor.handler(ctx, {}) as DoctorReport;
    expect(message(report, 'connection')).toBe('Connected, 1 pages');
  });

  test('differential: mutating an EXCLUDED source moves nothing a scoped report shows', async () => {
    const before = await doctorReportRemote(engine, { sourceIds: [SRCA] });
    await put(SRCB, 'notes/delta');
    const after = await doctorReportRemote(engine, { sourceIds: [SRCA] });
    expect(message(after, 'connection')).toBe(message(before, 'connection'));
    expect(message(after, 'brain_score')).toBe(message(before, 'brain_score'));
  });

  test('extract_atoms_backlog / drift / orphan probes never name or count an excluded source (wave review)', async () => {
    // 12 eligible-but-unextracted pages in the EXCLUDED source: brain-wide the
    // backlog is >= 12 (and the drain hint may name the source); a caller
    // granted only SRCA must see a zero backlog and no trace of SRCB anywhere
    // in the report — details.backlog_by_source, messages, fix hints.
    const body = 'x'.repeat(600);
    for (let i = 0; i < 12; i++) {
      await engine.putPage(`articles/leak-${i}`, { title: `leak-${i}`, type: 'article', compiled_truth: body }, { sourceId: SRCB });
    }
    const wide = await doctorReportRemote(engine);
    const wideBacklog = wide.checks.find(c => c.name === 'extract_atoms_backlog')!;
    expect(Number((wideBacklog.details as { backlog: number }).backlog)).toBeGreaterThanOrEqual(12);

    const scoped = await doctorReportRemote(engine, { sourceIds: [SRCA] });
    const scopedBacklog = scoped.checks.find(c => c.name === 'extract_atoms_backlog')!;
    expect(Number((scopedBacklog.details as { backlog: number }).backlog)).toBe(0);
    expect(JSON.stringify(scoped)).not.toContain(SRCB);
  });
});
