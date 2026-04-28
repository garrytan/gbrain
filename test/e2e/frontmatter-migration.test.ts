/**
 * E2E: v0.22.4 frontmatter-guard migration end-to-end on PGLite.
 *
 * Closes plan item B14. Runs the v0_22_4 orchestrator against a real PGLite
 * brain with two registered sources and synthetic malformed brain pages on
 * disk. Asserts:
 *   - audit phase writes ~/.gbrain/migrations/v0.22.4-audit.json with the
 *     expected per-source counts.
 *   - emit-todo phase appends one entry per source-with-issues to
 *     ~/.gbrain/migrations/pending-host-work.jsonl, each pointing at
 *     skills/migrations/v0.22.4.md (dotted convention) with the exact
 *     gbrain frontmatter validate <source-path> --fix command.
 *   - The migration is audit-only — no fixture page is mutated during
 *     apply-migrations.
 *
 * Uses the __setTestEngineOverride() injection point on v0_22_4.ts (mirrors
 * the repair-jsonb test pattern). Bun's os.homedir() doesn't observe
 * process.env.HOME mutations mid-process, so we redirect via the explicit
 * test override rather than relying on env-var redirection of loadConfig().
 *
 * No DATABASE_URL needed; runs unconditionally in CI's Tier 1.
 *
 * Run: bun test test/e2e/frontmatter-migration.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { v0_22_4, __setTestEngineOverride } from '../../src/commands/migrations/v0_22_4.ts';

const fence = '---';

let workdir: string;
let tmpHome: string;
let brainRootA: string;
let brainRootB: string;
let engine: PGLiteEngine;
let originalHome: string | undefined;
const originalContents = new Map<string, string>();

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'fm-migration-e2e-'));
  tmpHome = join(workdir, 'home');
  brainRootA = join(workdir, 'brain-a');
  brainRootB = join(workdir, 'brain-b');
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(brainRootA, { recursive: true });
  mkdirSync(brainRootB, { recursive: true });
  mkdirSync(join(tmpHome, '.gbrain', 'migrations'), { recursive: true });

  // Seed fixture brain pages on disk. Source A has 2 broken pages
  // (NESTED_QUOTES + NULL_BYTES); source B has 1 broken page (NESTED_QUOTES)
  // plus 1 clean page.
  const aBrokenNested = `${fence}\ntype: person\ntitle: "Phil "Nick" Last"\n${fence}\n\nbody-a-nested`;
  const aBrokenNull = `${fence}\ntype: concept\ntitle: ok\n${fence}\n\nbody-a-null\x00drop`;
  const bBroken = `${fence}\ntype: company\ntitle: "Co "Inc" Name"\n${fence}\n\nbody-b`;
  const bClean = `${fence}\ntype: concept\ntitle: clean\n${fence}\n\nbody-b-clean`;

  const filesToTrack: Array<{ path: string; content: string }> = [
    { path: join(brainRootA, 'people', 'phil.md'), content: aBrokenNested },
    { path: join(brainRootA, 'concepts', 'foo.md'), content: aBrokenNull },
    { path: join(brainRootB, 'companies', 'co.md'), content: bBroken },
    { path: join(brainRootB, 'concepts', 'bar.md'), content: bClean },
  ];

  for (const f of filesToTrack) {
    mkdirSync(join(f.path, '..'), { recursive: true });
    writeFileSync(f.path, f.content);
    originalContents.set(f.path, f.content);
  }

  // Single in-memory PGLite for the whole test. We inject it into the
  // orchestrator via __setTestEngineOverride so phaseBAudit skips loadConfig.
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)`,
    ['alpha', brainRootA],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)`,
    ['beta', brainRootB],
  );
  __setTestEngineOverride(engine);

  // Redirect ~/.gbrain/migrations/ output. The orchestrator's gbrainDir()
  // helper reads process.env.HOME at call time, so the override takes
  // effect even though Bun's os.homedir() does not observe mid-process
  // mutations.
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterAll(async () => {
  __setTestEngineOverride(null);
  if (engine) await engine.disconnect();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(workdir, { recursive: true, force: true });
});

describe('E2E: v0.22.4 frontmatter-guard migration', () => {
  test('orchestrator runs end-to-end and produces the expected artifacts', async () => {
    const result = await v0_22_4.orchestrator({
      yes: true,
      dryRun: false,
      noAutopilotInstall: true,
    });

    expect(result.version).toBe('0.22.4');
    expect(['complete', 'partial']).toContain(result.status);
    expect(result.phases.length).toBe(3);
    const auditPhase = result.phases.find((p) => p.name === 'audit')!;
    expect(auditPhase.status).toBe('complete');
    const emitPhase = result.phases.find((p) => p.name === 'emit-todo')!;
    expect(emitPhase.status).toBe('complete');
    expect(result.pending_host_work).toBe(2);
  });

  test('audit JSON report exists and has per-source counts', () => {
    const reportPath = join(tmpHome, '.gbrain', 'migrations', 'v0.22.4-audit.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));

    expect(report.ok).toBe(false);
    expect(report.total).toBeGreaterThan(0);
    expect(report.scanned_at).toMatch(/\d{4}-\d{2}-\d{2}T/);

    const alpha = report.per_source.find((s: any) => s.source_id === 'alpha');
    const beta = report.per_source.find((s: any) => s.source_id === 'beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // Source A has NESTED_QUOTES (in phil.md) and NULL_BYTES (in foo.md).
    // YAML_PARSE may also fire on the nested-quote page since gray-matter
    // throws — assert each expected code shows up at least once.
    expect(alpha.errors_by_code.NESTED_QUOTES).toBeGreaterThanOrEqual(1);
    expect(alpha.errors_by_code.NULL_BYTES).toBeGreaterThanOrEqual(1);
    expect(alpha.total).toBeGreaterThanOrEqual(2);
    expect(beta.errors_by_code.NESTED_QUOTES).toBeGreaterThanOrEqual(1);
    expect(beta.total).toBeGreaterThanOrEqual(1);

    // Sample lists carry the affected file paths for each source.
    expect(alpha.sample.some((s: any) => s.path.includes('phil.md'))).toBe(true);
    expect(beta.sample.some((s: any) => s.path.includes('co.md'))).toBe(true);
  });

  test('pending-host-work.jsonl carries one entry per source-with-issues', () => {
    const jsonlPath = join(tmpHome, '.gbrain', 'migrations', 'pending-host-work.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);

    const entries = lines.map((l) => JSON.parse(l));
    const ids = entries.map((e: any) => e.source_id).sort();
    expect(ids).toEqual(['alpha', 'beta']);

    for (const e of entries) {
      expect(e.migration).toBe('0.22.4');
      // Dotted-filename convention: the skill pointer matches the user-facing
      // migration doc at skills/migrations/v0.22.4.md, NOT the underscored
      // TS module path.
      expect(e.skill).toBe('skills/migrations/v0.22.4.md');
      expect(e.command).toContain('gbrain frontmatter validate');
      expect(e.command).toContain('--fix');
      expect(e.command).toContain(e.source_path);
    }
  });

  test('audit phase did NOT mutate any fixture brain page (audit-only contract)', () => {
    for (const [path, original] of originalContents) {
      expect(readFileSync(path, 'utf8')).toBe(original);
      // Nor should there be a .bak — the migration never invokes writeBrainPage.
      expect(existsSync(path + '.bak')).toBe(false);
    }
  });

  test('orchestrator is idempotent — re-running does not duplicate JSONL entries', async () => {
    await v0_22_4.orchestrator({
      yes: true,
      dryRun: false,
      noAutopilotInstall: true,
    });
    const jsonlPath = join(tmpHome, '.gbrain', 'migrations', 'pending-host-work.jsonl');
    const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
  });
});
