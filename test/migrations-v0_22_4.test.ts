import { describe, expect, test } from 'bun:test';
import { v0_22_4 } from '../src/commands/migrations/v0_22_4.ts';
import { migrations, getMigration } from '../src/commands/migrations/index.ts';

describe('v0.22.4 migration (B11)', () => {
  test('exports a Migration with the right version', () => {
    expect(v0_22_4.version).toBe('0.22.4');
    expect(typeof v0_22_4.orchestrator).toBe('function');
  });

  test('registered in migrations array in order', () => {
    const versions = migrations.map(m => m.version);
    expect(versions).toContain('0.22.4');
    // v0.22.4 must come after v0.21.0 (semver order is the contract).
    expect(versions.indexOf('0.22.4')).toBeGreaterThan(versions.indexOf('0.21.0'));
  });

  test('getMigration("0.22.4") returns the same module', () => {
    const found = getMigration('0.22.4');
    expect(found).not.toBeNull();
    expect(found!.version).toBe('0.22.4');
  });

  test('featurePitch includes a non-trivial headline + description', () => {
    expect(v0_22_4.featurePitch.headline.length).toBeGreaterThan(20);
    expect(v0_22_4.featurePitch.description?.length ?? 0).toBeGreaterThan(50);
    expect(v0_22_4.featurePitch.headline.toLowerCase()).toContain('frontmatter');
  });

  test('dry-run orchestrator returns complete with all phases skipped', async () => {
    const result = await v0_22_4.orchestrator({
      yes: true,
      dryRun: true,
      noAutopilotInstall: true,
    });
    expect(result.version).toBe('0.22.4');
    expect(result.phases.length).toBe(3);
    for (const p of result.phases) {
      // schema/audit/emit-todo all return 'skipped' on dry-run.
      expect(['skipped', 'complete']).toContain(p.status);
    }
    // Phase A returns 'skipped' on dry-run; B and C also skip. So overall is complete.
    expect(['complete', 'partial']).toContain(result.status);
  });

  test('phaseASchema is a no-op (returns complete with the no-changes hint)', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_22_4.ts');
    const result = __testing.phaseASchema({ yes: true, dryRun: false, noAutopilotInstall: true });
    expect(result.name).toBe('schema');
    expect(result.status).toBe('complete');
    expect(result.detail).toContain('no schema changes');
  });

  test('exports paths used for audit + pending-host-work outputs', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_22_4.ts');
    expect(__testing.auditReportPath()).toMatch(/v0\.22\.4-audit\.json$/);
    expect(__testing.pendingHostWorkPath()).toMatch(/pending-host-work\.jsonl$/);
  });

  test('dotted migration filename references — emit-todo entries point at v0.22.4.md', async () => {
    // The runtime convention is dotted (v0.22.4.md), not underscored.
    // Source-grep guards the contract without spinning up a real audit.
    const fs = await import('fs');
    const src = fs.readFileSync('src/commands/migrations/v0_22_4.ts', 'utf8');
    expect(src).toContain("'skills/migrations/v0.22.4.md'");
    expect(src).not.toMatch(/skills\/migrations\/v0_22_4\.md/);
  });

  test('phaseCEmitTodo writes per-source entries with the right shape', async () => {
    const { __testing } = await import('../src/commands/migrations/v0_22_4.ts');
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-migration-test-'));
    const origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const fakeReport = {
        ok: false,
        total: 12,
        errors_by_code: { NESTED_QUOTES: 8, NULL_BYTES: 4 },
        per_source: [
          {
            source_id: 'wiki',
            source_path: '/tmp/fake-wiki',
            total: 8,
            errors_by_code: { NESTED_QUOTES: 8 },
            sample: [],
          },
          {
            source_id: 'archive',
            source_path: '/tmp/fake-archive',
            total: 4,
            errors_by_code: { NULL_BYTES: 4 },
            sample: [],
          },
          {
            source_id: 'clean-source',
            source_path: '/tmp/fake-clean',
            total: 0,
            errors_by_code: {},
            sample: [],
          },
        ],
        scanned_at: new Date().toISOString(),
      };
      const r = __testing.phaseCEmitTodo(
        { yes: true, dryRun: false, noAutopilotInstall: true },
        fakeReport,
      );
      expect(r.status).toBe('complete');
      const jsonl = fs.readFileSync(__testing.pendingHostWorkPath(), 'utf8');
      const lines = jsonl.split('\n').filter(Boolean);
      // Two sources had issues; clean-source should NOT produce an entry.
      expect(lines.length).toBe(2);
      const entries = lines.map(l => JSON.parse(l));
      const ids = entries.map(e => e.source_id).sort();
      expect(ids).toEqual(['archive', 'wiki']);
      // Idempotency: re-running emit doesn't duplicate.
      __testing.phaseCEmitTodo(
        { yes: true, dryRun: false, noAutopilotInstall: true },
        fakeReport,
      );
      const lines2 = fs.readFileSync(__testing.pendingHostWorkPath(), 'utf8').split('\n').filter(Boolean);
      expect(lines2.length).toBe(2);
      // Schema check on entries.
      for (const e of entries) {
        expect(e.migration).toBe('0.22.4');
        expect(e.skill).toBe('skills/migrations/v0.22.4.md');
        expect(e.command).toContain('gbrain frontmatter validate');
        expect(e.command).toContain('--fix');
      }
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
