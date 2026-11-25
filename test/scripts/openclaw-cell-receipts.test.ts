import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import { loadReceiptDir } from '../../scripts/ci-executed-counts.ts';
import { buildManifest, junitMessages, passedFiles } from '../../scripts/ci-manifest.ts';

// GST-3837: the openclaw-skill-resolver matrix (e2e.yml) runs one lane and file
// per OpenClaw version. Each cell's receipts must carry their own identity, or
// the ledger keeps only the latest-started cell and a later pass hides an
// earlier failure in ci-manifest.json.
type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { strategy: { matrix: { openclaw: string[] } }; steps: Step[] };
const REPO = join(import.meta.dir, '../..');
const job = (load(readFileSync(join(REPO, '.github/workflows/e2e.yml'), 'utf8')) as { jobs: Record<string, Job> }).jobs['openclaw-skill-resolver']!;
const step = job.steps.find(s => s.run?.includes('scripts/run-with-receipt.sh'))!;
const versions = job.strategy.matrix.openclaw;
const cell = (value: string, version: string) => value.replace(/\$\{\{\s*matrix\.openclaw\s*\}\}/g, version);
const FILE = 'test/e2e/openclaw-skill-resolver-real.test.ts';
const SHA = 'a'.repeat(40);
const RUN = 4242;

describe('openclaw-skill-resolver matrix receipts (GST-3837)', () => {
  test('failing cells followed by a later passing cell stay separate manifest entries, each with its own failure message', () => {
    expect(versions.length).toBeGreaterThan(2);
    const fails = ['gateway timed out after 900 ms', 'empty prompt from the gateway'];
    const [, script, ...args] = step.run!.trim().split(/\s+/);
    expect(script).toBe('scripts/run-with-receipt.sh');
    expect(args).toContain(FILE);
    const root = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-cells-'));
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      mkdirSync(join(root, 'test/e2e'), { recursive: true });
      copyFileSync(join(REPO, 'scripts/run-with-receipt.sh'), join(root, 'scripts/run-with-receipt.sh'));
      copyFileSync(join(REPO, 'scripts/lib/test-env.sh'), join(root, 'scripts/lib/test-env.sh'));
      writeFileSync(join(root, FILE), `import { test, expect } from 'bun:test';
test('resolves a skill through the gateway', () => {
  expect(process.env.GBRAIN_TEST_RECEIPT_ARM).toBeUndefined();
  if (process.env.CELL_FAILS) throw new Error(process.env.CELL_FAILS);
});`);
      const receipts = join(root, 'receipts');
      versions.forEach((version, i) => {
        const env = Object.fromEntries(Object.entries(step.env ?? {}).filter(([k]) => k.startsWith('GBRAIN_TEST_RECEIPT_')).map(([k, v]) => [k, cell(v, version)]));
        const dir = join(receipts, `receipts-openclaw-skill-resolver-${version}`);
        const r = spawnSync('bash', [script!, ...args.map(a => a.replace(/^--timeout=\d+$/, '--timeout=60000'))], {
          cwd: root, encoding: 'utf8',
          env: { ...process.env, GBRAIN_NO_SNAPSHOT: '1', ...env, GBRAIN_TEST_RECEIPT_DIR: dir, GITHUB_SHA: SHA, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: '1', ...(fails[i] ? { CELL_FAILS: fails[i] } : {}) },
        });
        expect(r.status, r.stdout + r.stderr).toBe(fails[i] ? 1 : 0);
        const receipt = join(dir, 'openclaw-skill-resolver--real-gateway--primary.receipt');
        writeFileSync(receipt, readFileSync(receipt, 'utf8').replace(/^started=\d+$/m, `started=${100 + i}`));
      });
      const manifest = buildManifest(loadReceiptDir(receipts), { workflow: 'E2E Tests', event: 'schedule', sha: SHA, run_id: RUN, run_attempt: 1 }, undefined, junitMessages(receipts));
      expect(manifest.problems).toEqual([]);
      const entries = manifest.files.filter(f => f.file === FILE);
      expect(new Set(entries.map(f => f.arm)).size).toBe(versions.length);
      expect(entries.map(f => [f.arm, f.executed, f.failed]).sort()).toEqual(versions.map((v, i) => [`openclaw-${v}`, 1, fails[i] ? 1 : 0]).sort());
      expect(manifest.failures.map(f => [f.lane, f.file, f.arm, f.test, f.message?.includes(fails[versions.indexOf(f.arm.replace(/^openclaw-/, ''))]!)]).sort())
        .toEqual(fails.map((_, i) => ['openclaw-skill-resolver', FILE, `openclaw-${versions[i]}`, 'resolves a skill through the gateway', true]).sort());
      expect(passedFiles(manifest).has(FILE)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
