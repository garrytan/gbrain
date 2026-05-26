/**
 * Tests for the v0.42.0.0 doctor `orphan_ratio` check (D5/D11).
 *
 * Local-surface tests run against the same runDoctor path as the CLI.
 * Thin-client-surface tests exercise `runOrphanRatioCheck` from
 * doctor-remote.ts with a stubbed callRemoteTool (no real MCP server
 * needed for unit coverage; the cross-surface parity contract is the
 * shared op + shared math, pinned via the source-grep regression at
 * the bottom of this file).
 *
 * Hermetic PGLite for the local-surface path.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDoctor, type DoctorReport } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { runOrphanRatioCheck } from '../src/core/doctor-remote.ts';
import { readFileSync } from 'fs';

let engine: PGLiteEngine;
let stdoutBuffer: string[];
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;

function captureCli(): void {
  stdoutBuffer = [];
  console.log = (msg?: unknown) => { stdoutBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
}

function restoreCli(): void {
  console.log = origLog;
  console.error = origErr;
  (process as { exit: unknown }).exit = origExit;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
});

async function runDoctorJson(): Promise<DoctorReport> {
  captureCli();
  try {
    // DON'T pass --fast — orphan_ratio is in the DB-checks group that
    // --fast skips. Tests need the full check set to verify the new
    // check fires.
    await runDoctor(engine, ['--json']);
  } catch (e) {
    if (!(e instanceof Error && e.message === '__exit')) throw e;
  } finally {
    restoreCli();
  }
  // Doctor --json writes the report as ONE big JSON string to stdout.
  // Take the last log entry that parses as a DoctorReport-shape object.
  for (let i = stdoutBuffer.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutBuffer[i]!);
      if (parsed && typeof parsed === 'object' && 'checks' in parsed) {
        return parsed as DoctorReport;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error('No DoctorReport JSON found in stdout');
}

function findCheck(report: DoctorReport, name: string) {
  return report.checks.find(c => c.name === name);
}

describe('runDoctor — orphan_ratio check (local surface, D5)', () => {
  test('< 100 entity pages → vacuous status ok', async () => {
    // Seed only a handful of entity pages — vacuous gate fires.
    for (let i = 0; i < 5; i++) {
      await engine.putPage(`people/p${i}`, {
        type: 'person', title: `Person ${i}`, compiled_truth: 'b', timeline: '', frontmatter: {},
      });
    }
    const report = await runDoctorJson();
    const check = findCheck(report, 'orphan_ratio');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toMatch(/vacuous/i);
  });

  test('100+ entity pages with low orphan ratio → status ok', async () => {
    // Seed 100 entity pages with substantial inbound link coverage.
    for (let i = 0; i < 100; i++) {
      await engine.putPage(`people/person-${i}`, {
        type: 'person', title: `Person ${i}`, compiled_truth: 'b', timeline: '', frontmatter: {},
      });
    }
    // Link 80% of them to be non-orphans (1 inbound link each).
    await engine.putPage('writing/index', {
      type: 'note', title: 'Index', compiled_truth: 'index', timeline: '', frontmatter: {},
    });
    const links = [];
    for (let i = 0; i < 80; i++) {
      links.push({
        from_slug: 'writing/index',
        to_slug: `people/person-${i}`,
        link_type: 'mentions', link_source: 'markdown', context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'orphan_ratio');
    // 20 orphans / 100 linkable = 20% — under warn threshold (50%) → ok.
    expect(check!.status).toBe('ok');
    expect(check!.message).toMatch(/orphan ratio/i);
  });

  test('high orphan ratio (>0.5, <=0.8) → warn with fix-hint', async () => {
    for (let i = 0; i < 100; i++) {
      await engine.putPage(`companies/co-${i}`, {
        type: 'company', title: `Co ${i}`, compiled_truth: 'b', timeline: '', frontmatter: {},
      });
    }
    // Link only 30% of entities (70% orphan ratio).
    await engine.putPage('writing/index', {
      type: 'note', title: 'Index', compiled_truth: 'index', timeline: '', frontmatter: {},
    });
    const links = [];
    for (let i = 0; i < 30; i++) {
      links.push({
        from_slug: 'writing/index',
        to_slug: `companies/co-${i}`,
        link_type: 'mentions', link_source: 'markdown', context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'orphan_ratio');
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('gbrain extract links --by-mention');
  });

  test('very high orphan ratio (>0.8) → fail with urgency fix-hint', async () => {
    for (let i = 0; i < 100; i++) {
      await engine.putPage(`orgs/org-${i}`, {
        type: 'organization', title: `Org ${i}`, compiled_truth: 'b', timeline: '', frontmatter: {},
      });
    }
    // Link only 10% — 90% orphan ratio.
    await engine.putPage('writing/index', {
      type: 'note', title: 'Index', compiled_truth: 'i', timeline: '', frontmatter: {},
    });
    const links = [];
    for (let i = 0; i < 10; i++) {
      links.push({
        from_slug: 'writing/index',
        to_slug: `orgs/org-${i}`,
        link_type: 'mentions', link_source: 'markdown', context: '',
      });
    }
    await engine.addLinksBatch(links);
    const report = await runDoctorJson();
    const check = findCheck(report, 'orphan_ratio');
    expect(check!.status).toBe('fail');
    expect(check!.message).toContain('gbrain extract links --by-mention');
  });

  test('zero entity pages → vacuous status ok', async () => {
    const report = await runDoctorJson();
    const check = findCheck(report, 'orphan_ratio');
    expect(check!.status).toBe('ok');
  });

  test('JSON envelope shape — orphan_ratio appears in checks[]', async () => {
    const report = await runDoctorJson();
    expect(report.schema_version).toBe(2);
    expect(Array.isArray(report.checks)).toBe(true);
    const names = report.checks.map(c => c.name);
    expect(names).toContain('orphan_ratio');
  });
});

describe('runOrphanRatioCheck — thin-client surface (D11)', () => {
  // Stubbed callRemoteTool is hard to inject without `mock.module`,
  // which violates the test-isolation rule. Instead exercise the
  // network-failure branch (which catches the unconfigured-server case)
  // and pin the shape of the returned RemoteCheck.

  test('returns informational ok on network failure (unconfigured config)', async () => {
    const result = await runOrphanRatioCheck({
      // Missing remote_mcp → callRemoteTool will throw.
    } as any);
    expect(result.name).toBe('orphan_ratio');
    expect(result.status).toBe('ok');
    expect(result.message).toMatch(/could not query remote|informational/i);
  });
});

describe('cross-surface parity contract', () => {
  test('source greps: orphan_ratio check name appears in BOTH local doctor and remote doctor', () => {
    const doctor = readFileSync('src/commands/doctor.ts', 'utf8');
    const remote = readFileSync('src/core/doctor-remote.ts', 'utf8');
    expect(doctor.includes("name: 'orphan_ratio'")).toBe(true);
    expect(remote.includes("name: 'orphan_ratio'")).toBe(true);
  });

  test('source greps: both surfaces reference the same fix command', () => {
    const doctor = readFileSync('src/commands/doctor.ts', 'utf8');
    const remote = readFileSync('src/core/doctor-remote.ts', 'utf8');
    expect(doctor).toContain('gbrain extract links --by-mention');
    expect(remote).toContain('gbrain extract links --by-mention');
  });

  test('source greps: local hint is self-fix; thin-client hint points at operator', () => {
    const doctor = readFileSync('src/commands/doctor.ts', 'utf8');
    const remote = readFileSync('src/core/doctor-remote.ts', 'utf8');
    // Local hint: just the command (user can run it).
    expect(doctor).toContain('Run: gbrain extract links --by-mention');
    // Thin-client hint: ask the operator.
    expect(remote).toMatch(/Ask the brain operator/i);
  });
});
